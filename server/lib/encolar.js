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
const saldoExterno = require('./saldo-externo');
const saldoMarketing = require('./saldo-marketing');
const wallet = require('./wallet');

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
  // Sin residuos de coma flotante (2.1839999... -> 2.184): es lo que se cobra y se informa.
  const r4 = (n) => (n == null ? n : Math.round(Number(n) * 10000) / 10000);
  pr.precio = r4(pr.precio); pr.costo = r4(pr.costo);
  // En "ver como" el super_admin prueba con permisos de usuario, pero no gasta la billetera de JH.
  const cobra = user.rolReal !== 'super_admin';
  if (cobra && !(Number(creditos) > 0)) {
    return { status: 400, error: { error: 'No se pudo calcular el costo. Espera a que cargue e intenta de nuevo.' } };
  }
  // Con saldo de Marketing (lib/saldo-marketing.js) se cobra de ahi; si no, contra el saldo de la
  // plataforma de pagos o la billetera del panel.
  const conWallet = wallet.configurado();
  const interno = cobra && !conWallet && saldoMarketing.activo();
  const externo = cobra && !conWallet && !interno && saldoExterno.configurado();
  // El gasto de super admins se debita igual si el ajuste informar_super_admin esta activo.
  const debitaWallet = conWallet && (cobra || Number(a.informar_super_admin) === 1);
  if (conWallet && cobra && !(Number(pr.precio) > 0)) {
    return { status: 400, error: { error: 'Todavía no hay precio configurado para cobrar esta creación. Avísale al administrador.' } };
  }
  let saldoWallet = null;
  if (conWallet && cobra) {
    try { saldoWallet = await wallet.leer(); } catch (e) {
      console.error('[wallet] no se pudo leer el saldo:', e.message);
      return { status: 503, error: { error: 'No se pudo verificar el saldo de Marketing. Intenta de nuevo en un momento; no se te cobró nada.' } };
    }
  }
  if (interno && !(Number(pr.precio) > 0)) return { status: 400, error: { error: 'Todavía no hay precio configurado para cobrar esta creación. Avísale al administrador.' } };
  let saldoLeido = null;
  if (externo) {
    if (!(Number(pr.precio) > 0)) return { status: 400, error: { error: 'Todavía no hay precio configurado para cobrar esta creación. Avísale al administrador.' } };
    try { saldoLeido = await saldoExterno.leer(); } catch (e) {
      console.error('[saldo] no se pudo leer:', e.message);
      return { status: 503, error: { error: 'No se pudo verificar tu saldo. Intenta de nuevo en un momento; no se te cobró nada.' } };
    }
  }
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    if (saldoWallet) {
      // Un solo cobro a la vez: dos creaciones simultaneas no gastan la misma plata.
      await cli.query('SELECT pg_advisory_xact_lock(4711)');
      const p = await wallet.pendiente(cli);
      const disponible = r4(saldoWallet.saldoUsd - p.usd);
      if (disponible - Number(pr.precio) < -Number(a.saldo_negativo_permitido || 0)) {
        await cli.query('ROLLBACK');
        return { status: 402, error: { sinSaldo: true, error: `No te alcanza el saldo de Marketing: tienes ${formatoUsd(disponible)} disponibles y esto cuesta ${formatoUsd(pr.precio)}. Pide una recarga en Créditos.` } };
      }
    }
    if (interno) {
      await saldoMarketing.bloquear(cli);
      const disponible = await saldoMarketing.saldo(cli);
      if (disponible - Number(pr.precio) < -Number(a.saldo_negativo_permitido || 0)) {
        await cli.query('ROLLBACK');
        return { status: 402, error: { sinSaldo: true, error: `No te alcanza el saldo de Marketing: tienes ${formatoUsd(disponible)} y esto cuesta ${formatoUsd(pr.precio)}. Pide una recarga en Créditos.` } };
      }
    }
    if (externo) {
      // Un solo cobro a la vez: dos creaciones simultaneas no gastan la misma plata.
      await cli.query('SELECT pg_advisory_xact_lock(4711)');
      const p = await saldoExterno.pendiente(cli);
      const disponible = saldoLeido.saldoUsd - p.usd;
      if (disponible - Number(pr.precio) < -Number(a.saldo_negativo_permitido || 0)) {
        await cli.query('ROLLBACK');
        return { status: 402, error: { sinSaldo: true, error: `No te alcanza el saldo: tienes ${formatoUsd(disponible)} disponibles y esto cuesta ${formatoUsd(pr.precio)}. Recarga para continuar.` } };
      }
    }
    const { rows: [g] } = await cli.query(
      `INSERT INTO generaciones (creado_por, user_id, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados,
         usd_por_credito, margen_pct, costo_usd, precio_usd, cobro_externo, cobro_interno, cobro_wallet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [user.email, user.id, presetId, presetNombre, presetTipo, portada, entrada, creditos,
        a.usd_por_credito || null, pr.margen, pr.costo, pr.precio, externo, interno, debitaWallet]
    );
    if (interno || (conWallet && cobra)) await saldoMarketing.cobrarGeneracion(cli, { generacionId: g.id, usd: pr.precio, por: user.email, concepto: presetNombre });
    else if (cobra && !externo) await billetera.cobrar(cli, { generacionId: g.id, creditos: Number(creditos), usd: pr.precio, por: user.email });
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

const formatoUsd = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function _limpiarCache() { _saldoProv = { v: null, exp: 0 }; }

module.exports = { encolar, _limpiarCache };
