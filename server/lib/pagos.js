/**
 * Descontar del saldo de JH (plataforma de pagos de Nebo, Sword AI) el gasto de
 * cada generacion cobrada, con su detalle:
 *
 *   POST {AJUSTE_URL}   (por defecto https://app.swordaisolutions.com/api/credits/adjust)
 *   { callerId, apiKey, clientId, amount, operation: 'subtract', concept: 'marketing', note }
 *
 * amount = precio para JH en USD (costo + ganancia). note = el detalle legible
 * (medio, modelo o plantilla, duracion, calidad, formato, audio, creditos, quien)
 * con nuestra referencia mkt-gen-<id> para ubicarlo en la plataforma.
 *
 * El endpoint no trae clave de idempotencia: repetir un pedido que SI se aplico
 * descontaria dos veces. Por eso solo se reintenta solo cuando es seguro que no
 * llego (no se pudo conectar, 429, 503). Si se corto a mitad (timeout, 500, 502,
 * 504, sin respuesta legible) queda en 'error' para que un super_admin lo revise
 * en la plataforma y decida reintentar o darlo por hecho.
 *
 * Los envios van por una cola (pagos_eventos) que procesa el worker; al
 * confirmarse se marca generaciones.gasto_informado. Mientras tanto el gasto se
 * resta del saldo leido como "por descontar" (lib/saldo-externo.js).
 * La clave va solo en variables del servidor (AJUSTE_API_KEY).
 */
const { pool } = require('./db');
const ajustes = require('./config');

const URL_AJUSTE = () => process.env.AJUSTE_URL || 'https://app.swordaisolutions.com/api/credits/adjust';
const CALLER = () => process.env.AJUSTE_CALLER_ID || '';
const CLAVE = () => process.env.AJUSTE_API_KEY || '';
const CLIENTE = () => process.env.SALDO_CLIENT_ID || '';

class PagosError extends Error {
  constructor(msg, { status = 0, seguro = false, datos = null } = {}) {
    super(msg);
    this.status = status; this.seguro = seguro; this.datos = datos; // seguro = no llego: se puede repetir
  }
}

const configurado = () => !!(CALLER() && CLAVE() && CLIENTE());

// Errores de red que aseguran que el pedido no llego a la plataforma.
const NO_LLEGO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

async function ajustar({ amount, note }) {
  if (!configurado()) throw new PagosError('El descuento de saldo no está configurado');
  const cuerpo = {
    callerId: Number(CALLER()), apiKey: CLAVE(), clientId: Number(CLIENTE()),
    amount, operation: 'subtract', concept: 'marketing', note,
  };
  let r;
  try {
    r = await fetch(URL_AJUSTE(), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const codigo = e.cause?.code || e.code;
    throw new PagosError(`sin respuesta (${codigo || e.name}: ${e.message})`, { seguro: NO_LLEGO.has(codigo) });
  }
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : {}; } catch { /* respuesta no JSON */ }
  if (!r.ok || !j || j.success === false) {
    const motivo = (j && (j.error || j.message)) || texto.slice(0, 200) || '';
    throw new PagosError(`HTTP ${r.status} ${motivo}`.trim(), { status: r.status, seguro: r.status === 429 || r.status === 503, datos: j });
  }
  return j;
}

const redondear = (n, d = 4) => (n == null ? null : Math.round(Number(n) * 10 ** d) / 10 ** d);

// ── Detalle de una generacion ──
const TIPOS_VIDEO = new Set(['ugc', '2d_motion', 'hypermotion', 'mixed_media', 'saas_motion', 'libre_video']);
const FORMATOS = { '9:16': 'vertical 9:16', '16:9': 'horizontal 16:9', '1:1': 'cuadrado 1:1', '4:5': 'vertical 4:5', '3:4': 'vertical 3:4', '4:3': 'horizontal 4:3', '21:9': 'cine 21:9' };
function detalleDe(g) {
  const e = g.entrada || {};
  const libre = e.libre || null;
  const p = e.params || {};
  const args = e.args || {};
  const op = libre?.opciones || {};
  const esVideo = TIPOS_VIDEO.has(g.preset_tipo);
  const audio = op.generate_audio ?? (op.sound != null ? op.sound !== 'off' : null);
  return {
    generacion_id: Number(g.id),
    medio: esVideo ? 'video' : 'foto',
    origen: libre ? 'desde_cero' : 'plantilla',
    nombre: g.preset_nombre || null,
    modelo: libre ? (g.preset_nombre || libre.modelo) : 'Marketing Studio',
    plantilla: libre ? null : { id: g.preset_id, nombre: g.preset_nombre || null, tipo: g.preset_tipo, formato: args.format_name || null },
    duracion_s: esVideo ? Number(libre?.duracion || p.duration || e.detalle?.duracion_s) || null : null,
    calidad: op.resolution || op.quality || e.detalle?.resolucion || null,
    formato: libre?.aspecto || p.aspect_ratio || null,
    audio: esVideo ? audio : null,
    creditos: g.creditos_estimados != null ? Number(g.creditos_estimados) : null,
    precio_usd: redondear(g.precio_usd),
    usuario: g.creado_por,
    resultado: (g.resultados || []).find((r) => r.url)?.url || null,
  };
}

