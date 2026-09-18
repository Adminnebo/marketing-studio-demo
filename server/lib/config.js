/**
 * Ajustes del panel que controla el super_admin (tabla config, clave/valor).
 *  - usd_por_credito: cuanto nos cuesta 1 credito del generador (USD).
 *  - margen_pct: % de ganancia sobre el costo -> precio al cliente.
 *  - margen_por_tipo: { product_shots: 40, ugc: 25, ... } sobrescribe el % global.
 *  - limite_diario_creditos: tope de creditos por usuario y dia (0 = sin tope). No aplica al super_admin.
 *  - mostrar_precio: 1 = los usuarios ven el precio en USD al generar (si hay costo configurado).
 */
const { pool } = require('./db');

const DEFECTOS = {
  usd_por_credito: 0,
  margen_pct: 0,
  margen_por_tipo: {},
  limite_diario_creditos: 0,
  mostrar_precio: 1,
};
const NUMEROS = ['usd_por_credito', 'margen_pct', 'limite_diario_creditos', 'mostrar_precio'];

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
    return k === 'mostrar_precio' ? (n ? 1 : 0) : n;
  }
  if (k === 'margen_por_tipo') {
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('margen_por_tipo debe ser un objeto');
    const out = {};
    for (const [t, p] of Object.entries(valor)) {
      if (p === '' || p == null) continue;
      const n = Number(p);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error(`Margen inválido para ${t}`);
      out[t] = n;
    }
    return out;
  }
  throw new Error(`Ajuste desconocido: ${k}`);
}

async function guardar(cambios, quien) {
  const limpios = {};
  for (const [k, v] of Object.entries(cambios || {})) if (k in DEFECTOS) limpios[k] = validar(k, v);
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

// Costo y precio (USD) de N creditos de un tipo de plantilla, con los ajustes actuales.
function precioDe(ajustes, tipo, creditos) {
  if (creditos == null || !ajustes.usd_por_credito) return { costo: null, precio: null, margen: null };
  const margen = ajustes.margen_por_tipo?.[tipo] ?? ajustes.margen_pct;
  const costo = Number(creditos) * ajustes.usd_por_credito;
  return { costo, precio: costo * (1 + margen / 100), margen };
}

module.exports = { leer, guardar, precioDe, DEFECTOS };
