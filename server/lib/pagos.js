/**
 * Informar a la plataforma de pagos de Nebo el gasto de cada generacion cobrada,
 * con su detalle completo (medio, modelo o plantilla, duracion, calidad, formato,
 * audio, descripcion, resultados, creditos, precio). Con eso la plataforma lo
 * descuenta del saldo de JH (lib/saldo-externo.js), que es el saldo con el que
 * se genera.
 *
 * PENDIENTE: el endpoint de gasto todavia no existe. La forma de abajo (POST
 * {PAGOS_URL}/consumos, firmado e idempotente por referencia mkt-gen-<id>) es
 * la propuesta de docs/pagos-contrato.md y se ajusta al que entreguen. Sin las
 * variables PAGOS_* no se envia nada: lo gastado queda "pendiente de descontar"
 * y se resta del saldo leido para que no se gaste dos veces.
 *
 * Los envios van por una cola (pagos_eventos) que el worker reintenta con espera
 * creciente; al confirmarse se marca generaciones.gasto_informado.
 *
 * Firma: HMAC-SHA256 en hex de `${timestamp}.${cuerpo}` con PAGOS_SECRETO, en
 * X-Nebo-Firma, y el timestamp (segundos) en X-Nebo-Timestamp.
 */
const crypto = require('crypto');
const { pool } = require('./db');

const URL_BASE = () => (process.env.PAGOS_URL || '').replace(/\/+$/, '');
const API_KEY = () => process.env.PAGOS_API_KEY || '';
const SECRETO = () => process.env.PAGOS_SECRETO || '';
const CLIENTE = () => process.env.PAGOS_CLIENTE || '';
const ORIGEN = 'marketing';

class PagosError extends Error {
  constructor(msg, { status = 0, codigo = null, datos = null, red = false } = {}) {
    super(msg);
    this.status = status; this.codigo = codigo; this.datos = datos; this.red = red;
  }
}

const configurado = () => !!(URL_BASE() && API_KEY() && SECRETO() && CLIENTE());

function firmar(cuerpo, ts = Math.floor(Date.now() / 1000)) {
  return { ts: String(ts), firma: crypto.createHmac('sha256', SECRETO()).update(`${ts}.${cuerpo}`).digest('hex') };
}

async function llamar(metodo, ruta, body, { idempotencia, timeoutMs = 15000 } = {}) {
  if (!configurado()) throw new PagosError('La plataforma de pagos no está configurada', { codigo: 'sin_configurar' });
  const cuerpo = body ? JSON.stringify(body) : '';
  const { ts, firma } = firmar(cuerpo);
  let r;
  try {
    r = await fetch(URL_BASE() + ruta, {
      method: metodo,
      headers: {
        authorization: 'Bearer ' + API_KEY(), 'x-nebo-timestamp': ts, 'x-nebo-firma': firma, 'x-nebo-origen': ORIGEN,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(idempotencia ? { 'idempotency-key': idempotencia } : {}),
      },
      body: body ? cuerpo : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PagosError(`${metodo} ${ruta}: sin respuesta (${e.message})`, { red: true });
  }
  const texto = await r.text();
  let j = {};
  try { j = texto ? JSON.parse(texto) : {}; } catch { j = { texto: texto.slice(0, 300) }; }
  if (!r.ok) throw new PagosError(`${metodo} ${ruta}: HTTP ${r.status} ${j.error || ''}`.trim(), { status: r.status, codigo: j.error || null, datos: j, red: r.status >= 500 });
  return j;
}

const redondear = (n) => (n == null ? null : Math.round(Number(n) * 10000) / 10000);

// ── Gasto de cada generacion cobrada, con su detalle completo ──
const TIPOS_VIDEO = new Set(['ugc', '2d_motion', 'hypermotion', 'mixed_media', 'saas_motion', 'libre_video']);
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
    panel: ORIGEN,
    medio: esVideo ? 'video' : 'foto',
    origen: libre ? 'desde_cero' : 'plantilla',
    nombre: g.preset_nombre || null,
    modelo: libre ? { id: libre.modelo, nombre: g.preset_nombre || libre.modelo } : { id: 'marketing_studio', nombre: 'Marketing Studio' },
    plantilla: libre ? null : { id: g.preset_id, nombre: g.preset_nombre || null, tipo: g.preset_tipo, categoria: e.categoria || null, formato: args.format_name || null },
    duracion_s: esVideo ? Number(libre?.duracion || p.duration || e.detalle?.duracion_s) || null : null,
    calidad: op.resolution || op.quality || e.detalle?.resolucion || null,
    formato: libre?.aspecto || p.aspect_ratio || null,
    audio: esVideo ? audio : null,
    opciones: libre ? op : {},
    descripcion: String(p.prompt || args.prompt || '').slice(0, 2000) || null,
    descripcion_por_ia: !!libre?.promptAuto,
    imagen_producto: e.producto?.url || null,
    persona: e.avatar?.name || null,
    resultados: (g.resultados || []).filter((r) => r.url).map((r) => ({ url: r.url, miniatura: r.miniatura || null })),
    creado: g.creado,
    terminado: g.terminado || null,
    segundos_proceso: g.enviado && g.terminado ? Math.round((new Date(g.terminado) - new Date(g.enviado)) / 1000) : null,
    creditos: g.creditos_estimados != null ? Number(g.creditos_estimados) : null,
    precio_usd: redondear(g.precio_usd),
    // Interno de Nebo (reportes de margen); el cliente pago precio_usd.
    costo_usd: redondear(g.costo_usd),
    margen_pct: g.margen_pct != null ? Number(g.margen_pct) : null,
    usd_por_credito: g.usd_por_credito != null ? Number(g.usd_por_credito) : null,
  };
}

