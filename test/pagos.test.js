// Saldo externo (plataforma de pagos de Nebo) como saldo para generar, y gasto informado.
// Contra la plataforma simulada (test/mock-pagos.js). Requiere TEST_DATABASE_URL (se salta si no esta).
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearMock } = require('./mock-pagos');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('pagos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = URL_BD;
  Object.assign(process.env, { SALDO_CLIENT_ID: '16', SALDO_API_KEY: 'clave-saldo', PAGOS_API_KEY: 'clave-test', PAGOS_SECRETO: 'secreto-test', PAGOS_CLIENTE: '16' });
  let estadoJob = 'in_progress';
  const hf = require('../server/lib/higgsfield');
  hf.llamar = async (tool) => {
    if (tool === 'balance') return { credits: 5000 };
    if (tool === 'marketing_studio_v2_status') return { jobs: [{ id: 'job-1', status: estadoJob, result_url: estadoJob === 'completed' ? 'https://cdn/v.mp4' : null }] };
    throw new Error('herramienta inesperada ' + tool);
  };
  const { pool, migrar } = require('../server/lib/db');
  const ajustes = require('../server/lib/config');
  const billetera = require('../server/lib/billetera');
  const saldoExterno = require('../server/lib/saldo-externo');
  const pagos = require('../server/lib/pagos');
  const { encolar } = require('../server/lib/encolar');
  const w = require('../server/worker');

  const mock = crearMock({ apiKeySaldo: 'clave-saldo', apiKey: 'clave-test', secreto: 'secreto-test', clientes: { 16: { saldo: 5, nombre: 'JH Electroalambres', email: 'jh@x.com' } } });
  const usuario = { id: '11111111-1111-4111-8111-111111111111', email: 'vendedor@jh.com', nombre: 'Vendedor', rolReal: 'usuario' };
  const video = () => ({
    presetId: 'cinematic_studio_video_4_0', presetNombre: 'Cinema Studio 4.0', presetTipo: 'libre_video', portada: null, creditos: 35,
    entrada: {
      tool: 'cli', params: { model: 'cinematic_studio_video_4_0', prompt: 'breaker', duration: 5, aspect_ratio: '9:16', resolution: '720p', generate_audio: true },
      libre: { modelo: 'cinematic_studio_video_4_0', aspecto: '9:16', duracion: 5, opciones: { resolution: '720p', generate_audio: true }, promptAuto: true },
      producto: { media_id: 'm1', url: 'https://cdn/breaker.png', nombre: 'breaker.png' },
    },
  }); // 35 creditos x 0.0624 = $2.184
  const fila = (id) => pool.query('SELECT * FROM generaciones WHERE id = $1', [id]).then((r) => r.rows[0]);
  async function terminar(id, estado = 'completed') {
    await pool.query(`UPDATE generaciones SET estado = 'en_proceso', hf_job_ids = '{job-1}', enviado = now() - interval '90 seconds', revisado = NULL, entrada = entrada - 'tool' WHERE id = $1`, [id]);
    estadoJob = estado;
    await w.revisarEnProceso();
  }
  const conPagos = async (fn) => { process.env.PAGOS_URL = `http://localhost:${mock.server.address().port}`; try { return await fn(); } finally { delete process.env.PAGOS_URL; } };

  test.before(async () => {
    await new Promise((r) => mock.server.listen(0, r));
    process.env.SALDO_API_URL = `http://localhost:${mock.server.address().port}/api/credits/balance`;
    await migrar();
    await pool.query('TRUNCATE pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY');
    await ajustes.guardar({ costo_auto: 0, usd_por_credito: 0.052, margen_pct: 20, saldo_negativo_permitido: 0 }, 'test');
  });
  test.beforeEach(() => saldoExterno.olvidar());
  test.after(async () => { mock.server.close(); await pool.end(); });

  test('lee el saldo de la plataforma con clientId y apiKey (la clave no sale del servidor)', async () => {
    const r = await saldoExterno.resumen();
    assert.equal(r.saldoUsd, 5);
    assert.equal(r.nombre, 'JH Electroalambres');
    assert.equal(r.moneda, 'USD');
    assert.deepEqual(r.autoRecarga, { activa: false, umbralUsd: 30 });
    assert.equal(r.pendienteUsd, 0);
    assert.equal(r.disponibleUsd, 5);
    const pet = mock.peticiones.at(-1);
    assert.deepEqual(pet.query, { clientId: '16', apiKey: 'clave-saldo' });
  });

  test('cobra contra el saldo externo: lo creado queda pendiente de descontar y baja el disponible', async () => {
    const r = await encolar(usuario, video());
    assert.ok(r.g, JSON.stringify(r.error));
    const g = await fila(r.g.id);
    assert.equal(g.cobro_externo, true);
    assert.equal(Number(g.precio_usd), 2.184);
    assert.equal(await billetera.saldo(), 0, 'la billetera local no se toca');
    const s = await saldoExterno.resumen();
    assert.equal(s.pendienteUsd, 2.184);
    assert.equal(s.disponibleUsd, 2.816);
  });

  test('sin saldo disponible no crea (tampoco gastando dos veces lo pendiente)', async () => {
    const r2 = await encolar(usuario, video()); // 2.816 disponible >= 2.184
    assert.ok(r2.g);
    const r3 = await encolar(usuario, video()); // 0.632 disponible < 2.184
    assert.equal(r3.status, 402);
    assert.match(r3.error.error, /tienes \$0\.63 disponibles y esto cuesta \$2\.18/);
  });

  test('lo que falla deja de contar como pendiente', async () => {
    const { rows: [g] } = await pool.query(`SELECT id FROM generaciones WHERE cobro_externo ORDER BY id DESC LIMIT 1`);
    await terminar(g.id, 'failed');
    assert.equal((await fila(g.id)).estado, 'fallido');
    assert.equal((await saldoExterno.resumen()).pendienteUsd, 2.184);
  });

  test('saldo negativo permitido: deja crear hasta ese limite', async () => {
    mock.saldo[16] = -10;
    let r = await encolar(usuario, video());
    assert.equal(r.status, 402);
    assert.match(r.error.error, /tienes -\$12\.18 disponibles/);
    await ajustes.guardar({ saldo_negativo_permitido: 20 }, 'test');
    r = await encolar(usuario, video());
    assert.ok(r.g, 'con $20 de margen negativo si puede');
    await ajustes.guardar({ saldo_negativo_permitido: 0 }, 'test');
    mock.saldo[16] = 5;
  });

  test('plataforma caida: no crea y no cobra (503)', async () => {
    mock.caer();
    const r = await encolar(usuario, video());
    mock.caer(false);
    assert.equal(r.status, 503);
    assert.match(r.error.error, /No se pudo verificar tu saldo/);
  });

  test('super_admin no paga ni consulta el saldo', async () => {
    const n = mock.peticiones.length;
    const r = await encolar({ ...usuario, rolReal: 'super_admin' }, video());
    assert.equal((await fila(r.g.id)).cobro_externo, false);
    assert.equal(mock.peticiones.length, n);
  });

  test('gasto informado (endpoint propuesto): una vez, con detalle, y sale de pendiente', async () => {
    await pool.query(`UPDATE generaciones SET estado = 'fallido' WHERE cobro_externo`);
    const r = await encolar(usuario, video());
    await conPagos(async () => {
      await terminar(r.g.id);
      await pagos.procesarCola();
      await pagos.procesarCola();
    });
    const c = mock.consumos.get(`mkt-gen-${r.g.id}`);
    assert.ok(c);
    assert.equal(mock.peticiones.filter((p) => p.ruta === '/consumos').length, 1);
    assert.equal(c.monto_usd, 2.184);
    assert.equal(c.detalle.duracion_s, 5);
    assert.equal(c.detalle.calidad, '720p');
    assert.equal(c.detalle.resultados[0].url, 'https://cdn/v.mp4');
    assert.ok((await fila(r.g.id)).gasto_informado, 'marcado como informado');
    saldoExterno.olvidar();
    const s = await saldoExterno.resumen();
    assert.equal(s.pendienteUsd, 0, 'ya se descontó alla: no se resta dos veces');
    assert.equal(s.saldoUsd, 2.82);
  });

  test('sin el endpoint de gasto configurado no se envia nada', async () => {
    const r = await encolar(usuario, video());
    await terminar(r.g.id);
    assert.deepEqual(await pagos.procesarCola(), { hechos: 0 });
    assert.equal((await fila(r.g.id)).gasto_informado, null);
  });
}
