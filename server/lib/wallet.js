/**
 * Wallet de Marketing en la plataforma central de Nebo: el saldo con el que trabaja este panel.
 *
 *   GET  {WALLET_URL}?clientId=&apiKey=
 *     -> { success, name, slug, balance, currency }
 *   POST {WALLET_URL}/debit
 *     { clientId, apiKey, amount, description, reference }
 *
 * Es la unica fuente de gasto: cada creacion y cada ayuda de IA se debitan de aqui (decision
 * del 2026-09-23). El saldo general de JH ya no se descuenta por creacion.
 *
 * `reference` es la idempotencia: la armamos nosotros, estable por cobro ('mkt-gen-12',
 * 'mkt-ia-345'), asi que reintentar el MISMO debito no puede cobrar dos veces... si de su lado
 * la referencia se respeta. Eso todavia no esta confirmado, asi que la politica de reintentos
 * sigue siendo la conservadora: solo se repite lo que consta que no llego; lo dudoso queda para
 * revisar a mano, con su referencia a la vista.
 *
 * La clave va solo en el servidor (variables de Railway): nunca llega al navegador.
 *
 * Cada cobro se encola en wallet_debitos (referencia UNIQUE: la cola tampoco puede duplicar) y
 * el worker la procesa. Mientras un debito no se aplico alla, se resta del saldo leido: asi el
 * "disponible" no deja gastar dos veces la misma plata.
 */
const { pool } = require('./db');

const URL_BASE = () => (process.env.WALLET_URL || '').replace(/\/+$/, '');
const CLIENTE = () => process.env.WALLET_CLIENT_ID || process.env.SALDO_CLIENT_ID || '';
const CLAVE = () => process.env.WALLET_API_KEY || process.env.SALDO_API_KEY || '';
const TIEMPO_MS = 15000;
const MAX_INTENTOS = 6;
// La plataforma trabaja en USD con centavos: lo que redondea a $0.00 no se manda (se queda
// anotado aca y no se cobra, nunca al reves: jamas cobramos mas de lo que costo).
const MINIMO_USD = 0.01;

// Se activa poniendo WALLET_URL en Railway: sin eso, el panel sigue como antes.
const configurado = () => !!(URL_BASE() && CLIENTE() && CLAVE());

class ErrorDeWallet extends Error {
  constructor(mensaje, { seguro = false, sinSaldo = false, definitivo = false, detalle = null } = {}) {
    super(mensaje);
    this.seguro = seguro;         // consta que NO se debito: se puede reintentar
    this.sinSaldo = sinSaldo;     // el wallet no tiene con que: no es un error nuestro
    this.definitivo = definitivo; // no tiene sentido reintentar (clave mala, monto invalido)
    this.detalle = detalle;
  }
}

// Estados HTTP en los que la peticion no llego a procesarse: reintentar es seguro.
const NO_LLEGO = new Set([408, 425, 429, 502, 503, 504]);
const centavos = (usd) => Math.round(Number(usd) * 100) / 100;

// ── Saldo ──

let _cache = { v: null, exp: 0 };
async function leer({ fresco = false } = {}) {
  if (!configurado()) throw new ErrorDeWallet('El wallet de Marketing no está configurado', { definitivo: true });
  if (!fresco && _cache.exp > Date.now()) return _cache.v;
  const url = new URL(URL_BASE());
  url.searchParams.set('clientId', CLIENTE());
  url.searchParams.set('apiKey', CLAVE());
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_MS), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ErrorDeWallet(`sin respuesta (${e.message})`, { seguro: true });
  }
  const j = await r.json().catch(() => ({}));
  const saldo = Number(j.balance ?? j.credits);
  if (!r.ok || j.success === false || !Number.isFinite(saldo)) {
    throw new ErrorDeWallet(`respuesta inesperada: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`, { seguro: true });
  }
  const v = { saldoUsd: saldo, moneda: j.currency || 'USD', nombre: j.name || 'Marketing', slug: j.slug || 'marketing', leido: new Date().toISOString() };
  _cache = { v, exp: Date.now() + 20e3 };
  return v;
}
const olvidar = () => { _cache.exp = 0; };

