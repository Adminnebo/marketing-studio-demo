/**
 * Encolar una generacion: saldo de la cuenta del generador, tope diario por
 * usuario, foto de costo/precio y cobro a la billetera del panel (los super_admin
 * no pagan). La billetera se recarga desde el saldo general de la plataforma
 * central de pagos (lib/pagos.js), y lo cobrado se le informa al terminar.
 * Devuelve { g } o { status, error } para responder.
 */
const { pool } = require('./db');
const hf = require('./higgsfield');
const ajustes = require('./config');
const billetera = require('./billetera');

// Creditos de la cuenta del generador (cache 30 s). null si no se pudo leer: no se bloquea por eso.
let _saldoProv = { v: null, exp: 0 };
async function saldoProveedor() {
  if (_saldoProv.exp > Date.now()) return _saldoProv.v;
  const v = await hf.llamar('balance', {}).then((d) => (d?.credits != null ? Number(d.credits) : null)).catch(() => null);
  _saldoProv = { v, exp: Date.now() + 30e3 };
  return v;
}

async function encolar(user, { presetId, presetNombre, presetTipo, portada, entrada, creditos }) {
  // Si la cuenta del generador no alcanza, se avisa ya y no se encola (fallaria al enviarse).
  const prov = await saldoProveedor();
  if (prov != null && Number(creditos) > 0 && prov < Number(creditos)) {
    console.log(`[encolar] cuenta del generador sin creditos: ${prov} < ${creditos} (${user.email})`);
    return { status: 503, error: { sinCreditosProveedor: true, error: user.rolReal === 'super_admin'
      ? `La cuenta del generador tiene ${prov} créditos y esto usa ${creditos}. Recarga la cuenta del proveedor.`
      : 'El servicio de generación se quedó sin créditos por ahora. Avísale al administrador; no se te cobró nada.' } };
  }
  const a = await ajustes.leer();
  if (a.limite_diario_creditos > 0 && user.rolReal !== 'super_admin') {
    const { rows: [u] } = await pool.query(
      `SELECT COALESCE(SUM(creditos_estimados), 0) AS usados FROM generaciones
       WHERE user_id = $1 AND estado <> 'fallido'
         AND (creado AT TIME ZONE 'America/Santo_Domingo')::date = (now() AT TIME ZONE 'America/Santo_Domingo')::date`,
      [user.id]
    );
    if (Number(u.usados) + (Number(creditos) || 0) > a.limite_diario_creditos) {
      return { status: 429, error: { error: 'Llegaste al límite de uso de hoy. Pídele a un super admin que lo amplíe.' } };
    }
  }
  const pr = ajustes.precioDe(a, presetTipo, creditos);
  // En "ver como" el super_admin prueba con permisos de usuario, pero no gasta la billetera de JH.
  const cobra = user.rolReal !== 'super_admin';
  if (cobra && !(Number(creditos) > 0)) {
    return { status: 400, error: { error: 'No se pudo calcular el costo. Espera a que cargue e intenta de nuevo.' } };
  }
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [g] } = await cli.query(
      `INSERT INTO generaciones (creado_por, user_id, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados,
         usd_por_credito, margen_pct, costo_usd, precio_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [user.email, user.id, presetId, presetNombre, presetTipo, portada, entrada, creditos,
        a.usd_por_credito || null, pr.margen, pr.costo, pr.precio]
    );
    if (cobra) await billetera.cobrar(cli, { generacionId: g.id, creditos: Number(creditos), usd: pr.precio, por: user.email });
    await cli.query('COMMIT');
    // Al navegador no le llegan el costo ni el margen (solo lo ve el super_admin en Consumo).
    const { costo_usd: _c, margen_pct: _m, usd_por_credito: _u, error_detalle: _e, ...publico } = g; // eslint-disable-line no-unused-vars
    return { g: publico };
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    if (e.saldo) return { status: 402, error: { error: e.message + ' Recarga créditos para continuar.', sinSaldo: true } };
    throw e;
  } finally {
    cli.release();
  }
}

function _limpiarCache() { _saldoProv = { v: null, exp: 0 }; }

module.exports = { encolar, _limpiarCache };
