// Logos de la marca de agua (tabla en Postgres). Se salta sin TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('logos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  const logos = require('../server/lib/logos');
  const bytes = (n, b = 1) => Buffer.alloc(n, b);

  test.before(async () => { await migrar(); await logos.migrar(); await pool.query('TRUNCATE logos RESTART IDENTITY'); });
  test.after(() => pool.end());

  test('el primero queda como el de siempre; el segundo no', async () => {
    const a = await logos.guardar({ nombre: 'JH', version: 'claro', bytes: bytes(120), mime: 'image/png', por: 'ana@jh.do' });
    assert.equal(a.por_defecto, true);
    assert.equal(a.tiene_claro, true);
    assert.equal(a.tiene_oscuro, false);
    const b = await logos.guardar({ nombre: 'JH blanco', version: 'claro', bytes: bytes(80), mime: 'image/png', por: 'ana@jh.do' });
    assert.equal(b.por_defecto, false);
    assert.equal((await logos.porDefecto()).id, a.id);
    assert.equal((await logos.lista()).length, 2);
  });

  test('se le añade la otra versión al mismo logo', async () => {
    const l = await logos.guardar({ id: 1, version: 'oscuro', bytes: bytes(150, 2), mime: 'image/png', por: 'ana@jh.do' });
    assert.equal(l.tiene_oscuro, true);
    const v = await logos.versiones(1);
    assert.equal(v.claro.length, 120);
    assert.equal(v.oscuro.length, 150);
    assert.equal((await logos.archivo(1, 'oscuro')).bytes.length, 150);
  });

  test('cambiar el de siempre deja uno solo marcado', async () => {
    await logos.marcarDefecto(2);
    const l = await logos.lista();
    assert.deepEqual(l.map((x) => [x.id, x.por_defecto]), [[2, true], [1, false]]);
  });

  test('no acepta cualquier archivo', async () => {
    await assert.rejects(logos.guardar({ nombre: 'x', bytes: bytes(10), mime: 'application/pdf', por: 'a@b' }), /PNG, WEBP o JPG/);
    await assert.rejects(logos.guardar({ nombre: 'x', bytes: Buffer.alloc(3 * 1024 * 1024), mime: 'image/png', por: 'a@b' }), /2 MB/);
  });

  test('borrar una versión deja el logo; borrar la otra lo borra y pasa el defecto al que queda', async () => {
    const queda = await logos.borrar(1, { version: 'claro' });
    assert.equal(queda.tiene_claro, false);
    assert.equal(queda.tiene_oscuro, true);
    assert.equal(await logos.borrar(1, { version: 'oscuro' }), null);
    await logos.borrar(2);
    assert.deepEqual(await logos.lista(), []);
  });
}