// ── Debitar ──

/** Manda un debito. Devuelve { saldoUsd, duplicada, respuesta } o lanza ErrorDeWallet. */
async function debitar({ usd, descripcion, referencia }) {
  if (!configurado()) throw new ErrorDeWallet('El wallet de Marketing no está configurado', { definitivo: true });
  const monto = centavos(usd);
  if (!(monto > 0)) throw new ErrorDeWallet(`monto inválido (${usd})`, { seguro: true, definitivo: true });
  if (!referencia) throw new ErrorDeWallet('falta la referencia', { seguro: true, definitivo: true });
  const cuerpo = {
    clientId: Number(CLIENTE()) || CLIENTE(), apiKey: CLAVE(),
    amount: monto, description: String(descripcion || 'Marketing').slice(0, 200), reference: String(referencia).slice(0, 100),
  };
  let r;
  try {
    r = await fetch(`${URL_BASE()}/debit`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(TIEMPO_MS),
    });
  } catch (e) {
    // Sin respuesta: puede no haber salido, pero tambien puede haberse aplicado y perdido la respuesta.
    // Con timeout no hay forma de saberlo, asi que NO se marca seguro.
    throw new ErrorDeWallet(`sin respuesta (${e.message})`, { seguro: /abort|timeout/i.test(e.message) ? false : true });
  }
  const texto = (await r.text().catch(() => '')).slice(0, 2000);
  let j = {};
  try { j = JSON.parse(texto); } catch { /* respuesta no-JSON: queda en el detalle */ }
  const error = String(j.error || j.message || '');

  if (r.ok && j.success !== false) {
    return { saldoUsd: Number(j.balance ?? j.newBalance ?? NaN), duplicada: false, respuesta: texto };
  }
  // Referencia repetida: del otro lado ya esta cobrado, asi que para nosotros esta hecho.
  if (/duplicat|already|repetid|existe|duplicad/i.test(error)) {
    return { saldoUsd: Number(j.balance ?? NaN), duplicada: true, respuesta: texto };
  }
  if (r.status === 402 || /insufficient|no alcanza|sin saldo|balance/i.test(error)) {
    throw new ErrorDeWallet('el wallet de Marketing no tiene saldo suficiente', { seguro: true, sinSaldo: true, detalle: texto });
  }
  if (r.status === 401 || r.status === 403) throw new ErrorDeWallet('el wallet rechazó la clave', { seguro: true, definitivo: true, detalle: texto });
  if (r.status === 400 || r.status === 404) throw new ErrorDeWallet(`el wallet rechazó el pedido (HTTP ${r.status})`, { seguro: true, definitivo: true, detalle: texto });
  throw new ErrorDeWallet(`HTTP ${r.status}`, { seguro: NO_LLEGO.has(r.status), detalle: texto });
}

// ── Pedir recarga (la aprueba una persona en el panel central de Nebo) ──

/**
 * Manda una solicitud de recarga del wallet.
 *   POST {WALLET_URL}/requests { clientId, apiKey, amount, description, reference }
 * La `referencia` ('mkt-rec-12') la armamos nosotros: si el pedido se repite, del otro lado
 * se ve que es el mismo. Devuelve { id, estado, respuesta }.
 */
