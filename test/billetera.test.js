// Billetera contra Postgres real (TEST_DATABASE_URL); se salta si no esta.
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('billetera (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  const b = require('../server/lib/billetera');
  const gen = () => pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada) VALUES ('t@x','p','ads','{}') RETURNING id`).then((r) => r.rows[0].id);
  const cobrar = async (id, cr) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await b.cobrar(c, { generacionId: id, creditos: cr, usd: cr * 0.06, por: 't@x' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };

  test.before(async () => { await migrar(); await pool.query('TRUNCATE pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY'); });
  test.after(() => pool.end());

  test('sin saldo no cobra', async () => {
    const id = await gen();
    await assert.rejects(cobrar(id, 10), (e) => e.saldo === true);
    assert.equal(await b.saldo(), 0);
  });

  test('recarga, cobro y reembolso unico', async () => {
    await b.recargaManual({ creditos: 100, usd: 6.24, nota: 'prueba', por: 'super@x' });
    const id = await gen();
    await cobrar(id, 30);
    assert.equal(await b.saldo(), 70);
    await assert.rejects(cobrar(id, 30)); // no se cobra dos veces la misma generacion
    assert.equal(await b.reembolsar(id), 30);
    assert.equal(await b.reembolsar(id), 0);
    assert.equal(await b.saldo(), 100);
    const tipos = (await b.movimientos()).map((m) => m.tipo);
    assert.deepEqual(tipos, ['reembolso', 'consumo', 'recarga']);
  });

  test('cobros simultaneos no gastan el mismo saldo', async () => {
    await pool.query('TRUNCATE billetera');
    await b.recargaManual({ creditos: 50, por: 'super@x' });
    const [a, c] = [await gen(), await gen()];
    const r = await Promise.allSettled([cobrar(a, 40), cobrar(c, 40)]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await b.saldo(), 10);
  });
}
