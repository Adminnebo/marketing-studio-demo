// Clasificacion automatica con una IA simulada (TEST_DATABASE_URL; se salta si no esta).
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('clasificar (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.OPENAI_API_KEY = 'sk-prueba';
  const { pool, migrar } = require('../server/lib/db');
  const clasificar = require('../server/lib/clasificar');
  const { enriquecer } = require('../server/lib/catalogo');

  test.before(async () => { await migrar(); await pool.query('TRUNCATE plantillas_clasif'); });
  test.after(() => pool.end());

  test('portada de video usa el poster; sin https no hay imagen', () => {
    assert.equal(clasificar.imagenDe({ cover_image: { type: 'video', url: 'https://x/v.mp4', poster_url: 'https://x/p.webp' } }), 'https://x/p.webp');
    assert.equal(clasificar.imagenDe({ cover_image: { url: 'http://x/a.png' } }), null);
  });

  test('clasifica solo las nuevas, guarda y el catalogo las toma', async () => {
    const pedidos = [];
    const fetch = async (url, o) => {
      pedidos.push(JSON.parse(o.body));
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ p: 'tecnologia', e: ['estudio', 'estudio', 'oscuro_lujo'], per: false, jh: 9 }) }] }] }) };
    };
    const items = [
      { id: 'vieja', name: 'A', type: 'ads', cover_image: { url: 'https://x/a.png' }, _clasif: true },
      { id: 'nueva', name: 'B', type: 'product_shots', cover_image: { url: 'https://x/b.png' }, _clasif: false },
    ];
    const r = await clasificar.clasificarNuevas(items, { fetch });
    assert.deepEqual({ hechas: r.hechas, pendientes: r.pendientes }, { hechas: 1, pendientes: 0 });
    assert.equal(r.uso.modelo, "gpt-4.1"); // tokens de la IA para registrar el costo
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].input[0].content[0].image_url, 'https://x/b.png');
    const { rows: [f] } = await pool.query("SELECT * FROM plantillas_clasif WHERE id = 'nueva'");
    assert.deepEqual(f.e, ['estudio', 'oscuro_lujo']);
    assert.equal(f.jh, 9);
    const e = enriquecer({ id: 'nueva', type: 'product_shots', cover_image: {} }, 0, { nueva: { p: f.p, e: f.e, per: f.per, jh: f.jh, auto: true } });
    assert.equal(e._jh, 9);
    assert.equal(e._auto, true);
  });
}
