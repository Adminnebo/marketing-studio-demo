/**
 * Plataforma de pagos SIMULADA para pruebas y desarrollo local:
 *   GET  /api/credits/balance?clientId=&apiKey=   saldo de JH (mismo formato que Sword AI)
 *   POST /consumos                                gasto de una generacion (PROPUESTA, firmado e
 *                                                 idempotente; descuenta del saldo)
 *   SALDO_API_KEY=... PAGOS_API_KEY=... PAGOS_SECRETO=... node test/mock-pagos.js 4600
 */
const http = require('http');
const crypto = require('crypto');

function crearMock({ apiKeySaldo, apiKey, secreto, clientes = {} }) {
  const consumos = new Map();
  const peticiones = [];
  const saldo = Object.fromEntries(Object.entries(clientes).map(([id, c]) => [id, c.saldo]));
  const responder = (res, status, cuerpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
  let caido = false;

  const server = http.createServer((req, res) => {
    let crudo = '';
    req.on('data', (c) => { crudo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      peticiones.push({ metodo: req.method, ruta: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, cuerpo: crudo ? JSON.parse(crudo) : null });
      if (caido) return responder(res, 503, { error: 'caido' });

      if (req.method === 'GET' && url.pathname === '/api/credits/balance') {
        const id = url.searchParams.get('clientId');
        if (url.searchParams.get('apiKey') !== apiKeySaldo) return responder(res, 401, { success: false, error: 'Invalid API key' });
        if (!(id in saldo)) return responder(res, 404, { success: false, error: 'Client not found' });
        const s = Math.round(saldo[id] * 100) / 100;
        return responder(res, 200, { success: true, clientId: Number(id), email: clientes[id].email, name: clientes[id].nombre, credits: s, balance: s, currency: 'USD', autoRechargeEnabled: false, autoRechargeThreshold: 30 });
      }
      if (req.method === 'POST' && url.pathname === '/consumos') {
        if (req.headers.authorization !== `Bearer ${apiKey}`) return responder(res, 401, { error: 'no_autorizado' });
        const esperada = crypto.createHmac('sha256', secreto).update(`${req.headers['x-nebo-timestamp']}.${crudo}`).digest('hex');
        if (req.headers['x-nebo-firma'] !== esperada) return responder(res, 401, { error: 'firma_invalida' });
        const b = JSON.parse(crudo || '{}');
        if (!b.referencia || !b.detalle || !(String(b.cliente) in saldo)) return responder(res, 400, { error: 'datos_invalidos' });
        if (consumos.has(b.referencia)) return responder(res, 200, { referencia: b.referencia, estado: 'registrado', repetido: true });
        consumos.set(b.referencia, b);
        saldo[String(b.cliente)] -= Number(b.monto_usd) || 0;
        return responder(res, 201, { referencia: b.referencia, estado: 'registrado' });
      }
      return responder(res, 404, { error: 'ruta_desconocida' });
    });
  });
  return { server, consumos, saldo, peticiones, caer: (v = true) => { caido = v; } };
}

module.exports = { crearMock };

if (require.main === module) {
  const puerto = Number(process.argv[2]) || 4600;
  const { server } = crearMock({
    apiKeySaldo: process.env.SALDO_API_KEY || 'clave-saldo', apiKey: process.env.PAGOS_API_KEY || 'clave', secreto: process.env.PAGOS_SECRETO || 'secreto',
    clientes: { 16: { saldo: 50, nombre: 'JH Electroalambres', email: 'jh@example.com' } },
  });
  server.listen(puerto, () => console.log(`Plataforma de pagos simulada en http://localhost:${puerto} (clientId 16, saldo $50)`));
}
