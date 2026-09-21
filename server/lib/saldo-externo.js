/**
 * Saldo de JH en la plataforma de pagos de Nebo (Sword AI): es el saldo con el que
 * se genera. Marketing no tiene saldo propio cuando esto esta configurado.
 *
 *   GET {SALDO_API_URL}?clientId={SALDO_CLIENT_ID}&apiKey={SALDO_API_KEY}
 *   -> { success, clientId, name, email, credits, balance, currency: 'USD',
 *        autoRechargeEnabled, autoRechargeThreshold }
 *
 * La clave va solo en el servidor (variables de Railway): nunca llega al navegador.
 *
 * Lo gastado en Marketing se descuenta alla con el endpoint de gasto (pendiente de que
 * lo entreguen). Mientras un gasto no se informo, se resta aca del saldo leido: asi el
 * "disponible" no deja gastar dos veces la misma plata en el intervalo.
 */
const { pool } = require('./db');

const URL_SALDO = () => process.env.SALDO_API_URL || 'https://app.swordaisolutions.com/api/credits/balance';
const CLIENTE = () => process.env.SALDO_CLIENT_ID || '';
const CLAVE = () => process.env.SALDO_API_KEY || '';
// Pagina de pago de JH (se muestra embebida en Creditos para recargar).
const URL_PAGO = () => process.env.PAGO_URL || 'https://lmconsultingai.com/pay/d88e8d1ea5e5ff6ce37d500263adc1a75117da6b5e968bd9?embed=1';

class SaldoError extends Error {}

const configurado = () => !!(CLIENTE() && CLAVE());

let _cache = { v: null, exp: 0 };
async function leer({ fresco = false } = {}) {
  if (!configurado()) throw new SaldoError('El saldo externo no está configurado');
  if (!fresco && _cache.exp > Date.now()) return _cache.v;
  const url = new URL(URL_SALDO());
  url.searchParams.set('clientId', CLIENTE());
  url.searchParams.set('apiKey', CLAVE());
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
  } catch (e) {
    throw new SaldoError(`sin respuesta (${e.message})`);
  }
  const j = await r.json().catch(() => ({}));
  const saldo = Number(j.balance ?? j.credits);
  if (!r.ok || j.success === false || !Number.isFinite(saldo)) {
    throw new SaldoError(`respuesta inesperada: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  }
  const v = {
    saldoUsd: saldo, moneda: j.currency || 'USD', nombre: j.name || null, email: j.email || null,
    autoRecarga: { activa: !!j.autoRechargeEnabled, umbralUsd: j.autoRechargeThreshold != null ? Number(j.autoRechargeThreshold) : null },
    leido: new Date().toISOString(),
  };
  _cache = { v, exp: Date.now() + 20e3 };
  return v;
}
const olvidar = () => { _cache.exp = 0; };

// Gastado en Marketing que todavia no se descontó alla (se informa con el endpoint de gasto).
async function pendiente(cliente = pool) {
  const { rows: [r] } = await cliente.query(
    `SELECT COALESCE(SUM(precio_usd), 0) AS usd, COUNT(*)::int AS n FROM generaciones
     WHERE cobro_externo AND gasto_informado IS NULL AND estado <> 'fallido'`
  );
  return { usd: Math.round(Number(r.usd) * 10000) / 10000, n: r.n };
}

// Saldo, lo pendiente de descontar y lo disponible para crear.
async function resumen() {
  const [s, p] = await Promise.all([leer(), pendiente()]);
  return { ...s, pendienteUsd: p.usd, pendientes: p.n, disponibleUsd: Math.round((s.saldoUsd - p.usd) * 10000) / 10000 };
}

module.exports = { configurado, leer, olvidar, pendiente, resumen, SaldoError, URL_PAGO };
