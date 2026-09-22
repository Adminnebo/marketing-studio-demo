// Prueba del worker contra Postgres real con Higgsfield simulado.
// Requiere TEST_DATABASE_URL (se salta si no esta). Usa una BD aparte.
const test = require('node:test');
const assert = require('node:assert/strict');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('worker (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = URL_BD;
  const hf = require('../server/lib/higgsfield');
  const llamadas = [];
  let estados = {};
  let crearFalla = null;
  hf.llamar = async (tool, args) => {
    llamadas.push([tool, args]);
    if (tool === 'media_import_url') return { media_id: 'avatar-media' };
    if (tool === 'marketing_studio_v2_create') {
      if (crearFalla) throw crearFalla;
      return { job_ids: ['11111111-1111-4111-8111-111111111111'] };
    }
    if (tool === 'marketing_studio_v2_status') {
      return { jobs: args.job_ids.map((id) => ({ id, status: estados[id] || 'in_progress', result_url: estados[id] === 'completed' ? 'https://cdn/x.png' : null, min_result_url: null, job_set_type: 'marketing_studio_2_image' })) };
    }
    throw new Error('herramienta inesperada ' + tool);
  };
  const { pool, migrar } = require('../server/lib/db');
  const w = require('../server/worker');

  const insertar = (tipo, extra = {}) => pool.query(
    `INSERT INTO generaciones (creado_por, preset_id, preset_nombre, preset_tipo, entrada) VALUES ('t@x', 'p1', 'P', $1, $2) RETURNING id`,
    [tipo, { args: { preset_id: 'p1', preset_type: tipo, product_media_id: 'm1' }, ...extra }]
  ).then((r) => r.rows[0].id);
  const fila = (id) => pool.query('SELECT * FROM generaciones WHERE id = $1', [id]).then((r) => r.rows[0]);

  test.before(async () => { await migrar(); await pool.query('TRUNCATE pagos_eventos, billetera, publicaciones, generaciones CASCADE'); });
  test.after(() => pool.end());

  test('pendiente -> en_proceso -> completado', async () => {
    const id = await insertar('product_shots');
    await w.tomarPendientes();
    let g = await fila(id);
    assert.equal(g.estado, 'en_proceso');
    assert.deepEqual(g.hf_job_ids, ['11111111-1111-4111-8111-111111111111']);
    const [, args] = llamadas.find(([t]) => t === 'marketing_studio_v2_create');
    assert.equal(args.product_media_id, 'm1');

    await w.revisarEnProceso();
    assert.equal((await fila(id)).estado, 'en_proceso');

    estados['11111111-1111-4111-8111-111111111111'] = 'completed';
    await pool.query('UPDATE generaciones SET revisado = NULL WHERE id = $1', [id]);
    await w.revisarEnProceso();
    g = await fila(id);
    assert.equal(g.estado, 'completado');
    assert.equal(g.resultados[0].url, 'https://cdn/x.png');
  });

  test('product_shots_people con avatar importa la imagen del avatar', async () => {
    llamadas.length = 0;
    await insertar('product_shots_people', { avatar: { id: 'a1', type: 'preset', preview_url: 'https://cdn/a.webp' } });
    await w.tomarPendientes();
    const [, args] = llamadas.find(([t]) => t === 'marketing_studio_v2_create');
    assert.equal(args.avatar_media_id, 'avatar-media');
    assert.equal(llamadas[0][1].url, 'https://cdn/a.webp');
  });

  test('nsfw -> fallido con motivo claro', async () => {
    const id = await insertar('ads');
    estados = { '11111111-1111-4111-8111-111111111111': 'nsfw' };
    await pool.query("UPDATE generaciones SET estado = 'en_proceso', hf_job_ids = '{11111111-1111-4111-8111-111111111111}', enviado = now() WHERE id = $1", [id]);
    await w.revisarEnProceso();
    const g = await fila(id);
    assert.equal(g.estado, 'fallido');
    assert.match(g.error, /filtro de seguridad/);
    assert.equal(g.error_detalle, "estados: nsfw");
  });

  test('error de create -> fallido; desconexion -> vuelve a pendiente', async () => {
    await pool.query("UPDATE generaciones SET estado = 'completado' WHERE estado <> 'completado'");
    crearFalla = new hf.HiggsfieldError('marketing_studio_v2_create: preset invalido');
    const a = await insertar('ads');
    await w.tomarPendientes();
    assert.equal((await fila(a)).estado, 'fallido');

    crearFalla = new hf.HiggsfieldError('token', { desconectado: true });
    const b = await insertar('ads');
    await w.tomarPendientes();
    assert.equal((await fila(b)).estado, 'pendiente');
    crearFalla = null;
  });

  test('enviando atascada se marca fallida y no se reenvia', async () => {
    const id = await insertar('ads');
    await pool.query("UPDATE generaciones SET estado = 'enviando', enviado = now() - interval '11 minutes' WHERE id = $1", [id]);
    await w.liberarAtascadas();
    const g = await fila(id);
    assert.equal(g.estado, 'fallido');
    assert.match(g.error, /avísale al administrador/);
  });
}
