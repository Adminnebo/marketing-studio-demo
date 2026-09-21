/**
 * Conexion con la plataforma central de pagos de Nebo (el "panel general", donde
 * vive el balance general del cliente). Contrato completo en docs/pagos-contrato.md.
 *
 * El saldo con el que se genera es el de la billetera de ESTE panel (lib/billetera.js).
 * La plataforma central participa en dos puntos:
 *  1. Recargas: el cliente pasa saldo de su balance general a Marketing
 *     (POST /recargas). La plataforma lo descuenta alla y aca se suman los creditos.
 *  2. Consumos: cada generacion cobrada que sale bien se informa con su detalle
 *     completo (POST /consumos) para que el cliente vea que se hizo y cuanto costo.
 *     Es informativo: el dinero ya se movio al recargar.
 * Generar nunca depende de que la plataforma responda; solo recargar.
 *
 * Todo va firmado y es idempotente por nuestra referencia (mkt-rec-<uuid>,
 * mkt-gen-<id>): reintentar nunca descuenta ni informa dos veces. Los consumos
 * van por una cola (pagos_eventos) que el worker reintenta con espera creciente.
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

// Balance general del cliente en la plataforma (lo que puede pasar a Marketing).
async function saldoGeneral() {
  const d = await llamar('GET', `/saldo?cliente=${encodeURIComponent(CLIENTE())}`);
  return { saldoUsd: Number(d.saldo_usd), moneda: d.moneda || 'USD', actualizado: d.actualizado || null };
}

// ── 1. Recargas: balance general -> billetera de Marketing ──
// Se registra primero (pendiente) y despues se pide: si la plataforma no contesta, el worker
// repite el mismo pedido (misma referencia) hasta saber si se aplico. Nunca se suma dos veces.
async function recargar({ montoUsd, precioCredito, usuario }) {
  const monto = Math.round(Number(montoUsd) * 100) / 100;
  if (!(monto > 0)) throw new PagosError('Monto inválido', { codigo: 'monto_invalido' });
  if (!(precioCredito > 0)) throw new PagosError('Sin precio por crédito', { codigo: 'sin_precio' });
  const creditos = Math.floor((monto / precioCredito) * 10) / 10;
  const referencia = `mkt-rec-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO recargas_central (referencia, monto_usd, creditos, precio_credito, por, usuario) VALUES ($1, $2, $3, $4, $5, $6)`,
    [referencia, monto, creditos, precioCredito, usuario.email, JSON.stringify(usuario)]
  );
  return aplicarRecarga(referencia);
}

// Pide (o repite) una recarga pendiente. Devuelve la fila con estado 'aplicada' | 'rechazada' | 'pendiente'.
async function aplicarRecarga(referencia) {
  const { rows: [rc] } = await pool.query(`SELECT * FROM recargas_central WHERE referencia = $1`, [referencia]);
  if (!rc || rc.estado !== 'pendiente') return rc;
  let r;
  try {
    r = await llamar('POST', '/recargas', {
      cliente: CLIENTE(), origen: ORIGEN, referencia, monto_usd: Number(rc.monto_usd), moneda: 'USD',
      creditos: Number(rc.creditos), precio_credito_usd: redondear(rc.precio_credito), usuario: rc.usuario,
      descripcion: `Recarga de Marketing: ${Number(rc.creditos)} créditos`,
    }, { idempotencia: referencia });
  } catch (e) {
    if (e.status === 402 || e.status === 400 || e.status === 409) {
      // Rechazada de verdad (sin saldo general, datos invalidos): no se suma nada.
      const { rows: [x] } = await pool.query(
        `UPDATE recargas_central SET estado = 'rechazada', motivo = $2, respuesta = $3, actualizado = now() WHERE referencia = $1 AND estado = 'pendiente' RETURNING *`,
        [referencia, e.codigo || `HTTP ${e.status}`, JSON.stringify(e.datos || {}).slice(0, 2000)]
      );
      return { ...(x || rc), estado: 'rechazada', saldoGeneralUsd: e.datos?.saldo_usd ?? null };
    }
    // Sin respuesta o error de la plataforma: no se sabe si se aplico. Queda pendiente y el worker repite.
    await pool.query(`UPDATE recargas_central SET intentos = intentos + 1, motivo = $2, actualizado = now() WHERE referencia = $1`, [referencia, e.message.slice(0, 500)]);
    return { ...rc, estado: 'pendiente' };
  }
  // Aplicada alla: se suman los creditos aca, una sola vez (la recarga y el movimiento van juntos).
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [x] } = await c.query(
      `UPDATE recargas_central SET estado = 'aplicada', respuesta = $2, recarga_id = $3, motivo = NULL, actualizado = now()
       WHERE referencia = $1 AND estado = 'pendiente' RETURNING *`,
      [referencia, JSON.stringify(r).slice(0, 2000), r.recarga_id || null]
    );
    if (x) {
      await c.query(
        `INSERT INTO billetera (tipo, creditos, usd, nota, por, referencia) VALUES ('recarga', $1, $2, 'Desde el saldo general', $3, $4)
         ON CONFLICT (referencia) WHERE referencia IS NOT NULL DO NOTHING`,
        [Number(x.creditos), Number(x.monto_usd), x.por, referencia]
      );
    }
    await c.query('COMMIT');
    return { ...(x || rc), estado: 'aplicada', saldoGeneralUsd: r.saldo_usd ?? null };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// El worker repite las recargas que quedaron sin respuesta (cada 2 min como minimo).
async function repetirRecargasPendientes() {
  if (!configurado()) return 0;
  const { rows } = await pool.query(
    `SELECT referencia FROM recargas_central WHERE estado = 'pendiente' AND actualizado < now() - interval '2 minutes' ORDER BY creado LIMIT 5`
  );
  let resueltas = 0;
  for (const { referencia } of rows) {
    const r = await aplicarRecarga(referencia).catch(() => null);
    if (r && r.estado !== 'pendiente') resueltas++;
  }
  return resueltas;
}

// ── 2. Consumos: detalle completo de cada generacion cobrada ──
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

// Solo se informa lo que se cobro de verdad a la billetera (no lo de super_admin ni lo devuelto).
async function informarConsumo(generacionId) {
  if (!configurado()) return false;
  const { rows: [g] } = await pool.query(
    `SELECT g.* FROM generaciones g
     WHERE g.id = $1 AND g.estado = 'completado'
       AND EXISTS (SELECT 1 FROM billetera b WHERE b.generacion_id = g.id AND b.tipo = 'consumo')
       AND NOT EXISTS (SELECT 1 FROM billetera b WHERE b.generacion_id = g.id AND b.tipo = 'reembolso')`, [generacionId]
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
  configurado, llamar, firmar, saldoGeneral, recargar, aplicarRecarga, repetirRecargasPendientes,
  detalleDe, descripcionDe, informarConsumo, procesarCola, reintentar, PagosError, MAX_INTENTOS,
};
