/**
 * Plataforma central de pagos SIMULADA, con el contrato de docs/pagos-contrato.md.
 * La usan las pruebas y sirve de referencia para el equipo de pagos:
 *   PAGOS_SECRETO=... PAGOS_API_KEY=... node test/mock-pagos.js 4600
 * Verifica clave, firma y timestamp, y respeta la idempotencia por referencia.
 *   GET  /saldo?cliente=   balance general
 *   POST /recargas         pasa saldo del balance general a Marketing (lo descuenta)
 *   POST /consumos         informa una generacion cobrada (NO mueve dinero)
 */
const http = require('http');
const crypto = require('crypto');

function crearMock({ apiKey, secreto, saldos = {} }) {
  const recargas = new Map(); // referencia -> { recarga_id, cliente, monto_usd, creditos }
  const consumos = new Map(); // referencia -> cuerpo
  const peticiones = [];
  const saldo = { ...saldos };
  const responder = (res, status, cuerpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
  const r4 = (n) => Math.round(n * 10000) / 10000;

  const server = http.createServer((req, res) => {
    let crudo = '';
    req.on('data', (c) => { crudo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      peticiones.push({ metodo: req.method, ruta: url.pathname, headers: req.headers, cuerpo: crudo ? JSON.parse(crudo) : null });
      if (req.headers.authorization !== `Bearer ${apiKey}`) return responder(res, 401, { error: 'no_autorizado' });
      const ts = Number(req.headers['x-nebo-timestamp']);
      const esperada = crypto.createHmac('sha256', secreto).update(`${req.headers['x-nebo-timestamp']}.${crudo}`).digest('hex');
      if (req.headers['x-nebo-firma'] !== esperada) return responder(res, 401, { error: 'firma_invalida' });
      if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return responder(res, 401, { error: 'timestamp_vencido' });
      const b = crudo ? JSON.parse(crudo) : {};

      if (req.method === 'GET' && url.pathname === '/saldo') {
        const c = url.searchParams.get('cliente');
        if (!(c in saldo)) return responder(res, 404, { error: 'cliente_desconocido' });
        return responder(res, 200, { cliente: c, saldo_usd: r4(saldo[c]), moneda: 'USD', actualizado: new Date().toISOString() });
      }
      if (req.method === 'POST' && url.pathname === '/recargas') {
        if (!b.referencia || !(b.monto_usd > 0) || !(b.cliente in saldo)) return responder(res, 400, { error: 'datos_invalidos' });
        const ya = recargas.get(b.referencia);
        if (ya) return responder(res, 200, { recarga_id: ya.recarga_id, referencia: b.referencia, estado: 'aplicada', saldo_usd: r4(saldo[b.cliente]), repetido: true });
        if (saldo[b.cliente] < b.monto_usd) return responder(res, 402, { error: 'saldo_insuficiente', saldo_usd: r4(saldo[b.cliente]) });
        saldo[b.cliente] -= b.monto_usd;
        const rc = { recarga_id: 'rc_' + crypto.randomBytes(6).toString('hex'), ...b };
        recargas.set(b.referencia, rc);
        return responder(res, 201, { recarga_id: rc.recarga_id, referencia: b.referencia, estado: 'aplicada', saldo_usd: r4(saldo[b.cliente]) });
      }
      if (req.method === 'POST' && url.pathname === '/consumos') {
        if (!b.referencia || !(b.cliente in saldo) || !b.detalle) return responder(res, 400, { error: 'datos_invalidos' });
        if (consumos.has(b.referencia)) return responder(res, 200, { referencia: b.referencia, estado: 'registrado', repetido: true });
        consumos.set(b.referencia, b);
        return responder(res, 201, { consumo_id: 'cs_' + crypto.randomBytes(6).toString('hex'), referencia: b.referencia, estado: 'registrado' });
      }
      return responder(res, 404, { error: 'ruta_desconocida' });
    });
  });
  return { server, recargas, consumos, saldo, peticiones };
}

module.exports = { crearMock };

if (require.main === module) {
  const puerto = Number(process.argv[2]) || 4600;
  const { server } = crearMock({ apiKey: process.env.PAGOS_API_KEY || 'clave', secreto: process.env.PAGOS_SECRETO || 'secreto', saldos: { jh: 100 } });
  server.listen(puerto, () => console.log(`Plataforma de pagos simulada en http://localhost:${puerto} (cliente "jh", saldo general $100)`));
}
