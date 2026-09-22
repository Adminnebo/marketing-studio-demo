/**
 * Reintento automatico cuando el filtro de contenido del generador rechaza una creacion.
 *
 * El generador devuelve el trabajo con estado 'nsfw' (o el create falla con un mensaje de
 * moderacion). Los productos electricos disparan falsos positivos: "bare", "stripped",
 * "exposed", "insert" son tecnicos aca, y las marcas impresas disparan copyright. En vez
 * de dejarlo fallido, se le manda el prompt rechazado y el motivo al generador de prompts
 * (lib/prompt-auto.js), que lo reescribe cambiando solo lo que lo disparo, y se encola una
 * creacion nueva con esa correccion.
 *
 * La creacion original queda fallida y reembolsada; el reintento se cobra como cualquier
 * otra (mismo usuario, mismo precio), asi que al final se paga una sola vez. Como cada
 * intento cuesta, hay un tope (ajuste reintento_moderacion, 0 = apagado) y el reintento de
 * un reintento nunca se encadena mas alla de ese tope.
 */
const { pool } = require('./db');
const ajustes = require('./config');
const promptAuto = require('./prompt-auto');
const saldoMarketing = require('./saldo-marketing');
const { conEspanol } = require('./idioma');
const auth = require('./auth');
const encolarLib = require('./encolar');

// Lo que dice el generador cuando es el filtro de contenido y no otra falla.
const SENSIBLE = /\bnsfw\b|moderation|content[_\s-]?polic|safety[_\s-]?(filter|system)|sensitive|inappropriate|explicit/i;
const COPYRIGHT = /copyright|infring|trademark|intellectual[_\s-]?propert|celebrity|public[_\s-]?figure/i;

/** 'nsfw' | 'copyright' | null: solo reintentamos los rechazos del filtro, no las fallas de verdad. */
function motivoDe({ estados = [], mensaje = '' } = {}) {
  const texto = [...estados, mensaje].filter(Boolean).join(' ');
  if (COPYRIGHT.test(texto)) return 'copyright';
  if (SENSIBLE.test(texto)) return 'nsfw';
  return null;
}

const intentoDe = (g) => Number(g?.entrada?.reintento?.intento || 0);

// El prompt que rechazaron y donde vuelve a escribirse.
function promptDe(g) {
  const e = g?.entrada || {};
  if (e.params && typeof e.params.prompt === 'string') return { texto: e.params.prompt, donde: 'libre' };
  if (e.args && typeof e.args.prompt === 'string') return { texto: e.args.prompt, donde: 'plantilla' };
  return null;
}

// La entrada de la creacion nueva: la misma, con el prompt corregido y la marca del reintento.
function entradaCorregida(g, { prompt, motivo, intento, avisos }) {
  const e = g.entrada;
  const marca = { reintento: { de: g.id, motivo, intento, avisos: avisos || [] } };
  if (e.params) return { ...e, params: { ...e.params, prompt: conEspanol(prompt) }, ...marca };
  return { ...e, args: { ...e.args, prompt: conEspanol(prompt) }, ...marca };
}

// Rol real del que creo: decide si se cobra. Si no se puede leer, se cobra (nunca regalamos).
async function usuarioDe(g) {
  let rol = 'usuario';
  try { rol = (await auth.rolMarketing(g.user_id)).rol || 'usuario'; } catch { /* se cobra */ }
  return { id: g.user_id, email: g.creado_por, rol, rolReal: rol };
}

/**
 * Reescribe el prompt y encola la creacion corregida.
 * Devuelve { id, motivo, intento } o null si no corresponde reintentar.
 */
async function intentar(g, motivo, { log = () => {} } = {}) {
  if (!motivo || !promptAuto.configurado()) return null;
  const max = Number((await ajustes.leer()).reintento_moderacion || 0);
  const intento = intentoDe(g) + 1;
  if (max <= 0 || intento > max) return null;
  const p = promptDe(g);
  if (!p) return null;

  const usuario = await usuarioDe(g);
  if (!(await saldoMarketing.puedeGastarIa(usuario))) return null;
  const aJh = saldoMarketing.exento(usuario);
  let r;
  try {
    r = p.donde === 'plantilla'
      ? await promptAuto.corregirTexto({ texto: p.texto, motivo })
      : await promptAuto.corregir({
        promptRechazado: p.texto, motivo,
        imagenUrl: g.entrada.producto?.url || g.portada?.url || null,
        tipo: g.preset_tipo === 'libre_video' ? 'video' : 'imagen',
        duracion: g.entrada.libre?.duracion, aspecto: g.entrada.libre?.aspecto || '9:16',
        conAudio: !!(g.entrada.libre?.opciones?.generate_audio || g.entrada.libre?.opciones?.sound),
        producto: g.entrada.producto?.nombre || '',
      });
  } catch (e) {
    if (e.uso) { // la IA respondio pero no sirvio: esos tokens se gastaron igual
      await saldoMarketing.cobrarIa({ por: usuario.email, clase: 'correccion', detalle: 'no salió', modelo: e.uso.modelo, entrada: e.uso.entrada, salida: e.uso.salida, aJh })
        .catch((x) => log(`#${g.id} cobro IA de la corrección: ${x.message}`));
    }
    log(`#${g.id} no se pudo corregir el prompt: ${e.message}`);
    return null;
  }
  await saldoMarketing.cobrarIa({ por: usuario.email, clase: 'correccion', detalle: `reintento por ${motivo}`, modelo: r.modelo, entrada: r.tokens.entrada, salida: r.tokens.salida, aJh })
    .catch((e) => log(`#${g.id} cobro IA de la corrección: ${e.message}`));

  const res = await encolarLib.encolar(usuario, {
    presetId: g.preset_id, presetNombre: g.preset_nombre, presetTipo: g.preset_tipo, portada: g.portada,
    entrada: entradaCorregida(g, { prompt: r.prompt, motivo, intento, avisos: r.avisos }),
    creditos: g.creditos_estimados,
  });
  if (res.error) {
    log(`#${g.id} no se pudo encolar el reintento: ${res.error.error || res.status}`);
    return null;
  }
  await pool.query(`UPDATE generaciones SET reintento_id = $2 WHERE id = $1`, [g.id, res.g.id]).catch(() => {});
  return { id: res.g.id, motivo, intento };
}

/** La creacion completa (el worker solo tiene unas columnas cuando detecta el fallo). */
async function fila(id) {
  const { rows } = await pool.query('SELECT * FROM generaciones WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { motivoDe, intentar, fila, promptDe, entradaCorregida, intentoDe, SENSIBLE, COPYRIGHT };
