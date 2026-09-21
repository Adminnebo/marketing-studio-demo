// Plataforma central de pagos contra la plataforma simulada (test/mock-pagos.js): recargas desde
// el saldo general y consumos informados. Requiere TEST_DATABASE_URL (se salta si no esta).
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearMock } = require('./mock-pagos');

const URL_BD = process.env.TEST_DATABASE_URL;
if (!URL_BD) {
  test('pagos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = URL_BD;
  Object.assign(process.env, { PAGOS_API_KEY: 'clave-test', PAGOS_SECRETO: 'secreto-test', PAGOS_CLIENTE: 'jh' });
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
  const pagos = require('../server/lib/pagos');
  const { encolar } = require('../server/lib/encolar');
  const w = require('../server/worker');

  const mock = crearMock({ apiKey: 'clave-test', secreto: 'secreto-test', saldos: { jh: 50 } });
  const usuario = { id: '11111111-1111-4111-8111-111111111111', email: 'vendedor@jh.com', nombre: 'Vendedor', rolReal: 'usuario' };
  const PRECIO = 0.0624; // 0.052 x 1.2
  const video = () => ({
    presetId: 'cinematic_studio_video_4_0', presetNombre: 'Cinema Studio 4.0', presetTipo: 'libre_video', portada: null, creditos: 35,
    entrada: {
      tool: 'cli', params: { model: 'cinematic_studio_video_4_0', prompt: 'breaker sobre fondo negro', duration: 5, aspect_ratio: '9:16', resolution: '720p', generate_audio: true },
      libre: { modelo: 'cinematic_studio_video_4_0', aspecto: '9:16', duracion: 5, opciones: { resolution: '720p', generate_audio: true }, promptAuto: true },
      producto: { media_id: 'm1', url: 'https://cdn/breaker.png', nombre: 'breaker.png' },
    },
  });
  const fila = (id) => pool.query('SELECT * FROM generaciones WHERE id = $1', [id]).then((r) => r.rows[0]);
  const eventos = (id) => pool.query('SELECT * FROM pagos_eventos WHERE generacion_id = $1', [id]).then((r) => r.rows);
  // Simula que el worker la mando y el generador la termino.
  async function terminar(id, estado = 'completed') {
    await pool.query(`UPDATE generaciones SET estado = 'en_proceso', hf_job_ids = '{job-1}', enviado = now() - interval '90 seconds', revisado = NULL, entrada = entrada - 'tool' WHERE id = $1`, [id]);
    estadoJob = estado;
    await w.revisarEnProceso();
  }

  test.before(async () => {
    await new Promise((r) => mock.server.listen(0, r));
    process.env.PAGOS_URL = `http://localhost:${mock.server.address().port}`;
    await pool.query('DROP TABLE IF EXISTS pagos_eventos'); // la BD de pruebas pudo tener una version anterior
    await migrar();
    await pool.query('TRUNCATE pagos_eventos, recargas_central, billetera, publicaciones, generaciones RESTART IDENTITY');
    await ajustes.guardar({ costo_auto: 0, usd_por_credito: 0.052, margen_pct: 20 }, 'test');
  });
  test.after(async () => { mock.server.close(); await pool.end(); });

  test('recarga: descuenta del saldo general y suma los creditos a Marketing, firmada e idempotente', async () => {
    const r = await pagos.recargar({ montoUsd: 10, precioCredito: PRECIO, usuario });
    assert.equal(r.estado, 'aplicada');
    assert.equal(Number(r.creditos), 160.2); // 10 / 0.0624 = 160.25 -> 160.2
    assert.equal(mock.saldo.jh, 40);
    assert.equal(await billetera.saldo(), 160.2);
    const pet = mock.peticiones.find((p) => p.ruta === '/recargas');
    assert.equal(pet.headers['idempotency-key'], r.referencia);
    assert.equal(pet.cuerpo.creditos, 160.2);
    assert.equal(pet.cuerpo.precio_credito_usd, PRECIO);
    assert.equal(pet.cuerpo.usuario.email, 'vendedor@jh.com');
    // Repetir la misma referencia no descuenta ni suma otra vez.
    await pool.query(`UPDATE recargas_central SET estado = 'pendiente' WHERE referencia = $1`, [r.referencia]);
    await pagos.aplicarRecarga(r.referencia);
    assert.equal(mock.saldo.jh, 40);
    assert.equal(await billetera.saldo(), 160.2, 'la fila ya estaba aplicada en la billetera: no se duplica');
  });

  test('recarga sin saldo general: rechazada y no suma nada', async () => {
    const r = await pagos.recargar({ montoUsd: 100, precioCredito: PRECIO, usuario });
    assert.equal(r.estado, 'rechazada');
    assert.equal(r.motivo, 'saldo_insuficiente');
    assert.equal(r.saldoGeneralUsd, 40);
    assert.equal(await billetera.saldo(), 160.2);
  });

  test('recarga sin respuesta: queda pendiente y el worker la termina sin duplicar', async () => {
    const url = process.env.PAGOS_URL;
    process.env.PAGOS_URL = 'http://localhost:1';
    const r = await pagos.recargar({ montoUsd: 5, precioCredito: PRECIO, usuario });
    process.env.PAGOS_URL = url;
    assert.equal(r.estado, 'pendiente');
    assert.equal(await billetera.saldo(), 160.2);
    await pool.query(`UPDATE recargas_central SET actualizado = now() - interval '5 minutes' WHERE referencia = $1`, [r.referencia]);
    assert.equal(await pagos.repetirRecargasPendientes(), 1);
    assert.equal(mock.saldo.jh, 35);
    assert.equal(await billetera.saldo(), 240.3); // 160.2 + 80.1
  });

  test('generacion cobrada y terminada: se informa una vez con el detalle completo', async () => {
    const r = await encolar(usuario, video());
    assert.ok(r.g, JSON.stringify(r.error));
    await terminar(r.g.id);
    assert.equal((await fila(r.g.id)).estado, 'completado');
    await pagos.procesarCola();
    await pagos.procesarCola();
    const c = mock.consumos.get(`mkt-gen-${r.g.id}`);
    assert.ok(c, 'se informo');
    assert.equal(mock.peticiones.filter((p) => p.ruta === '/consumos').length, 1);
    assert.equal(c.monto_usd, 2.184);
    assert.equal(c.creditos, 35);
    assert.match(c.descripcion, /Video · Cinema Studio 4.0 · 5 s · 720p · 9:16/);
    const d = c.detalle;
    assert.deepEqual(d.modelo, { id: 'cinematic_studio_video_4_0', nombre: 'Cinema Studio 4.0' });
    assert.equal(d.medio, 'video');
    assert.equal(d.origen, 'desde_cero');
    assert.equal(d.duracion_s, 5);
    assert.equal(d.calidad, '720p');
    assert.equal(d.formato, '9:16');
    assert.equal(d.audio, true);
    assert.equal(d.descripcion_por_ia, true);
    assert.equal(d.imagen_producto, 'https://cdn/breaker.png');
    assert.equal(d.resultados[0].url, 'https://cdn/v.mp4');
    assert.ok(d.segundos_proceso >= 90);
    assert.equal(c.usuario.email, 'vendedor@jh.com');
    assert.equal(mock.saldo.jh, 35, 'informar no mueve dinero');
    assert.equal((await eventos(r.g.id))[0].estado, 'hecho');
  });

  test('fallida (reembolsada) o de super_admin: no se informa', async () => {
    const r = await encolar(usuario, video());
    await terminar(r.g.id, 'failed');
    assert.equal((await fila(r.g.id)).estado, 'fallido');
    assert.equal((await eventos(r.g.id)).length, 0);
    const r2 = await encolar({ ...usuario, rolReal: 'super_admin' }, video());
    await terminar(r2.g.id);
    assert.equal((await eventos(r2.g.id)).length, 0);
  });

  test('plataforma caida al informar: reintenta con espera; un 4xx queda en error para Super Admin', async () => {
    const r = await encolar(usuario, video());
    await terminar(r.g.id);
    const url = process.env.PAGOS_URL;
    process.env.PAGOS_URL = 'http://localhost:1';
    await pagos.procesarCola();
    process.env.PAGOS_URL = url;
    let [ev] = await eventos(r.g.id);
    assert.equal(ev.estado, 'pendiente');
    assert.equal(ev.intentos, 1);
    assert.ok(new Date(ev.proximo) > new Date());
    await pool.query(`UPDATE pagos_eventos SET proximo = now(), cuerpo = cuerpo - 'detalle' WHERE id = $1`, [ev.id]); // cuerpo invalido -> 400
    await pagos.procesarCola();
    [ev] = await eventos(r.g.id);
    assert.equal(ev.estado, 'error');
    assert.equal(await pagos.reintentar(ev.id), true);
  });

  test('firma: la plataforma rechaza un secreto distinto', async () => {
    process.env.PAGOS_SECRETO = 'otro';
    await assert.rejects(pagos.saldoGeneral(), (e) => e.status === 401);
    process.env.PAGOS_SECRETO = 'secreto-test';
    assert.equal((await pagos.saldoGeneral()).saldoUsd, 35);
  });

  test('sin configurar no informa ni rompe el flujo', async () => {
    const url = process.env.PAGOS_URL;
    delete process.env.PAGOS_URL;
    assert.equal(pagos.configurado(), false);
    assert.equal(await pagos.informarConsumo(1), false);
    assert.deepEqual(await pagos.procesarCola(), { hechos: 0 });
    process.env.PAGOS_URL = url;
  });
}