async function solicitarRecarga({ usd, descripcion, referencia }) {
  if (!configurado()) throw new ErrorDeWallet('El wallet de Marketing no está configurado', { definitivo: true });
  const monto = centavos(usd);
  if (!(monto > 0)) throw new ErrorDeWallet(`monto inválido (${usd})`, { seguro: true, definitivo: true });
  let r;
  const cuerpo = {
    clientId: Number(CLIENTE()) || CLIENTE(), apiKey: CLAVE(), amount: monto,
    description: String(descripcion || 'Recarga de Marketing').slice(0, 200), reference: String(referencia || '').slice(0, 100),
  };
  try {
    r = await fetch(`${URL_BASE()}/requests`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(TIEMPO_MS),
    });
  } catch (e) {
    throw new ErrorDeWallet(`sin respuesta (${e.message})`, { seguro: /abort|timeout/i.test(e.message) ? false : true });
  }
  const texto = (await r.text().catch(() => '')).slice(0, 2000);
  let j = {};
  try { j = JSON.parse(texto); } catch { /* respuesta no-JSON */ }
  const error = String(j.error || j.message || '');
  if (r.ok && j.success !== false) {
    // `duplicate: true` = esa referencia ya se habia pedido: no se creo otra solicitud.
    return { id: j.id ?? j.requestId ?? j.request?.id ?? null, estado: j.status || j.request?.status || 'pendiente',
      duplicada: j.duplicate === true, respuesta: texto };
  }
  if (/duplicat|already|repetid|existe/i.test(error)) return { id: j.id ?? null, estado: 'pendiente', duplicada: true, respuesta: texto };
  if (r.status === 401 || r.status === 403) throw new ErrorDeWallet('la plataforma rechazó la clave', { seguro: true, definitivo: true, detalle: texto });
  if (r.status === 400 || r.status === 404) throw new ErrorDeWallet(`la plataforma rechazó el pedido (HTTP ${r.status})`, { seguro: true, definitivo: true, detalle: texto });
  throw new ErrorDeWallet(`HTTP ${r.status}`, { seguro: NO_LLEGO.has(r.status), detalle: texto });
}

/**
 * Estado de las solicitudes de recarga en la plataforma.
 *   GET {WALLET_URL sin el slug}/requests -> { requests: [{ id, status, amount, approvedAmount,
 *        budget:{slug}, reference, decisionNote, decidedAt, createdAt }] }
 * Devuelve solo las de este wallet.
 */
