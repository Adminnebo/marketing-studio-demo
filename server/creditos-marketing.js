/**
 * Creditos con saldo de Marketing (lib/saldo-marketing.js): saldo y movimientos del
 * departamento, pedir recarga, y para quien puede aprobar: saldo general de JH y
 * solicitudes abiertas (aprobar, rechazar o confirmar las que quedaron en revision).
 * Si el saldo de Marketing no esta activo, GET /creditos sigue a la ruta de siempre.
 */
const express = require('express');
const saldoMarketing = require('./lib/saldo-marketing');
const saldoExterno = require('./lib/saldo-externo');
const wallet = require('./lib/wallet');
const ajustes = require('./lib/config');

const router = express.Router();

const ruta = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof saldoMarketing.SaldoMarketingError) return res.status(e.status).json({ error: e.message });
    console.error(`[${req.method} ${req.originalUrl}]`, e.message);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
};
const soloAprobador = (req, res, next) => (req.user.puedeAprobar ? next()
  : res.status(403).json({ error: 'Tu usuario no puede aprobar recargas.' }));

// Con el wallet de la plataforma central: el saldo sale de alla y los movimientos de aqui
// (el registro local sigue siendo el detalle de que se gasto y quien lo gasto).
router.get('/creditos', ruta(async (req, res, next) => {
  if (wallet.configurado()) {
    if (req.query.fresco) wallet.olvidar();
    const [a, gasto, movimientos] = await Promise.all([
      ajustes.leer(), saldoMarketing.gastoDelMes(), saldoMarketing.movimientos(60, { conJh: req.user.rol === 'super_admin' }),
    ]);
    const r = {
      fuente: 'wallet', gastoMes: gasto, movimientos, precioCredito: ajustes.precioCredito(a),
      puedeAprobar: !!req.user.puedeAprobar, puedeFijar: req.user.rol === 'super_admin',
    };
    try {
      const w = await wallet.resumen();
      Object.assign(r, { saldoUsd: w.saldoUsd, disponibleUsd: w.disponibleUsd, pendienteUsd: w.pendienteUsd, nombre: w.nombre, leido: w.leido });
    } catch (e) {
      console.error('[wallet]', e.message);
      r.errorSaldo = 'No se pudo leer el saldo del wallet de Marketing. Intenta de nuevo en un momento.';
    }
    if (req.user.puedeAprobar) r.porRevisar = await wallet.paraRevisar(20);
    return res.json(r);
  }
  if (!saldoMarketing.activo()) return next();
  const [a, saldo, gasto, movimientos, mias] = await Promise.all([
    ajustes.leer(), saldoMarketing.saldo(), saldoMarketing.gastoDelMes(), saldoMarketing.movimientos(60, { conJh: req.user.rol === 'super_admin' }), saldoMarketing.solicitudes({ por: req.user.email, limite: 10 }),
  ]);
  const r = { fuente: 'marketing', saldoUsd: saldo, gastoMes: gasto, movimientos, misSolicitudes: mias, precioCredito: ajustes.precioCredito(a), puedeAprobar: !!req.user.puedeAprobar, puedeFijar: req.user.rol === 'super_admin' };
  if (req.user.puedeAprobar) {
    if (req.query.fresco) saldoExterno.olvidar();
    r.abiertas = await saldoMarketing.solicitudes({ abiertas: true, limite: 50 });
    r.pagoUrl = saldoExterno.URL_PAGO();
    try { const g = await saldoExterno.resumen(); r.general = { saldoUsd: g.saldoUsd, disponibleUsd: g.disponibleUsd, pendienteUsd: g.pendienteUsd, nombre: g.nombre }; }
    catch (e) { console.error('[saldo general]', e.message); r.general = { error: 'No se pudo leer el saldo general de JH.' }; }
  }
  res.json(r);
}));

// Debito dudoso: una persona lo comprueba en la plataforma y decide. No se toca solo.
router.post('/creditos/wallet/:id/:accion', soloAprobador, ruta(async (req, res) => {
  if (!wallet.configurado()) return res.status(400).json({ error: 'El wallet de Marketing no está configurado.' });
  const { id, accion } = req.params;
  const ok = accion === 'reintentar' ? await wallet.reintentar(id)
    : accion === 'hecho' ? await wallet.marcarHecho(id, req.user.email)
      : null;
  if (ok === null) return res.status(400).json({ error: 'Acción desconocida.' });
  if (!ok) return res.status(404).json({ error: 'Ese débito ya no está para revisar.' });
  console.log(`[wallet] ${req.user.email} marcó el débito #${id} como ${accion}`);
  res.json({ ok: true });
}));

router.post('/creditos/solicitudes', ruta(async (req, res) => {
  if (!saldoMarketing.activo()) return res.status(400).json({ error: 'Las recargas por solicitud no están activas.' });
  const s = await saldoMarketing.solicitar({ montoUsd: Number(req.body?.monto), motivo: req.body?.motivo, por: req.user.email });
  console.log(`[saldo-mkt] ${req.user.email} pidio una recarga de ${s.monto_usd} USD (#${s.id})`);
  res.status(201).json(s);
}));

router.post('/creditos/solicitudes/:id/aprobar', soloAprobador, ruta(async (req, res) => {
  res.json(await saldoMarketing.aprobar(Number(req.params.id), { por: req.user.email, nota: String(req.body?.nota || '').slice(0, 300) || null }));
}));

router.post('/creditos/solicitudes/:id/rechazar', soloAprobador, ruta(async (req, res) => {
  res.json(await saldoMarketing.rechazar(Number(req.params.id), { por: req.user.email, nota: req.body?.nota }));
}));

router.post('/creditos/solicitudes/:id/revision', soloAprobador, ruta(async (req, res) => {
  res.json(await saldoMarketing.resolverRevision(Number(req.params.id), { por: req.user.email, aplicada: req.body?.aplicada === true }));
}));

// Super admin: fijar el saldo de Marketing (solo el registro interno; no toca el saldo general).
router.post('/creditos/fijar', ruta(async (req, res) => {
  if (req.user.rol !== 'super_admin') return res.status(403).json({ error: 'Solo un super admin puede fijar el saldo.' });
  if (!saldoMarketing.activo()) return res.status(400).json({ error: 'El saldo de Marketing no está activo.' });
  const r = await saldoMarketing.fijarSaldo({ objetivoUsd: Number(req.body?.saldo), motivo: req.body?.motivo, por: req.user.email });
  console.log(`[saldo-mkt] ${req.user.email} fijo el saldo de Marketing: ${r.antes} -> ${r.saldoUsd} USD`);
  res.json(r);
}));

module.exports = { router };
