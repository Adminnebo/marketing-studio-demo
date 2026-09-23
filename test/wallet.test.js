// Wallet de Marketing en la plataforma central (lib/wallet.js): saldo, débitos y la cola.
// Nada toca el wallet real: todo va contra test/mock-wallet.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearWallet } = require('./mock-wallet');

if (!process.env.TEST_DATABASE_URL) {
  test('wallet (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  let w; let wallet;

  test.before(async () => {
    await migrar();
    w = crearWallet({ apiKey: 'clave-wallet', clientId: 16, saldo: 50 });
    await new Promise((r) => { w.server.listen(0, r); });
    process.env.WALLET_URL = `http://localhost:${w.server.address().port}/api/budgets/marketing`;
    process.env.WALLET_CLIENT_ID = '16';
    process.env.WALLET_API_KEY = 'clave-wallet';
    wallet = require('../server/lib/wallet');
  });
  test.beforeEach(async () => {
    await pool.query('TRUNCATE wallet_debitos RESTART IDENTITY');
    w.fallar(null); w.caer(false); w.idempotente(true); w.demorar(0);
    w.estado.saldo = 50; w.debitos.length = 0;
    wallet.olvidar();
  });
  test.after(async () => { w.server.close(); await pool.end(); });

  test('lee el saldo del wallet', async () => {
    const s = await wallet.leer({ fresco: true });
    assert.equal(s.saldoUsd, 50);
    assert.equal(s.moneda, 'USD');
    assert.equal(s.nombre, 'Marketing');
  });

  test('debita con referencia y descripción', async () => {
    const r = await wallet.debitar({ usd: 0.5, descripcion: 'Generación', referencia: 'mkt-gen-1' });
    assert.equal(r.duplicada, false);
    assert.equal(r.saldoUsd, 49.5);
    assert.deepEqual(w.debitos[0], { clientId: 16, apiKey: 'clave-wallet', amount: 0.5, description: 'Generación', reference: 'mkt-gen-1' });
  });

  test('la misma referencia dos veces no cobra dos veces', async () => {
    await wallet.debitar({ usd: 1, descripcion: 'Generación', referencia: 'mkt-gen-7' });
    const r2 = await wallet.debitar({ usd: 1, descripcion: 'Generación', referencia: 'mkt-gen-7' });
    assert.equal(r2.duplicada, true, 'el segundo se reconoce como repetido');
    assert.equal(w.total(), 1, 'solo se cobró una vez');
  });

  test('sin saldo avisa y no es culpa nuestra', async () => {
    w.estado.saldo = 0.2;
    await assert.rejects(() => wallet.debitar({ usd: 5, descripcion: 'x', referencia: 'mkt-gen-8' }), (e) => {
      assert.equal(e.sinSaldo, true);
      assert.equal(e.seguro, true, 'no se debitó nada: se puede reintentar');
      return true;
    });
  });

  test('centavos: lo que redondea a cero no se manda', async () => {
    assert.equal(wallet.centavos(0.017), 0.02);
    assert.equal(await wallet.encolar({ referencia: 'mkt-ia-1', usd: 0.0032, descripcion: 'Caption' }), false, 'menos de un centavo no se cobra');
    assert.equal(await wallet.encolar({ referencia: 'mkt-ia-2', usd: 0.017, descripcion: 'Descripción' }), true);
    const { rows } = await pool.query('SELECT referencia, usd FROM wallet_debitos ORDER BY id');
    assert.deepEqual(rows.map((r) => r.referencia), ['mkt-ia-2']);
    assert.equal(Number(rows[0].usd), 0.02, 'se guarda redondeado a centavos, igual que lo que se manda');
  });

  test('la cola no puede encolar dos veces la misma referencia', async () => {
    assert.equal(await wallet.encolar({ referencia: 'mkt-gen-9', usd: 1, descripcion: 'a' }), true);
    assert.equal(await wallet.encolar({ referencia: 'mkt-gen-9', usd: 1, descripcion: 'a' }), false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_debitos')).rows[0].n, 1);
  });

  test('procesar la cola: debita, marca hecho y anota el gasto en la creación', async () => {
    const { rows: [g] } = await pool.query(
      `INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado, precio_usd)
       VALUES ('v@jh','veo3','libre_video','{}','completado', 1.25) RETURNING id`
    );
    await wallet.encolar({ referencia: `mkt-gen-${g.id}`, usd: 1.25, descripcion: 'Veo 3 · 10 s', generacionId: g.id, por: 'v@jh' });
    const r = await wallet.procesarCola();
    assert.deepEqual([r.hechos, r.duplicados], [1, 0]);
    assert.equal(w.total(), 1.25);
    const { rows: [d] } = await pool.query('SELECT estado, hecho, intentos FROM wallet_debitos');
    assert.equal(d.estado, 'hecho');
    assert.ok(d.hecho);
    const { rows: [gen] } = await pool.query('SELECT gasto_informado FROM generaciones WHERE id = $1', [g.id]);
    assert.ok(gen.gasto_informado, 'la creación queda marcada como ya descontada');
    assert.equal((await wallet.procesarCola()).hechos, 0, 'no se vuelve a mandar');
  });

  test('un fallo pasajero se reintenta solo; el dudoso queda para revisar', async () => {
    await wallet.encolar({ referencia: 'mkt-gen-20', usd: 2, descripcion: 'a' });
    w.fallar(503);                       // 503: no llegó a procesarse
    await wallet.procesarCola();
    let { rows: [d] } = await pool.query('SELECT estado, intentos, ultimo_error FROM wallet_debitos');
    assert.equal(d.estado, 'pendiente', 'se reintenta solo');
    assert.equal(d.intentos, 1);
    assert.doesNotMatch(d.ultimo_error, /SÍ se haya debitado/);

    w.fallar(500);                       // 500: pudo haberse aplicado
    await pool.query('UPDATE wallet_debitos SET proximo = now()');
    await wallet.procesarCola();
    ({ rows: [d] } = await pool.query('SELECT estado, ultimo_error FROM wallet_debitos'));
    assert.equal(d.estado, 'revisar', 'lo dudoso no se repite solo');
    assert.match(d.ultimo_error, /SÍ se haya debitado/);
    assert.equal(w.total(), 0);

    // Una persona comprueba en la plataforma y decide.
    const [id] = (await pool.query('SELECT id FROM wallet_debitos')).rows.map((x) => x.id);
    assert.equal((await wallet.paraRevisar()).length, 1);
    assert.equal(await wallet.reintentar(id), true);
    w.fallar(null);
    assert.equal((await wallet.procesarCola()).hechos, 1);
    assert.equal(w.total(), 2);
  });

  test('marcar hecho a mano cuando sí se debitó allá', async () => {
    await wallet.encolar({ referencia: 'mkt-gen-21', usd: 3, descripcion: 'a' });
    w.fallar(500);
    await wallet.procesarCola();
    const [id] = (await pool.query('SELECT id FROM wallet_debitos')).rows.map((x) => x.id);
    assert.equal(await wallet.marcarHecho(id, 'jorge@nebo.com'), true);
    const { rows: [d] } = await pool.query('SELECT estado, ultimo_error FROM wallet_debitos');
    assert.equal(d.estado, 'hecho');
    assert.match(d.ultimo_error, /Marcado a mano por jorge@nebo.com/);
    w.fallar(null);
    assert.equal((await wallet.procesarCola()).hechos, 0, 'ya no se manda');
  });

  test('lo cortado a mitad queda para revisar, nunca se repite solo', async () => {
    await pool.query(`INSERT INTO wallet_debitos (referencia, usd, descripcion, estado, creado) VALUES ('mkt-gen-30', 4, 'a', 'enviando', now() - interval '10 minutes')`);
    assert.equal(await wallet.liberarEnviando(), 1);
    const { rows: [d] } = await pool.query('SELECT estado, ultimo_error FROM wallet_debitos');
    assert.equal(d.estado, 'revisar');
    assert.match(d.ultimo_error, /se cortó a mitad/);
  });

  test('disponible = saldo menos lo que falta descontar (en cola y generándose)', async () => {
    const { rows: [g] } = await pool.query(
      `INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado, precio_usd)
       VALUES ('v@jh','veo3','libre_video','{}','en_proceso', 4) RETURNING id`
    );
    await wallet.encolar({ referencia: 'mkt-ia-50', usd: 1, descripcion: 'Descripción' });
    const p = await wallet.pendiente();
    assert.equal(p.usd, 5, 'el video en proceso (4) más el débito en cola (1)');
    assert.deepEqual([p.enCola, p.enVuelo], [1, 1]);
    const r = await wallet.resumen();
    assert.equal(r.saldoUsd, 50);
    assert.equal(r.disponibleUsd, 45, 'no deja gastar dos veces la misma plata');
    // Cuando el débito de esa creación se encola, deja de contarse dos veces.
    await wallet.encolar({ referencia: `mkt-gen-${g.id}`, usd: 4, descripcion: 'Veo 3', generacionId: g.id });
    assert.equal((await wallet.pendiente()).usd, 5);
  });

  test('si el wallet no responde, leer falla claro y no se inventa saldo', async () => {
    w.caer(true);
    wallet.olvidar();
    await assert.rejects(() => wallet.leer({ fresco: true }), /respuesta inesperada|sin respuesta/);
  });
}