// La nota que ve la plataforma: todo el detalle en una linea legible.
function notaDe(g) {
  const d = detalleDe(g);
  return [
    `${d.medio === 'video' ? 'Video' : 'Foto'} ${d.origen === 'plantilla' ? `plantilla "${d.nombre}"` : d.modelo}`,
    d.duracion_s ? `${d.duracion_s} s` : null,
    d.calidad,
    d.formato ? FORMATOS[d.formato] || d.formato : null,
    d.audio === true ? 'con audio' : d.audio === false ? 'sin audio' : null,
    d.creditos != null ? `${d.creditos} créditos` : null,
    `$${Number(d.precio_usd).toFixed(2)}`,
    d.usuario,
    g.cobro_externo === false ? 'super admin' : null,
    `ref mkt-gen-${d.generacion_id}`,
  ].filter(Boolean).join(' · ').slice(0, 500);
}

// Encola el descuento de una generacion que salio bien: las cobradas contra el saldo externo y, si
// el ajuste informar_super_admin esta activo (o se fuerza desde el historial), las de super admins.
async function informarConsumo(generacionId, { forzar = false } = {}) {
  if (!configurado()) return false;
  const superAdmin = forzar || Number((await ajustes.leer()).informar_super_admin) === 1;
  const { rows: [g] } = await pool.query(
    `SELECT * FROM generaciones WHERE id = $1 AND estado = 'completado' AND gasto_informado IS NULL AND (cobro_externo OR $2)`, [generacionId, superAdmin]
  );
  if (!g || !(Number(g.precio_usd) > 0)) return false;
  // Se descuenta en centavos: lo mismo que JH ve en el panel ($2.18, no $2.184).
  const cuerpo = { amount: redondear(g.precio_usd, 2), note: notaDe(g), detalle: detalleDe(g) };
  const r = await pool.query(
    `INSERT INTO pagos_eventos (generacion_id, referencia, tipo, cuerpo) VALUES ($1, $2, 'consumo', $3)
     ON CONFLICT (generacion_id, tipo) DO NOTHING`, [g.id, `mkt-gen-${g.id}`, JSON.stringify(cuerpo)]
  );
  return r.rowCount > 0;
}

// Red de seguridad: completadas cobradas sin su descuento encolado (p. ej. si fallo al encolar).
// Solo las cobradas: las de super admin del pasado se mandan unicamente desde el historial, a mano.
async function encolarFaltantes() {
  if (!configurado()) return 0;
  const { rows } = await pool.query(
    `SELECT g.id FROM generaciones g
     WHERE g.estado = 'completado' AND g.cobro_externo AND g.gasto_informado IS NULL
       AND NOT EXISTS (SELECT 1 FROM pagos_eventos e WHERE e.generacion_id = g.id)
     ORDER BY g.id LIMIT 20`
  );
  let n = 0;
  for (const { id } of rows) if (await informarConsumo(id)) n++;
  return n;
}

// Espera entre intentos seguros: 1, 2, 4... min, tope 1 h, hasta 12 intentos.
const MAX_INTENTOS = 12;
const espera = (n) => Math.min(60, 2 ** Math.max(0, n - 1));

