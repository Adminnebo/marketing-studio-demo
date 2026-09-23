// De punta a punta con el wallet de Marketing activo: encolar una creación descuenta del wallet
// una sola vez, las ayudas de IA se debitan con su referencia, y el camino viejo (descontar del
// saldo general de JH) NO se usa. Todo contra test/mock-wallet.js: no toca el wallet real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearWallet } = require('./mock-wallet');

if (!process.env.TEST_DATABASE_URL) {
  test('wallet de punta a punta (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  let w; let wallet; let encolarLib; let saldoMarketing; let ajustes; let pool;

  const USUARIO = { id: '00000000-0000-4000-8000-000000000001', email: 'vendedor@jh.com', rol: 'usuario', rolReal: 'usuario' };
  const SUPER = { id: '00000000-0000-4000-8000-000000000002', email: 'jorge@nebo.com', rol: 'super_admin', rolReal: 'super_admin' };
  const CREAR = { presetId: 'veo3', presetNombre: 'Veo 3', presetTipo: 'libre_video', portada: null, entrada: { tool: 'generate_video', params: {} }, creditos: 100 };

  test.before(async () => {
    w = crearWallet({ apiKey: 'clave-wallet', clientId: 16, saldo: 50 });
    await new Promise((r) => { w.server.listen(0, r); });
    process.env.WALLET_URL = `http://localhost:${w.server.address().port}/api/budgets/marketing`;
    process.env.WALLET_CLIENT_ID = '16';
    process.env.WALLET_API_KEY = 'clave-wallet';
    ({ pool } = require('../server/lib/db'));
    await require('../server/lib/db').migrar();
    saldoMarketing = require('../server/lib/saldo-marketing');
    await saldoMarketing.migrar();
    wallet = require('../server/lib/wallet');
    encolarLib = require('../server/lib/encolar');
    ajustes = require('../server/lib/config');
    // Precio: 1 crédito = $0.01 con 20 % de ganancia -> 100 créditos = $1.20.
    await ajustes.guardar({ usd_por_credito: 0.01, margen_pct: 20, costo_auto: 0, saldo_negativo_permitido: 0, informar_super_admin: 1 }, 'test');
  });
  test.beforeEach(async () => {
    await pool.query('TRUNCATE wallet_debitos, pagos_eventos, saldo_marketing, billetera, publicaciones, generaciones RESTART IDENTITY CASCADE');
    w.fallar(null); w.caer(false); w.idempotente(true);
    w.estado.saldo = 50; w.debitos.length = 0;
    wallet.olvidar(); encolarLib._limpiarCache();
  });
  test.after(async () => { w.server.close(); await pool.end(); });

  const completar = (id) => pool.query(`UPDATE generaciones SET estado = 'completado', terminado = now() WHERE id = $1`, [id]);

  test('una creación se cobra una sola vez, y del wallet', async () => {
    const r = await encolarLib.encolar(USUARIO, CREAR);
    assert.ok(r.g, r.error?.error);
    assert.equal(Number(r.g.precio_usd), 1.2);
    const { rows: [g] } = await pool.query('SELECT cobro_wallet, cobro_externo, cobro_interno FROM generaciones WHERE id = $1', [r.g.id]);
    assert.deepEqual([g.cobro_wallet, g.cobro_externo, g.cobro_interno], [true, false, false], 'se paga del wallet, no por los caminos viejos');

    // Mientras se genera, esa plata ya no está disponible (aunque no se haya debitado).
    const antes = await wallet.resumen();
    assert.equal(antes.saldoUsd, 50);
    assert.equal(antes.disponibleUsd, 48.8);
    assert.equal(w.total(), 0, 'todavía no se debitó: solo las que salen bien se cobran');

    await completar(r.g.id);
    assert.equal(await wallet.informarGasto(r.g.id), true);
    assert.equal((await wallet.procesarCola()).hechos, 1);
    assert.equal(w.total(), 1.2);
    assert.deepEqual(w.debitos[0].reference, `mkt-gen-${r.g.id}`);
    assert.match(w.debitos[0].description, /Veo 3 · libre_video · vendedor@jh.com/);

    // Ni el segundo pase ni la red de seguridad lo vuelven a cobrar.
    assert.equal(await wallet.informarGasto(r.g.id), false);
    assert.equal(await wallet.encolarFaltantes(), 0);
    assert.equal((await wallet.procesarCola()).hechos, 0);
    assert.equal(w.total(), 1.2);
    // Y el camino viejo no se usó.
    assert.equal((await pool.query('SELECT count(*)::int n FROM pagos_eventos')).rows[0].n, 0);
  });

  test('una creación que falla no se debita', async () => {
    const r = await encolarLib.encolar(USUARIO, CREAR);
    await pool.query(`UPDATE generaciones SET estado = 'fallido', terminado = now() WHERE id = $1`, [r.g.id]);
    assert.equal(await wallet.informarGasto(r.g.id), false);
    assert.equal(await wallet.encolarFaltantes(), 0);
    assert.equal(w.total(), 0);
  });

  test('sin saldo no se deja crear (contando lo que falta descontar)', async () => {
    w.estado.saldo = 2; wallet.olvidar();
    const a = await encolarLib.encolar(USUARIO, CREAR); // 1.20 de 2.00
    assert.ok(a.g);
    const b = await encolarLib.encolar(USUARIO, CREAR); // quedan 0.80: no alcanza
    assert.equal(b.status, 402);
    assert.match(b.error.error, /No te alcanza el saldo de Marketing/);
    assert.equal(b.error.sinSaldo, true);
  });

  test('las ayudas de IA se debitan con su propia referencia', async () => {
    const cobrado = await saldoMarketing.cobrarIa({ por: USUARIO.email, clase: 'descripcion', costoUsd: 0.05 });
    assert.equal(cobrado, 0.06, 'costo real más el margen');
    const { rows } = await pool.query('SELECT referencia, usd, descripcion FROM wallet_debitos');
    assert.equal(rows.length, 1);
    assert.match(rows[0].referencia, /^mkt-ia-\d+$/);
    assert.equal(Number(rows[0].usd), 0.06);
    assert.match(rows[0].descripcion, /Descripción automática/);
    assert.equal((await wallet.procesarCola()).hechos, 1);
    assert.equal(w.total(), 0.06);
  });

  test('una ayuda de IA de menos de un centavo no se cobra', async () => {
    await saldoMarketing.cobrarIa({ por: USUARIO.email, clase: 'caption', costoUsd: 0.002 });
    assert.equal((await pool.query('SELECT count(*)::int n FROM wallet_debitos')).rows[0].n, 0, 'no se manda un débito de $0.00');
    // Pero sí queda anotado en el registro, para que el total de IA del mes cuadre.
    const { rows } = await pool.query(`SELECT usd FROM saldo_marketing WHERE tipo = 'ia'`);
    assert.equal(rows.length, 1);
    assert.ok(Number(rows[0].usd) < 0);
  });

  test('un super admin no gasta su saldo, pero su creación sí se informa', async () => {
    const r = await encolarLib.encolar(SUPER, CREAR);
    assert.ok(r.g);
    const { rows: [g] } = await pool.query('SELECT cobro_wallet FROM generaciones WHERE id = $1', [r.g.id]);
    assert.equal(g.cobro_wallet, true, 'con informar_super_admin activo se debita igual');
    await completar(r.g.id);
    assert.equal(await wallet.informarGasto(r.g.id), true);
    // Con el ajuste apagado, la de un super admin no se marca para debitar.
    await ajustes.guardar({ informar_super_admin: 0 }, 'test');
    const r2 = await encolarLib.encolar(SUPER, CREAR);
    const { rows: [g2] } = await pool.query('SELECT cobro_wallet FROM generaciones WHERE id = $1', [r2.g.id]);
    assert.equal(g2.cobro_wallet, false);
    await completar(r2.g.id);
    assert.equal(await wallet.informarGasto(r2.g.id), false);
    await ajustes.guardar({ informar_super_admin: 1 }, 'test');
  });

  test('si el wallet no responde, no se crea nada y no se cobra', async () => {
    w.caer(true); wallet.olvidar();
    const r = await encolarLib.encolar(USUARIO, CREAR);
    assert.equal(r.status, 503);
    assert.match(r.error.error, /no se te cobró nada/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM generaciones')).rows[0].n, 0);
  });
}
