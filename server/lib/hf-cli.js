/**
 * Modelos que el MCP no expone (Cinema Studio 4.0, 3.5): se usan con la CLI
 * oficial del generador (@higgsfield/cli), con la misma cuenta y los mismos
 * creditos del plan.
 *
 * La sesion de la CLI (carpeta .config/higgsfield: credentials.json y
 * config.json con el workspace) ROTA su refresh token al renovarse, igual que
 * hf_token. Por eso vive en la base (tabla hf_cli_sesion) y no en un volumen:
 * la usan el panel (cotizar) y el worker (crear). Cada llamada toma la fila con
 * FOR UPDATE, escribe la carpeta en un directorio temporal, corre la CLI y
 * guarda de vuelta lo que la CLI haya renovado. Asi nunca hay dos copias vivas.
 *
 * La CLI inicia sesion por navegador contra localhost, asi que no se puede
 * reconectar desde el panel: la sesion se carga una vez (variable HF_CLI_SESION
 * o pegandola en Super Admin) y despues se renueva sola con el uso.
 */
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pool } = require('./db');

const CARPETA = path.join('.config', 'higgsfield');

class CliError extends Error {
  constructor(msg, { desconectado = false } = {}) {
    super(msg);
    this.desconectado = desconectado;
  }
}

function entrada() {
  if (process.env.HF_CLI_BIN) return process.env.HF_CLI_BIN; // pruebas: una CLI falsa
  try { return require.resolve('@higgsfield/cli/bin/higgsfield.js'); } catch { return null; }
}
const instalada = () => !!entrada();

// La sesion vencio, no existe o no tiene workspace: no es culpa del pedido.
const esErrorDeSesion = (t) => /not (logged|signed) in|not authenticated|no workspace selected|unauthori[sz]ed|unauthenticated|auth login|(session|token) (has )?expired|invalid (token|credentials|grant)|invalid_grant|\b401\b/i
  .test(String(t || ''));

// El JSON de la salida, aunque la CLI imprima avisos alrededor.
function parsear(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* hay texto alrededor */ }
  for (const [a, c] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(a); const f = t.lastIndexOf(c);
    if (i === -1 || f <= i) continue;
    try { return JSON.parse(t.slice(i, f + 1)); } catch { /* el otro */ }
  }
  return null;
}

// Paquete = base64 de {"archivos": {"credentials.json": base64, "config.json": base64}}
// (mismo formato que el menu digital: scripts/sesion-higgsfield.mjs).
function leerPaquete(paquete) {
  const crudo = Buffer.from(String(paquete || '').trim(), 'base64').toString('utf8');
  let archivos;
  try { archivos = JSON.parse(crudo).archivos; } catch { archivos = null; }
  if (!archivos || typeof archivos !== 'object') throw new CliError('El paquete de sesión no es válido.');
  const cred = archivos['credentials.json'] ? JSON.parse(Buffer.from(archivos['credentials.json'], 'base64').toString('utf8')) : null;
  if (!cred?.refresh_token) throw new CliError('El paquete no trae credentials.json con refresh_token.');
  for (const n of Object.keys(archivos)) if (n.includes('..') || path.isAbsolute(n)) throw new CliError('Nombre inválido en el paquete: ' + n);
  return archivos;
}

async function empaquetar(casa = os.homedir()) {
  const dir = path.join(casa, CARPETA);
  const archivos = {};
  for (const n of await fs.readdir(dir)) {
    const st = await fs.stat(path.join(dir, n));
    if (st.isFile()) archivos[n] = (await fs.readFile(path.join(dir, n))).toString('base64');
  }
  return Buffer.from(JSON.stringify({ archivos })).toString('base64');
}

async function guardarSesion(paquete, { por = 'sistema', cuenta = null } = {}) {
  const archivos = leerPaquete(paquete);
  await pool.query(
    `INSERT INTO hf_cli_sesion (id, archivos, cuenta, cargada_por, actualizado, ultimo_error)
     VALUES (1, $1, $2, $3, now(), NULL)
     ON CONFLICT (id) DO UPDATE SET archivos = EXCLUDED.archivos, cuenta = COALESCE(EXCLUDED.cuenta, hf_cli_sesion.cuenta),
       cargada_por = EXCLUDED.cargada_por, actualizado = now(), ultimo_error = NULL`,
    [JSON.stringify(archivos), cuenta, por]
  );
}

// Primera vez: la sesion llega por HF_CLI_SESION (solo si la tabla esta vacia).
async function sembrar() {
  const p = process.env.HF_CLI_SESION;
  if (!p) return false;
  const { rows } = await pool.query('SELECT 1 FROM hf_cli_sesion WHERE id = 1');
  if (rows.length) return false;
  await guardarSesion(p, { por: 'HF_CLI_SESION' });
  return true;
}