function descripcionDe(g) {
  const d = detalleDe(g);
  return [d.medio === 'video' ? 'Video' : 'Foto', d.origen === 'plantilla' ? `plantilla "${d.nombre}"` : d.modelo.nombre,
    d.duracion_s ? `${d.duracion_s} s` : null, d.calidad, d.formato].filter(Boolean).join(' · ');
}

// Solo se informa lo que se cobro de verdad (no lo de super_admin ni lo que fallo).
async function informarConsumo(generacionId) {
  if (!configurado()) return false;
  const { rows: [g] } = await pool.query(
    `SELECT g.* FROM generaciones g
     WHERE g.id = $1 AND g.estado = 'completado' AND g.gasto_informado IS NULL
       AND (g.cobro_externo OR (
         EXISTS (SELECT 1 FROM billetera b WHERE b.generacion_id = g.id AND b.tipo = 'consumo')
         AND NOT EXISTS (SELECT 1 FROM billetera b WHERE b.generacion_id = g.id AND b.tipo = 'reembolso')))`, [generacionId]
  );
  if (!g) return false;
  const referencia = `mkt-gen-${g.id}`;
  const cuerpo = {
    cliente: CLIENTE(), origen: ORIGEN, referencia, monto_usd: redondear(g.precio_usd), moneda: 'USD',
    creditos: g.creditos_estimados != null ? Number(g.creditos_estimados) : null,
    descripcion: descripcionDe(g), detalle: detalleDe(g),
    usuario: { id: g.user_id, email: g.creado_por },
  };
  const r = await pool.query(
    `INSERT INTO pagos_eventos (generacion_id, referencia, tipo, cuerpo) VALUES ($1, $2, 'consumo', $3)
     ON CONFLICT (generacion_id, tipo) DO NOTHING`, [g.id, referencia, JSON.stringify(cuerpo)]
  );
  return r.rowCount > 0;
}

// Espera entre intentos: 1, 2, 4... min, tope 1 h. Tras 12 intentos queda 'error' para Super Admin.
const MAX_INTENTOS = 12;
const espera = (n) => Math.min(60, 2 ** Math.max(0, n - 1));

async function procesarCola({ limite = 10 } = {}) {
  if (!configurado()) return { hechos: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM pagos_eventos WHERE estado = 'pendiente' AND proximo <= now() ORDER BY id LIMIT $1`, [limite]
  );
  let hechos = 0;
  for (const ev of rows) {
    try {
      const r = await llamar('POST', '/consumos', ev.cuerpo, { idempotencia: ev.referencia });
      await pool.query(`UPDATE pagos_eventos SET estado = 'hecho', intentos = intentos + 1, hecho = now(), respuesta = $2, ultimo_error = NULL WHERE id = $1`, [ev.id, JSON.stringify(r).slice(0, 2000)]);
      await pool.query(`UPDATE generaciones SET gasto_informado = now() WHERE id = $1`, [ev.generacion_id]);
      hechos++;
    } catch (e) {
      // 4xx (menos 408/429) no se arregla reintentando: queda en error para revisar en Super Admin.
      const sinArreglo = e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status);
      const final = sinArreglo || ev.intentos + 1 >= MAX_INTENTOS;
      await pool.query(
        `UPDATE pagos_eventos SET intentos = intentos + 1, ultimo_error = $2, estado = $3,
           proximo = now() + ($4 || ' minutes')::interval WHERE id = $1`,
        [ev.id, e.message.slice(0, 500), final ? 'error' : 'pendiente', espera(ev.intentos + 1)]
      );
    }
  }
  return { hechos, revisados: rows.length };
}

async function reintentar(id) {
  const r = await pool.query(`UPDATE pagos_eventos SET estado = 'pendiente', proximo = now(), intentos = 0 WHERE id = $1 AND estado = 'error'`, [id]);
  return r.rowCount > 0;
}

module.exports = {
  configurado, llamar, firmar, detalleDe, descripcionDe, informarConsumo, procesarCola, reintentar, PagosError, MAX_INTENTOS,
};
