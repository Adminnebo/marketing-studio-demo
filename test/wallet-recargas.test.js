// Pedir recargas al panel central de Nebo y seguir su estado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearWallet } = require('./mock-wallet');

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; // el wallet lee su cola de la base

const CLAVE = 'clave-wallet';
let w; let puerto;
test.before(async () => {
  w = crearWallet({ apiKey: CLAVE, saldo: 50 });
  await new Promise((r) => w.server.listen(0, r));
  puerto = w.server.address().port;
  process.env.WALLET_URL = `http://localhost:${puerto}/api/budgets/marketing`;
  process.env.WALLET_CLIENT_ID = '16';
  process.env.WALLET_API_KEY = CLAVE;
});
test.after(() => w.server.close());

test('la solicitud llega con su referencia y queda esperando', async () => {
  const wallet = require('../server/lib/wallet');
  const r = await wallet.solicitarRecarga({ usd: 100, descripcion: 'Campaña de octubre · pedida por ana@jh.do', referencia: 'mkt-rec-7' });
  assert.equal(r.estado, 'pending');
  assert.equal(r.id, 1);
  const enviado = w.peticiones.at(-1).cuerpo;
  assert.equal(enviado.amount, 100);
  assert.equal(enviado.reference, 'mkt-rec-7');
  assert.equal(enviado.clientId, 16);
  assert.match(enviado.description, /Campaña de octubre/);
});

test('pedir lo mismo dos veces no crea dos solicitudes', async () => {
  const wallet = require('../server/lib/wallet');
  const r = await wallet.solicitarRecarga({ usd: 100, descripcion: 'otra vez', referencia: 'mkt-rec-7' });
  assert.equal(r.duplicada, true);
  assert.equal(w.solicitudes.length, 1);
});

test('se lee el estado, el monto aprobado y la nota de quien decidió', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const wallet = require('../server/lib/wallet');
  assert.deepEqual((await wallet.solicitudesEnPlataforma()).map((s) => [s.referencia, s.estado]), [['mkt-rec-7', 'pending']]);
  w.decidir('mkt-rec-7', { aprobado: 60, nota: 'Va la mitad por ahora' });
  const [s] = await wallet.solicitudesEnPlataforma();
  assert.equal(s.estado, 'approved');
  assert.equal(s.aprobadoUsd, 60);
  assert.equal(s.nota, 'Va la mitad por ahora');
  assert.equal((await wallet.resumen()).saldoUsd, 110); // el saldo subió allá
});

test('si la plataforma no responde, se avisa que no se pidió nada', async () => {
  const wallet = require('../server/lib/wallet');
  w.caer(true);
  await assert.rejects(wallet.solicitarRecarga({ usd: 10, referencia: 'mkt-rec-8' }), (e) => e.seguro === true);
  w.caer(false);
  assert.equal(w.solicitudes.length, 1);
});

if (process.env.TEST_DATABASE_URL) {
  test('lo decidido en el panel de Nebo se refleja en la solicitud de aquí', async () => {
    const { pool, migrar } = require('../server/lib/db');
    const sm = require('../server/lib/saldo-marketing');
    const wallet = require('../server/lib/wallet');
    await migrar(); await sm.migrar();
    await pool.query('TRUNCATE solicitudes_recarga RESTART IDENTITY CASCADE');
    sm._probar({ activo: true });
    const a = await sm.solicitar({ montoUsd: 100, motivo: 'Campaña', por: 'ana@jh.do' });
    const b = await sm.solicitar({ montoUsd: 40, motivo: 'Fotos', por: 'luis@jh.do' });
    await wallet.solicitarRecarga({ usd: 100, referencia: `mkt-rec-${a.id}` });
    await wallet.solicitarRecarga({ usd: 40, referencia: `mkt-rec-${b.id}` });
    w.decidir(`mkt-rec-${a.id}`, { aprobado: 80, nota: 'Aprobado parcial' });
    w.decidir(`mkt-rec-${b.id}`, { estado: 'rejected', nota: 'Este mes no' });
    assert.equal(await sm.revisarSolicitudesEnWallet(await wallet.solicitudesEnPlataforma()), 2);
    const mias = await sm.solicitudes({ limite: 10 });
    assert.deepEqual(mias.map((s) => [s.id, s.estado]), [[b.id, 'rechazada'], [a.id, 'aprobada']]);
    assert.match(mias.find((s) => s.id === a.id).nota, /por 80 USD · Aprobado parcial/);
    assert.match(mias.find((s) => s.id === b.id).nota, /Rechazada en el panel de Nebo · Este mes no/);
    assert.equal(await sm.revisarSolicitudesEnWallet(await wallet.solicitudesEnPlataforma()), 0); // ya no hay nada abierto
    sm._probar();
    await pool.end();
  });
}
