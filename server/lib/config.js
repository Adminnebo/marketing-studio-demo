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
 *  - logo_auto: 1 = a cada creacion terminada se le pone sola la marca de agua con el logo por defecto.
 *  - logo_tam / logo_margen / logo_opacidad: % del ancho, % del ancho y % de opacidad del logo.
 *  - logo_pos_vertical / logo_pos_resto: esquina en 9:16 y en el resto de formatos (lib/marca.js).
 *  - reintento_moderacion: cuantas veces se reintenta sola una creacion que el filtro de contenido
 *    rechazo (nsfw o copyright), corrigiendo el prompt (lib/reintento.js). 0 = apagado.
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
  reintento_moderacion: 1, // un reintento con el prompt corregido si el filtro rechaza (pedido 2026-09-22)
  logo_auto: 1, // marca de agua automatica en todo lo nuevo (pedido 2026-09-23)
  logo_tam: 16,
  logo_margen: 4,
  logo_opacidad: 90,
  logo_pos_vertical: 'arriba-izq', // en vertical las redes tapan abajo (botones y texto del post)
  logo_pos_resto: 'abajo-der',
};
const POSICIONES = ['arriba-izq', 'arriba-der', 'abajo-izq', 'abajo-der', 'centro'];
const NUMEROS = ['costo_auto', 'usd_por_credito', 'margen_pct', 'limite_diario_creditos', 'saldo_negativo_permitido', 'informar_super_admin', 'reintento_moderacion', 'logo_auto', 'logo_tam', 'logo_margen', 'logo_opacidad'];

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
    if (k === 'reintento_moderacion' && n > 3) throw new Error('Como máximo 3 reintentos automáticos');
    if (k === 'logo_tam' && (n < 3 || n > 60)) throw new Error('El logo va entre 3 % y 60 % del ancho');
    if (k === 'logo_margen' && n > 25) throw new Error('El margen no puede pasar del 25 %');
    if (k === 'logo_opacidad' && (n < 5 || n > 100)) throw new Error('La opacidad va entre 5 % y 100 %');
    return ['costo_auto', 'informar_super_admin', 'logo_auto'].includes(k) ? (n ? 1 : 0) : n;
  }
  if (k === 'costo_info') return valor;
  if (k === 'logo_pos_vertical' || k === 'logo_pos_resto') {
    if (!POSICIONES.includes(valor)) throw new Error('Esquina inválida para el logo');
    return valor;
  }
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