async function procesarCola({ limite = 10 } = {}) {
  if (!configurado()) return { hechos: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM pagos_eventos WHERE estado = 'pendiente' AND proximo <= now() ORDER BY id LIMIT $1`, [limite]
  );
  let hechos = 0;
  for (const ev of rows) {
    // Se marca 'enviando' antes de pedir: si el worker muere a mitad, queda para revisar (no se repite solo).
    const { rowCount } = await pool.query(`UPDATE pagos_eventos SET estado = 'enviando', proximo = now() WHERE id = $1 AND estado = 'pendiente'`, [ev.id]);
    if (!rowCount) continue;
    try {
      const r = await ajustar({ amount: ev.cuerpo.amount, note: ev.cuerpo.note });
      await pool.query(`UPDATE pagos_eventos SET estado = 'hecho', intentos = intentos + 1, hecho = now(), respuesta = $2, ultimo_error = NULL WHERE id = $1`, [ev.id, JSON.stringify(r).slice(0, 2000)]);
      await pool.query(`UPDATE generaciones SET gasto_informado = now() WHERE id = $1`, [ev.generacion_id]);
      hechos++;
    } catch (e) {
      const repetir = e.seguro && ev.intentos + 1 < MAX_INTENTOS;
      await pool.query(
        `UPDATE pagos_eventos SET intentos = intentos + 1, ultimo_error = $2, estado = $3,
           proximo = now() + ($4 || ' minutes')::interval WHERE id = $1`,
        [ev.id, (e.seguro ? '' : 'Puede que se haya descontado: revisa en la plataforma antes de reintentar. ') + e.message.slice(0, 400),
          repetir ? 'pendiente' : 'error', espera(ev.intentos + 1)]
      );
    }
  }
  return { hechos, revisados: rows.length };
}

// Lo que quedo 'enviando' (el worker se cayo a mitad) pasa a error para revisar; nunca se repite solo.
async function liberarEnviando() {
  const { rowCount } = await pool.query(
    `UPDATE pagos_eventos SET estado = 'error', ultimo_error = 'Se cortó mientras se enviaba: puede que se haya descontado. Revisa en la plataforma antes de reintentar.'
     WHERE estado = 'enviando' AND proximo < now() - interval '5 minutes'`
  );
  return rowCount;
}

// Historial: completadas que nunca se informaron (ni estan en cola), con y sin precio.
async function historialSinInformar() {
  const { rows } = await pool.query(
    `SELECT g.id, g.creado_por, g.preset_nombre, g.preset_tipo, g.precio_usd, g.cobro_externo, g.creado
     FROM generaciones g
     WHERE g.estado = 'completado' AND g.gasto_informado IS NULL
       AND NOT EXISTS (SELECT 1 FROM pagos_eventos e WHERE e.generacion_id = g.id)
     ORDER BY g.id`
  );
  const conPrecio = rows.filter((r) => Number(r.precio_usd) > 0);
  return {
    items: rows.map((r) => ({ ...r, id: Number(r.id), precio_usd: r.precio_usd != null ? redondear(r.precio_usd, 2) : null })),
    total: redondear(conPrecio.reduce((a, r) => a + redondear(r.precio_usd, 2), 0), 2),
    enviables: conPrecio.length, sinPrecio: rows.length - conPrecio.length,
  };
}

// Encola el historial (solo si el total coincide con lo que vio el super_admin, para no mandar de mas).
async function enviarHistorial(totalVisto) {
  const h = await historialSinInformar();
  if (Math.abs(h.total - Number(totalVisto)) > 0.001) return { error: 'El historial cambió. Recarga y revisa el total antes de enviar.' };
  let n = 0;
  for (const it of h.items) if (it.precio_usd > 0 && await informarConsumo(it.id, { forzar: true })) n++;
  return { encolados: n, total: h.total };
}

async function reintentar(id) {
  const r = await pool.query(`UPDATE pagos_eventos SET estado = 'pendiente', proximo = now() WHERE id = $1 AND estado = 'error'`, [id]);
  return r.rowCount > 0;
}

// Se verificó en la plataforma que sí entró (o se descontó a mano): se da por hecho sin reenviar.
async function marcarHecho(id, por) {
  const { rows: [ev] } = await pool.query(
    `UPDATE pagos_eventos SET estado = 'hecho', hecho = now(), respuesta = $2 WHERE id = $1 AND estado = 'error' RETURNING generacion_id`,
    [id, JSON.stringify({ marcado_a_mano_por: por })]
  );
  if (!ev) return false;
  await pool.query(`UPDATE generaciones SET gasto_informado = now() WHERE id = $1`, [ev.generacion_id]);
  return true;
}

module.exports = {
  configurado, ajustar, detalleDe, notaDe, informarConsumo, encolarFaltantes, procesarCola, liberarEnviando,
  historialSinInformar, enviarHistorial, reintentar, marcarHecho, PagosError, MAX_INTENTOS,
};