function correr(args, env, timeoutMs) {
  return new Promise((resolver, rechazar) => {
    const e = entrada();
    if (!e) return rechazar(new CliError('La CLI del generador no está instalada.'));
    // Sin shell: los prompts largos viajan enteros (con shell se cortaban en la primera linea).
    const hijo = spawn(process.execPath, [e, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = ''; let stderr = '';
    const t = setTimeout(() => { hijo.kill('SIGKILL'); rechazar(new CliError('La CLI no respondió a tiempo.')); }, timeoutMs);
    hijo.stdout.on('data', (d) => { stdout += d; });
    hijo.stderr.on('data', (d) => { stderr += d; });
    hijo.on('error', (err) => { clearTimeout(t); rechazar(err); });
    hijo.on('close', (codigo) => { clearTimeout(t); resolver({ codigo, stdout, stderr }); });
  });
}

// Corre la CLI con la sesion de la base y devuelve su JSON.
async function llamar(args, { timeoutMs = 90000 } = {}) {
  const c = await pool.connect();
  const casa = await fs.mkdtemp(path.join(os.tmpdir(), 'hfcli-'));
  try {
    await c.query('BEGIN');
    const { rows: [s] } = await c.query('SELECT archivos FROM hf_cli_sesion WHERE id = 1 FOR UPDATE');
    if (!s) throw new CliError('La sesión de la CLI no está cargada.', { desconectado: true });
    const dir = path.join(casa, CARPETA);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [n, b64] of Object.entries(s.archivos)) await fs.writeFile(path.join(dir, n), Buffer.from(b64, 'base64'), { mode: 0o600 });

    const env = { ...process.env, HOME: casa, XDG_CONFIG_HOME: path.join(casa, '.config'), HIGGSFIELD_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
    let r; let fallo = null;
    try { r = await correr([...args, '--json'], env, timeoutMs); } catch (e) { fallo = e; r = { codigo: -1, stdout: '', stderr: e.message }; }

    // Lo que la CLI haya renovado se guarda siempre, aunque el comando haya fallado
    // o se haya cortado: perderlo dejaria la sesion con un refresh token ya usado.
    const nuevos = {};
    for (const n of await fs.readdir(dir)) nuevos[n] = (await fs.readFile(path.join(dir, n))).toString('base64');
    const cambio = JSON.stringify(nuevos) !== JSON.stringify(s.archivos);
    const datos = fallo ? null : parsear(r.stdout);
    const ok = r.codigo === 0 && datos != null;
    const texto = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n').slice(0, 800);
    await c.query(
      `UPDATE hf_cli_sesion SET archivos = CASE WHEN $1 THEN $2::jsonb ELSE archivos END,
         actualizado = CASE WHEN $1 THEN now() ELSE actualizado END,
         ultimo_uso = now(), ultimo_error = $3 WHERE id = 1`,
      [cambio && Object.keys(nuevos).includes('credentials.json'), JSON.stringify(nuevos), ok ? null : texto || `código ${r.codigo}`]
    );
    await c.query('COMMIT');
    if (ok) return datos;
    if (fallo instanceof CliError) throw fallo;
    throw new CliError(`hf ${args.slice(0, 2).join(' ')}: ${texto || 'terminó con código ' + r.codigo}`, { desconectado: esErrorDeSesion(texto) });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    fs.rm(casa, { recursive: true, force: true }).catch(() => {});
  }
}

async function estado() {
  const { rows: [s] } = await pool.query('SELECT cuenta, cargada_por, actualizado, ultimo_uso, ultimo_error FROM hf_cli_sesion WHERE id = 1');
  return {
    instalada: instalada(), cargada: !!s, cuenta: s?.cuenta || null, cargadaPor: s?.cargada_por || null,
    actualizado: s?.actualizado || null, ultimoUso: s?.ultimo_uso || null,
    ultimoError: s?.ultimo_error || null, desconectada: !s || esErrorDeSesion(s?.ultimo_error),
  };
}

// Verifica la sesion (y de paso la renueva): cuenta, plan y creditos.
async function cuenta() {
  const d = await llamar(['account', 'status'], { timeoutMs: 60000 });
  if (d?.email) await pool.query('UPDATE hf_cli_sesion SET cuenta = $1 WHERE id = 1', [d.email]);
  return { email: d?.email || null, plan: d?.subscription_plan_type || null, creditos: d?.credits ?? null };
}

module.exports = { llamar, estado, cuenta, sembrar, guardarSesion, empaquetar, leerPaquete, parsear, esErrorDeSesion, instalada, CliError };
