/**
 * Creditos con saldo de Marketing (lib/saldo-marketing.js): saldo y movimientos del
 * departamento, pedir recarga, y para quien puede aprobar: saldo general de JH y
 * solicitudes abiertas (aprobar, rechazar o confirmar las que quedaron en revision).
 * Si el saldo de Marketing no esta activo, GET /creditos sigue a la ruta de siempre.
 */
const express = require('express');
const saldoMarketing = require('./lib/saldo-marketing');
const saldoExterno = require('./lib/saldo-externo');
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

router.get('/creditos', ruta(async (req, res, next) => {
  if (!saldoMarketing.activo()) return next();
  const [a, saldo, gasto, movimientos, mias] = await Promise.all([
    ajustes.leer(), saldoMarketing.saldo(), saldoMarketing.gastoDelMes(), saldoMarketing.movimientos(60), saldoMarketing.solicitudes({ por: req.user.email, limite: 10 }),
  ]);
  const r = { fuente: 'marketing', saldoUsd: saldo, gastoMes: gasto, movimientos, misSolicitudes: mias, precioCredito: ajustes.precioCredito(a), puedeAprobar: !!req.user.puedeAprobar };
  if (req.user.puedeAprobar) {
    if (req.query.fresco) saldoExterno.olvidar();
    r.abiertas = await saldoMarketing.solicitudes({ abiertas: true, limite: 50 });
    r.pagoUrl = saldoExterno.URL_PAGO();
    try { const g = await saldoExterno.resumen(); r.general = { saldoUsd: g.saldoUsd, disponibleUsd: g.disponibleUsd, pendienteUsd: g.pendienteUsd, nombre: g.nombre }; }
    catch (e) { console.error('[saldo general]', e.message); r.general = { error: 'No se pudo leer el saldo general de JH.' }; }
  }
  res.json(r);
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

module.exports = { router };
