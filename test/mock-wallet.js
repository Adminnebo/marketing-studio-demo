/**
 * Wallet de Marketing SIMULADO (plataforma central) para pruebas y desarrollo local:
 *   GET  /api/budgets/marketing?clientId=&apiKey=   saldo
 *   POST /api/budgets/marketing/debit               debita { amount, description, reference }
 *
 * La referencia se respeta: repetirla NO cobra dos veces (es lo que esperamos del real).
 * Con `idempotente(false)` se simula lo contrario, para ver que pasaria si no lo fuera.
 *
 *   WALLET_API_KEY=... node test/mock-wallet.js 4700
 */
const http = require('http');

function crearWallet({ apiKey = 'clave-wallet', clientId = 16, saldo = 100, nombre = 'Marketing' } = {}) {
  const debitos = [];
  const peticiones = [];
  let caido = false; let modo = null; let idem = true; let lento = 0;
  const estado = { saldo };
  const responder = (res, status, cuerpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };

  const server = http.createServer((req, res) => {
    let crudo = '';
    req.on('data', (c) => { crudo += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      peticiones.push({ metodo: req.method, ruta: url.pathname, cuerpo: crudo ? JSON.parse(crudo) : null });
      if (lento) await new Promise((r) => setTimeout(r, lento));
      if (caido) return responder(res, 503, { success: false, error: 'unavailable' });

      if (req.method === 'GET' && url.pathname === '/api/budgets/marketing') {
        if (url.searchParams.get('apiKey') !== apiKey) return responder(res, 401, { success: false, error: 'Invalid API key' });
        return responder(res, 200, { success: true, name: nombre, slug: 'marketing', balance: Math.round(estado.saldo * 100) / 100, currency: 'USD' });
      }
      if (req.method === 'POST' && url.pathname === '/api/budgets/marketing/debit') {
        const b = JSON.parse(crudo || '{}');
        if (modo) return responder(res, Number(modo), { success: false, error: 'boom' });
        if (b.apiKey !== apiKey || String(b.clientId) !== String(clientId)) return responder(res, 401, { success: false, error: 'Invalid caller' });
        if (!(Number(b.amount) > 0) || !b.reference) return responder(res, 400, { success: false, error: 'Invalid request' });
        if (idem && debitos.some((d) => d.reference === b.reference)) {
          return responder(res, 409, { success: false, error: 'duplicate reference', balance: Math.round(estado.saldo * 100) / 100 });
        }
        if (estado.saldo - Number(b.amount) < 0) return responder(res, 402, { success: false, error: 'insufficient balance' });
        estado.saldo -= Number(b.amount);
        debitos.push(b);
        return responder(res, 200, { success: true, balance: Math.round(estado.saldo * 100) / 100 });
      }
      return responder(res, 404, { success: false, error: 'ruta_desconocida' });
    });
  });

  return {
    server, debitos, peticiones, estado,
    caer: (v = true) => { caido = v; },
    fallar: (status) => { modo = status; },
    idempotente: (v) => { idem = v; },
    demorar: (ms) => { lento = ms; },
    total: () => Math.round(debitos.reduce((a, d) => a + Number(d.amount), 0) * 100) / 100,
  };
}

module.exports = { crearWallet };

if (require.main === module) {
  const puerto = Number(process.argv[2]) || 4700;
  const w = crearWallet({ apiKey: process.env.WALLET_API_KEY || 'clave-wallet', saldo: Number(process.env.WALLET_SALDO) || 100 });
  w.server.listen(puerto, () => console.log(`Wallet de Marketing simulado en http://localhost:${puerto}/api/budgets/marketing (clientId 16, saldo $${w.estado.saldo})`));
}
