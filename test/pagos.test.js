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
  Object.assign(process.env, { SALDO_CLIENT_ID: '16', SALDO_API_KEY: 'clave-saldo' });
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

  const mock = crearMock({ apiKeySaldo: 'clave-saldo', callerId: 14, apiKey: 'clave-ajuste', clientes: { 16: { saldo: 5, nombre: 'JH Electroalambres', email: 'jh@x.com' } } });
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
  // Descuento de saldo configurado solo dentro de fn.
  const conAjuste = async (fn) => {
    Object.assign(process.env, { AJUSTE_URL: `http://localhost:${mock.server.address().port}/api/credits/adjust`, AJUSTE_CALLER_ID: '14', AJUSTE_API_KEY: 'clave-ajuste' });
    try { return await fn(); } finally { delete process.env.AJUSTE_CALLER_ID; delete process.env.AJUSTE_API_KEY; }
  };
  const eventos = (id) => pool.query('SELECT * FROM pagos_eventos WHERE generacion_id = $1', [id]).then((r) => r.rows);

  test.before(async () => {
    await new Promise((r) => mock.server.listen(0, r));
    process.env.SALDO_API_URL = `http://localhost:${mock.server.address().port}/api/credits/balance`;
    await migrar();
    await pool.query('TRUNCATE pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY CASCADE');
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

  test('al terminar se descuenta una vez del saldo, con el detalle en la nota', async () => {
    await pool.query(`UPDATE generaciones SET estado = 'fallido' WHERE cobro_externo`);
    const r = await encolar(usuario, video());
    await conAjuste(async () => {
      await terminar(r.g.id);
      await pagos.procesarCola();
      await pagos.procesarCola();
    });
    assert.equal(mock.ajustes.length, 1, 'un solo descuento');
    const a = mock.ajustes[0];
    assert.equal(a.callerId, 14);
    assert.equal(a.clientId, 16);
    assert.equal(a.operation, 'subtract');
    assert.equal(a.concept, 'marketing');
    assert.equal(a.amount, 2.18, 'en centavos, lo mismo que ve JH');
    assert.equal(a.note, `Video Cinema Studio 4.0 · 5 s · 720p · vertical 9:16 · con audio · 35 créditos · $2.18 · vendedor@jh.com · ref mkt-gen-${r.g.id}`);
    assert.ok((await fila(r.g.id)).gasto_informado, 'marcado como descontado');
    assert.equal(Math.round(mock.saldo[16] * 1000) / 1000, 2.82);
    // Recien descontado se sigue restando unos segundos (el saldo leido tiene cache).
    assert.equal((await saldoExterno.pendiente()).usd, 2.184);
    await pool.query(`UPDATE generaciones SET gasto_informado = now() - interval '1 minute' WHERE id = $1`, [r.g.id]);
    saldoExterno.olvidar();
    const s = await saldoExterno.resumen();
    assert.equal(s.pendienteUsd, 0, 'ya se descontó alla: no se resta dos veces');
    assert.equal(s.saldoUsd, 2.82);
  });

  test('503: no llego, se reintenta solo', async () => {
    mock.saldo[16] = 100; // saldo de sobra para lo que queda
    const r = await encolar(usuario, video());
    const antes = mock.ajustes.length;
    await conAjuste(async () => {
      await terminar(r.g.id);
      mock.fallarAjuste('503');
      await pagos.procesarCola();
      mock.fallarAjuste(null);
      let [ev] = await eventos(r.g.id);
      assert.equal(ev.estado, 'pendiente');
      assert.ok(new Date(ev.proximo) > new Date(), 'con espera');
      await pool.query(`UPDATE pagos_eventos SET proximo = now() WHERE id = $1`, [ev.id]);
      await pagos.procesarCola();
      [ev] = await eventos(r.g.id);
      assert.equal(ev.estado, 'hecho');
    });
    assert.equal(mock.ajustes.length, antes + 1);
  });

  test('500 (pudo haberse aplicado): no se repite solo; queda para revisar y se puede dar por hecho', async () => {
    const r = await encolar(usuario, video());
    await conAjuste(async () => {
      await terminar(r.g.id);
      mock.fallarAjuste('500');
      await pagos.procesarCola();
      mock.fallarAjuste(null);
      await pagos.procesarCola();
    });
    const [ev] = await eventos(r.g.id);
    assert.equal(ev.estado, 'error');
    assert.match(ev.ultimo_error, /Puede que se haya descontado/);
    assert.equal(ev.intentos, 1, 'no se reintento solo');
    assert.equal(await pagos.marcarHecho(ev.id, 'admin@nebo'), true);
    assert.ok((await fila(r.g.id)).gasto_informado);
  });

  test('cortado a mitad del envio: pasa a revisar, no se repite', async () => {
    const r = await encolar(usuario, video());
    await conAjuste(async () => {
      await terminar(r.g.id);
      await pool.query(`UPDATE pagos_eventos SET estado = 'enviando', proximo = now() - interval '10 minutes' WHERE generacion_id = $1`, [r.g.id]);
      assert.equal(await pagos.liberarEnviando(), 1);
    });
    assert.equal((await eventos(r.g.id))[0].estado, 'error');
  });

  test('completada sin descuento encolado: la red de seguridad lo encola', async () => {
    const r = await encolar(usuario, video());
    await terminar(r.g.id); // sin configurar: no se encola
    assert.equal((await eventos(r.g.id)).length, 0);
    await conAjuste(async () => { assert.ok(await pagos.encolarFaltantes() >= 1); });
    assert.equal((await eventos(r.g.id)).length, 1);
  });

  test('super admins: no se informan salvo con el ajuste activo, y van marcados', async () => {
    const r = await encolar({ ...usuario, email: 'jefe@nebo.com', rolReal: 'super_admin' }, video());
    await conAjuste(async () => {
      await terminar(r.g.id);
      assert.equal((await eventos(r.g.id)).length, 0, 'con el ajuste apagado no se informa');
      assert.equal(await pagos.encolarFaltantes(), 0, 'la red de seguridad no manda las de super admin');
      await ajustes.guardar({ informar_super_admin: 1 }, 'test');
      const r2 = await encolar({ ...usuario, email: 'jefe@nebo.com', rolReal: 'super_admin' }, video());
      await terminar(r2.g.id);
      const [ev] = await eventos(r2.g.id);
      assert.ok(ev, 'con el ajuste activo se encola al terminar');
      assert.match(ev.cuerpo.note, /jefe@nebo\.com · super admin · ref mkt-gen-/);
      await ajustes.guardar({ informar_super_admin: 0 }, 'test');
    });
  });

  test('historial: lista lo nunca informado con total y solo envia si el total coincide', async () => {
    await conAjuste(async () => {
      await pagos.procesarCola({ limite: 50 }); // lo que quedo en cola de pruebas anteriores
      const h = await pagos.historialSinInformar();
      assert.ok(h.enviables >= 1);
      assert.equal(h.total, Math.round(h.items.filter((i) => i.precio_usd > 0).reduce((a, i) => a + i.precio_usd, 0) * 100) / 100);
      assert.match((await pagos.enviarHistorial(h.total + 1)).error, /cambió/);
      const antes = mock.ajustes.length;
      const r = await pagos.enviarHistorial(h.total);
      assert.equal(r.encolados, h.enviables);
      await pagos.procesarCola({ limite: 50 });
      assert.equal(mock.ajustes.length - antes, h.enviables);
      assert.equal((await pagos.historialSinInformar()).enviables, 0, 'no queda nada por informar');
    });
  });

  test('sin el endpoint de gasto configurado no se envia nada', async () => {
    const r = await encolar(usuario, video());
    await terminar(r.g.id);
    assert.deepEqual(await pagos.procesarCola(), { hechos: 0 });
    assert.equal((await fila(r.g.id)).gasto_informado, null);
  });
}
