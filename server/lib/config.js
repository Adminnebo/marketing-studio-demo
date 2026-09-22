/**
 * Ajustes del panel que controla el super_admin (tabla config, clave/valor).
 *  - costo_auto: 1 = el worker actualiza solo el costo por credito con los precios del proveedor.
 *  - usd_por_credito: cuanto nos cuesta 1 credito (USD). Con costo_auto, el del paquete de recarga MAS CARO (conservador).
 *  - costo_info: { fuente, actualizado, paquetes: [{ creditos, usd }] } ultima lectura de precios.
 *  - margen_pct: % de ganancia sobre el costo -> precio por credito para JH.
 *  - limite_diario_creditos: tope de creditos por usuario y dia (0 = sin tope). No aplica al super_admin.
 *  - saldo_negativo_permitido: con saldo externo, hasta cuantos USD por debajo de cero se deja crear
 *    (0 = solo con saldo positivo que cubra el costo).
 *  - informar_super_admin: 1 = las creaciones de super admins tambien se descuentan del saldo de JH en la
 *    plataforma de pagos (con la marca "super admin" en la nota; por defecto). 0 = no se informan.
 */
const { pool } = require('./db');

const DEFECTOS = {
  costo_auto: 1,
  usd_por_credito: 0,
  costo_info: null,
  margen_pct: 0,
  limite_diario_creditos: 0,
  saldo_negativo_permitido: 0,
  informar_super_admin: 1, // todo lo de super admins tambien se cobra a JH (pedido 2026-09-22)
};
const NUMEROS = ['costo_auto', 'usd_por_credito', 'margen_pct', 'limite_diario_creditos', 'saldo_negativo_permitido', 'informar_super_admin'];

let _cache = null;
async function leer() {
  if (_cache && _cache.exp > Date.now()) return _cache.v;
  const { rows } = await pool.query(`SELECT clave, valor FROM config WHERE clave LIKE 'ajuste:%'`);
  const v = { ...DEFECTOS };
  for (const r of rows) {
    const k = r.clave.slice(7);
    if (!(k in DEFECTOS)) continue;
    try { v[k] = JSON.parse(r.valor); } catch { /* valor roto: queda el defecto */ }
  }
  _cache = { v, exp: Date.now() + 10e3 };
  return v;
}

function validar(k, valor) {
  if (NUMEROS.includes(k)) {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${k}`);
    if (k === 'margen_pct' && n > 1000) throw new Error('El margen no puede pasar de 1000 %');
    return k === 'costo_auto' || k === 'informar_super_admin' ? (n ? 1 : 0) : n;
  }
  if (k === 'costo_info') return valor;
  throw new Error(`Ajuste desconocido: ${k}`);
}

async function guardar(cambios, quien, { internos = false } = {}) {
  const limpios = {};
  for (const [k, v] of Object.entries(cambios || {})) {
    if (!(k in DEFECTOS)) continue;
    if (k === 'costo_info' && !internos) continue; // solo lo escribe el worker
    limpios[k] = validar(k, v);
  }
  for (const [k, v] of Object.entries(limpios)) {
    await pool.query(
      `INSERT INTO config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
      ['ajuste:' + k, JSON.stringify(v)]
    );
  }
  _cache = null;
  if (Object.keys(limpios).length) console.log(`[ajustes] ${quien} cambio`, JSON.stringify(limpios));
  return leer();
}

// Precio de 1 credito para JH (USD) con los ajustes actuales, o null si no hay costo.
const precioCredito = (a) => (a.usd_por_credito > 0 ? a.usd_por_credito * (1 + a.margen_pct / 100) : null);

// Costo y precio (USD) de N creditos.
function precioDe(a, _tipo, creditos) {
  const pc = precioCredito(a);
  if (creditos == null || pc == null) return { costo: null, precio: null, margen: null };
  return { costo: Number(creditos) * a.usd_por_credito, precio: Number(creditos) * pc, margen: a.margen_pct };
}

module.exports = { leer, guardar, precioDe, precioCredito, DEFECTOS };
