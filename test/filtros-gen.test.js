// Busqueda de "Mis creaciones" contra Postgres real (TEST_DATABASE_URL); se salta si no esta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { filtrosGeneraciones } = require('../server/lib/filtros-gen');

if (!process.env.TEST_DATABASE_URL) {
  test('filtros de creaciones (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  const camila = require('../server/lib/camila');
  const ids = {};
  const buscar = async (q, email = 'ana@jh.do') => {
    const { where, vals } = filtrosGeneraciones(q, { email, vals: [100] });
    return (await pool.query(`SELECT id FROM generaciones ${where} ORDER BY id DESC LIMIT $1`, vals)).rows.map((r) => Number(r.id));
  };
  const gen = async (nombre, datos) => (await pool.query(
    `INSERT INTO generaciones (creado_por, preset_id, preset_tipo, preset_nombre, entrada, estado, creado) VALUES ($1, 'p', $2, $3, $4, $5, now() - $6::interval) RETURNING id`,
    [datos.por, datos.tipo, nombre, JSON.stringify(datos.entrada || {}), datos.estado || 'completado', datos.hace || '0 days']
  )).rows[0].id;

  test.before(async () => {
    await migrar(); await camila.migrar();
    await pool.query('TRUNCATE camila_usos, pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY CASCADE');
    ids.breaker = Number(await gen('Video libre · Kling 3.0', { por: 'ana@jh.do', tipo: 'libre_video', entrada: { producto: { media_id: 'm-1', nombre: 'BREAKER 1 POLO 20A' }, params: { prompt: 'breaker on a wall' } } }));
    ids.gabinete = Number(await gen('Foto de producto', { por: 'luis@jh.do', tipo: 'product_shots', estado: 'fallido', hace: '10 days', entrada: { args: { product_media_id: 'm-2', prompt: 'metal cabinet 50% off' } } }));
    ids.otro = Number(await gen('Anuncio', { por: 'ana@jh.do', tipo: 'poster', hace: '40 days' }));
    await pool.query(`INSERT INTO camila_usos (email, codigo, descripcion, media_id) VALUES ('luis@jh.do', '305400', 'GABINETE METALICO 11 MODULOS', 'm-2')`);
  });
  test.after(() => pool.end());

  test('busca por producto, codigo de Camila, descripcion usada, persona y #numero', async () => {
    assert.deepEqual(await buscar({ q: 'breaker' }), [ids.breaker]);
    assert.deepEqual(await buscar({ q: '305400' }), [ids.gabinete]); // codigo guardado por Camila
    assert.deepEqual(await buscar({ q: 'gabinete 11' }), [ids.gabinete]); // palabra por palabra, en cualquier orden
    assert.deepEqual(await buscar({ q: 'gabinete breaker' }), []); // todas las palabras tienen que estar
    assert.deepEqual(await buscar({ q: 'luis@' }), [ids.gabinete]);
    assert.deepEqual(await buscar({ q: `#${ids.otro}` }), [ids.otro]);
    assert.deepEqual(await buscar({ q: 'breaker 20a ana' }), [ids.breaker]);
    assert.deepEqual(await buscar({ q: '50%' }), [ids.gabinete]); // % literal, no comodin
    assert.deepEqual(await buscar({ q: '%' }), [ids.gabinete]);
  });

  test('filtros de tipo, estado, fecha, autor y publicadas se combinan', async () => {
    assert.deepEqual(await buscar({ medio: 'video' }), [ids.breaker]);
    assert.deepEqual(await buscar({ medio: 'foto' }), [ids.otro, ids.gabinete]);
    assert.deepEqual(await buscar({ estado: 'fallido' }), [ids.gabinete]);
    assert.deepEqual(await buscar({ dias: '30' }), [ids.gabinete, ids.breaker]);
    assert.deepEqual(await buscar({ dias: '7' }), [ids.breaker]);
    assert.deepEqual(await buscar({ autor: 'yo' }), [ids.otro, ids.breaker]);
    assert.deepEqual(await buscar({ autor: 'yo', medio: 'foto' }), [ids.otro]);
    assert.deepEqual(await buscar({ publicadas: '1' }), []);
    assert.deepEqual(await buscar({ antes: String(ids.otro) }), [ids.gabinete, ids.breaker]);
  });
}