async function solicitudesEnPlataforma(limite = 60) {
  if (!configurado()) return [];
  const slug = URL_BASE().split('/').pop();
  const url = new URL(`${URL_BASE().replace(/\/[^/]+$/, '')}/requests`);
  url.searchParams.set('clientId', CLIENTE());
  url.searchParams.set('apiKey', CLAVE());
  const r = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_MS), headers: { accept: 'application/json' } })
    .catch((e) => { throw new ErrorDeWallet(`sin respuesta (${e.message})`, { seguro: true }); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new ErrorDeWallet(`respuesta inesperada: HTTP ${r.status}`, { seguro: true });
  return (j.requests || [])
    .filter((s) => !s.budget?.slug || s.budget.slug === slug)
    .slice(0, limite)
    .map((s) => ({
      idPlataforma: s.id, estado: String(s.status || '').toLowerCase(), referencia: s.reference || null,
      montoUsd: Number(s.amount), aprobadoUsd: s.approvedAmount == null ? null : Number(s.approvedAmount),
      nota: s.decisionNote || null, decidido: s.decidedAt || null, creado: s.createdAt || null, pedidaPor: s.requestedBy || null,
    }));
}

/** Movimientos del wallet en la plataforma (para ver si una recarga ya entró). */
async function movimientos(limite = 50) {
  if (!configurado()) return [];
  const url = new URL(`${URL_BASE()}/movements`);
  url.searchParams.set('clientId', CLIENTE());
  url.searchParams.set('apiKey', CLAVE());
  const r = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_MS), headers: { accept: 'application/json' } })
    .catch((e) => { throw new ErrorDeWallet(`sin respuesta (${e.message})`, { seguro: true }); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new ErrorDeWallet(`respuesta inesperada: HTTP ${r.status}`, { seguro: true });
  return (j.movements || []).slice(0, limite).map((m) => ({
    id: m.id, tipo: m.kind, usd: Number(m.amount), referencia: m.reference || null,
    concepto: m.description || '', fecha: m.at || null, saldoDespues: Number(m.balanceAfter),
  }));
}

// ── Cola de debitos (wallet_debitos) ──

/**
 * Anota un cobro para mandarlo. `referencia` es UNIQUE: si ya estaba, no hace nada
 * (asi ni un reintento nuestro ni un doble evento pueden cobrar dos veces).
 * Devuelve true si lo encolo ahora.
 */
async function encolar({ referencia, usd, descripcion, generacionId = null, movimientoId = null, por = null }) {
  const monto = centavos(usd);
  if (!(monto >= MINIMO_USD)) return false; // menos de un centavo: no se cobra
  const { rowCount } = await pool.query(
    `INSERT INTO wallet_debitos (referencia, usd, descripcion, generacion_id, movimiento_id, por)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (referencia) DO NOTHING`,
    [String(referencia), monto, String(descripcion || 'Marketing').slice(0, 200), generacionId, movimientoId, por]
  );
  return rowCount > 0;
}

/**
 * Encola el debito de una creacion que salio bien. Solo las marcadas cobro_wallet: las de antes
 * del cambio de modelo se pagaron por el camino viejo y nunca se cobran de nuevo.
 * Devuelve true si lo encolo ahora.
 */
async function informarGasto(generacionId) {
  if (!configurado()) return false;
  const { rows: [g] } = await pool.query(
    `SELECT id, preset_nombre, preset_tipo, precio_usd, creado_por FROM generaciones
     WHERE id = $1 AND estado = 'completado' AND gasto_informado IS NULL AND cobro_wallet`, [generacionId]
  );
  if (!g || !(Number(g.precio_usd) > 0)) return false;
  return encolar({
    referencia: `mkt-gen-${g.id}`, usd: g.precio_usd, generacionId: g.id, por: g.creado_por,
    descripcion: [g.preset_nombre || 'Creación', g.preset_tipo, g.creado_por].filter(Boolean).join(' · '),
  });
}

// Red de seguridad: terminadas que se pagan del wallet y quedaron sin su debito encolado.
async function encolarFaltantes({ limite = 20 } = {}) {
  if (!configurado()) return 0;
  const { rows } = await pool.query(
    `SELECT g.id FROM generaciones g
     WHERE g.estado = 'completado' AND g.cobro_wallet AND g.gasto_informado IS NULL AND g.precio_usd > 0
       AND NOT EXISTS (SELECT 1 FROM wallet_debitos w WHERE w.generacion_id = g.id)
     ORDER BY g.id LIMIT $1`, [limite]
  );
  let n = 0;
  for (const { id } of rows) if (await informarGasto(id)) n++;
  return n;
}

const espera = (intentos) => Math.min(60, 2 ** Math.max(0, intentos - 1)); // minutos: 1, 2, 4, 8, 16, 32

async function procesarCola({ limite = 10 } = {}) {
  if (!configurado()) return { hechos: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM wallet_debitos WHERE estado = 'pendiente' AND proximo <= now() ORDER BY id LIMIT $1`, [limite]
  );
  let hechos = 0; let duplicados = 0;
  for (const d of rows) {
    // Se marca 'enviando' antes de pedir: si el worker muere a mitad, queda para revisar.
    const { rowCount } = await pool.query(`UPDATE wallet_debitos SET estado = 'enviando' WHERE id = $1 AND estado = 'pendiente'`, [d.id]);
    if (!rowCount) continue;
    try {
      const r = await debitar({ usd: d.usd, descripcion: d.descripcion, referencia: d.referencia });
      await pool.query(
        `UPDATE wallet_debitos SET estado = 'hecho', intentos = intentos + 1, hecho = now(), respuesta = $2, ultimo_error = NULL, duplicada = $3 WHERE id = $1`,
        [d.id, String(r.respuesta || '').slice(0, 2000), !!r.duplicada]
      );
      if (d.generacion_id) await pool.query('UPDATE generaciones SET gasto_informado = now() WHERE id = $1', [d.generacion_id]);
      olvidar(); // el saldo cambio
      hechos++;
      if (r.duplicada) duplicados++;
    } catch (e) {
      const repetir = e.seguro && !e.definitivo && d.intentos + 1 < MAX_INTENTOS;
      const aviso = e.sinSaldo ? 'El wallet de Marketing se quedó sin saldo: recárgalo y se manda solo. '
        : e.seguro ? '' : 'Puede que SÍ se haya debitado: revísalo en la plataforma antes de reintentar. ';
      await pool.query(
        `UPDATE wallet_debitos SET intentos = intentos + 1, ultimo_error = $2, estado = $3,
           proximo = now() + ($4 || ' minutes')::interval WHERE id = $1`,
        [d.id, (aviso + e.message + (e.detalle ? ` · ${e.detalle}` : '')).slice(0, 500),
          repetir || e.sinSaldo ? 'pendiente' : 'revisar', e.sinSaldo ? 10 : espera(d.intentos + 1)]
      );
    }
  }
  return { hechos, duplicados, revisados: rows.length };
}

// Lo que quedo 'enviando' (el worker se cayo a mitad) pasa a revisar: nunca se repite solo.
async function liberarEnviando({ minutos = 5 } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE wallet_debitos SET estado = 'revisar',
       ultimo_error = 'El envío se cortó a mitad. Puede que SÍ se haya debitado: revísalo en la plataforma antes de reintentar.'
     WHERE estado = 'enviando' AND creado < now() - ($1 || ' minutes')::interval`, [minutos]
  );
  return rowCount;
}

// ── Lo que falta descontar y el disponible para gastar ──

/**
 * Gasto que todavia no se aplico en el wallet: debitos en cola + creaciones que ya se
 * cobraron aca pero cuyo debito no se encolo todavia (estan generandose).
 * Lo recien hecho se sigue restando 30 s porque el saldo leido tiene cache de 20 s.
 */
async function pendiente(cliente = pool) {
  const { rows: [d] } = await cliente.query(
    `SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*)::int AS n FROM wallet_debitos
     WHERE estado <> 'hecho' OR hecho > now() - interval '30 seconds'`
  );
  const { rows: [g] } = await cliente.query(
    `SELECT COALESCE(SUM(precio_usd), 0) AS usd, COUNT(*)::int AS n FROM generaciones
     WHERE estado IN ('pendiente', 'enviando', 'en_proceso') AND precio_usd > 0
       AND NOT EXISTS (SELECT 1 FROM wallet_debitos w WHERE w.generacion_id = generaciones.id)`
  );
  const usd = Math.round((Number(d.usd) + Number(g.usd)) * 10000) / 10000;
  return { usd, n: d.n + g.n, enCola: d.n, enVuelo: g.n };
}

async function resumen() {
  const [s, p] = await Promise.all([leer(), pendiente()]);
  return { ...s, pendienteUsd: p.usd, pendientes: p.n, disponibleUsd: Math.round((s.saldoUsd - p.usd) * 10000) / 10000 };
}

// Debitos que necesitan una persona (dudosos o rechazados), para Super Admin.
const paraRevisar = async (limite = 50) => (await pool.query(
  `SELECT id, referencia, usd, descripcion, generacion_id, movimiento_id, por, estado, intentos, ultimo_error, creado
   FROM wallet_debitos WHERE estado = 'revisar' ORDER BY id DESC LIMIT $1`, [limite]
)).rows;

// Un humano ya comprobo en la plataforma: se reintenta (si no se debito) o se marca hecho (si si).
const reintentar = async (id) => (await pool.query(
  `UPDATE wallet_debitos SET estado = 'pendiente', proximo = now(), ultimo_error = NULL WHERE id = $1 AND estado = 'revisar'`, [Number(id) || 0]
)).rowCount > 0;
const marcarHecho = async (id, quien) => (await pool.query(
  `UPDATE wallet_debitos SET estado = 'hecho', hecho = now(), ultimo_error = concat('Marcado a mano por ', $2::text) WHERE id = $1 AND estado = 'revisar'`,
  [Number(id) || 0, String(quien || '')]
)).rowCount > 0;

module.exports = {
  solicitarRecarga, movimientos, solicitudesEnPlataforma,
  configurado, leer, olvidar, debitar, encolar, informarGasto, encolarFaltantes, procesarCola, liberarEnviando,
  pendiente, resumen, paraRevisar, reintentar, marcarHecho,
  ErrorDeWallet, MINIMO_USD, centavos,
};
