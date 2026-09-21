/**
 * Plataforma de pagos SIMULADA para pruebas y desarrollo local:
 *   GET  /api/credits/balance?clientId=&apiKey=   saldo de JH (mismo formato que Sword AI)
 *   POST /api/credits/adjust                      descuenta (o suma) saldo (mismo formato que Sword AI)
 *   SALDO_API_KEY=... AJUSTE_CALLER_ID=14 AJUSTE_API_KEY=... node test/mock-pagos.js 4600
 */
const http = require('http');

function crearMock({ apiKeySaldo, callerId, apiKey, clientes = {} }) {
  const ajustes = [];
  let modo = null; // '500' | '503' para simular fallas del ajuste
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
      if (req.method === 'POST' && url.pathname === '/api/credits/adjust') {
        const b = JSON.parse(crudo || '{}');
        if (modo === '500') return responder(res, 500, { success: false, error: 'Internal error' });
        if (modo === '503') return responder(res, 503, { success: false, error: 'Unavailable' });
        if (b.callerId !== callerId || b.apiKey !== apiKey) return responder(res, 401, { success: false, error: 'Invalid caller' });
        if (!(String(b.clientId) in saldo) || !(Number(b.amount) > 0) || !['add', 'subtract'].includes(b.operation)) return responder(res, 400, { success: false, error: 'Invalid request' });
        saldo[String(b.clientId)] += (b.operation === 'subtract' ? -1 : 1) * Number(b.amount);
        ajustes.push(b);
        return responder(res, 200, { success: true, clientId: b.clientId, newBalance: Math.round(saldo[String(b.clientId)] * 100) / 100 });
      }
      return responder(res, 404, { error: 'ruta_desconocida' });
    });
  });
  return { server, ajustes, saldo, peticiones, caer: (v = true) => { caido = v; }, fallarAjuste: (m) => { modo = m; } };
}

module.exports = { crearMock };

if (require.main === module) {
  const puerto = Number(process.argv[2]) || 4600;
  const { server } = crearMock({
    apiKeySaldo: process.env.SALDO_API_KEY || 'clave-saldo', callerId: Number(process.env.AJUSTE_CALLER_ID || 14), apiKey: process.env.AJUSTE_API_KEY || 'clave-ajuste',
    clientes: { 16: { saldo: 50, nombre: 'JH Electroalambres', email: 'jh@example.com' } },
  });
  server.listen(puerto, () => console.log(`Plataforma de pagos simulada en http://localhost:${puerto} (clientId 16, saldo $50)`));
}
