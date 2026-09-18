/**
 * Cliente del MCP de Higgsfield (https://mcp.higgsfield.ai/mcp): JSON-RPC por
 * HTTP, sin sesion. Usa los creditos normales del plan de la cuenta autorizada.
 *
 * Token OAuth: dura ~24 h y el refresh token ROTA en cada renovacion. Panel y
 * worker comparten la fila hf_token; la renovacion se hace con SELECT ... FOR
 * UPDATE para que nunca renueven los dos a la vez (el segundo invalidaria al
 * primero y quedariamos desconectados).
 */
const { pool } = require('./db');

const MCP_URL = process.env.HF_MCP_URL || 'https://mcp.higgsfield.ai/mcp';
const TOKEN_URL = process.env.HF_TOKEN_URL || 'https://mcp.higgsfield.ai/oauth2/token';
const MARGEN_MS = 10 * 60 * 1000; // renovar si vence en menos de 10 min

class HiggsfieldError extends Error {
  constructor(msg, { desconectado = false, herramienta = null } = {}) {
    super(msg);
    this.desconectado = desconectado;
    this.herramienta = herramienta;
  }
}

function cuentaDe(idToken) {
  try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url')).email || null; } catch { return null; }
}

// Primer arranque: siembra el token desde variables de entorno (una sola vez).
async function sembrarToken() {
  const refresh = process.env.HF_REFRESH_TOKEN;
  const clientId = process.env.HF_CLIENT_ID;
  if (!refresh || !clientId) return false;
  const r = await pool.query(
    `INSERT INTO hf_token (id, client_id, refresh_token, expira_en) VALUES (1, $1, $2, to_timestamp(0))
     ON CONFLICT (id) DO NOTHING`,
    [clientId, refresh]
  );
  return r.rowCount > 0;
}

async function renovar(fila) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: fila.refresh_token,
      client_id: fila.client_id, resource: MCP_URL,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const detalle = j.error_description || j.error || ('HTTP ' + r.status);
    // invalid_grant = el refresh token ya no sirve: hay que volver a autorizar.
    throw new HiggsfieldError('No se pudo renovar el token de Higgsfield: ' + detalle,
      { desconectado: r.status === 400 || r.status === 401 });
  }
  return j;
}

async function accessToken({ forzar = false } = {}) {
  const { rows } = await pool.query('SELECT * FROM hf_token WHERE id = 1');
  const f = rows[0];
  if (!f) throw new HiggsfieldError('Higgsfield no esta conectado (falta el token).', { desconectado: true });
  if (!forzar && f.access_token && f.expira_en && f.expira_en.getTime() - Date.now() > MARGEN_MS) return f.access_token;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [g] } = await c.query('SELECT * FROM hf_token WHERE id = 1 FOR UPDATE');
    // Otro proceso pudo haberlo renovado mientras esperabamos el lock.
    if (g.access_token && g.expira_en && g.expira_en.getTime() - Date.now() > MARGEN_MS
        && (!forzar || g.access_token !== f.access_token)) {
      await c.query('COMMIT');
      return g.access_token;
    }
    let j;
    try {
      j = await renovar(g);
    } catch (e) {
      await c.query('UPDATE hf_token SET ultimo_error = $1 WHERE id = 1', [e.message]);
      await c.query('COMMIT');
      throw e;
    }
    await c.query(
      `UPDATE hf_token SET access_token = $1, refresh_token = $2, expira_en = $3, cuenta = COALESCE($4, cuenta),
         actualizado = now(), ultimo_error = NULL WHERE id = 1`,
      [j.access_token, j.refresh_token || g.refresh_token,
        new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000), j.id_token ? cuentaDe(j.id_token) : null]
    );
    await c.query('COMMIT');
    return j.access_token;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Respuesta JSON o SSE (text/event-stream) -> mensaje JSON-RPC con nuestro id.
function leerRespuesta(texto, tipo, id) {
  if ((tipo || '').includes('event-stream')) {
    const msgs = texto.split('\n').filter((l) => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
    return msgs.find((m) => m.id === id) || msgs.at(-1);
  }
  return JSON.parse(texto);
}

// Igual que el widget oficial: structuredContent, o el JSON del primer texto.
function datosDe(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const t = (result.content || []).find((c) => c.type === 'text');
  if (!t) return null;
  try { return JSON.parse(t.text); } catch { return { texto: t.text }; }
}

let _id = 0;
async function llamar(herramienta, args = {}, { timeoutMs = 60000 } = {}) {
  for (let intento = 0; intento < 2; intento++) {
    const token = await accessToken({ forzar: intento > 0 });
    const id = ++_id;
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: herramienta, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 401 && intento === 0) continue; // token revocado/vencido: renovar y reintentar
    const texto = await r.text();
    if (!r.ok) throw new HiggsfieldError(`${herramienta}: HTTP ${r.status} ${texto.slice(0, 200)}`, { herramienta, desconectado: r.status === 401 });
    const msg = leerRespuesta(texto, r.headers.get('content-type'), id);
    if (!msg) throw new HiggsfieldError(`${herramienta}: respuesta vacia`, { herramienta });
    if (msg.error) throw new HiggsfieldError(`${herramienta}: ${msg.error.message || JSON.stringify(msg.error)}`, { herramienta });
    const datos = datosDe(msg.result || {});
    if (datos && datos.error) throw new HiggsfieldError(`${herramienta}: ${typeof datos.error === 'string' ? datos.error : JSON.stringify(datos.error)}`, { herramienta });
    if (msg.result && msg.result.isError) {
      const t = (msg.result.content || []).map((c) => c.text).filter(Boolean).join(' ');
      throw new HiggsfieldError(`${herramienta}: ${t || 'fallo'}`, { herramienta });
    }
    return datos;
  }
  throw new HiggsfieldError(`${herramienta}: no autorizado`, { herramienta, desconectado: true });
}

async function estadoConexion() {
  const { rows } = await pool.query('SELECT cuenta, expira_en, actualizado, ultimo_error FROM hf_token WHERE id = 1');
  const f = rows[0];
  if (!f) return { conectado: false, motivo: 'sin token' };
  return { conectado: !f.ultimo_error, cuenta: f.cuenta, renovado: f.actualizado, error: f.ultimo_error };
}

module.exports = { llamar, accessToken, sembrarToken, estadoConexion, HiggsfieldError, _internos: { leerRespuesta, datosDe } };
