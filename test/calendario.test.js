// Calendario: rangos de fechas y mover/cancelar una programada (Postgres real; se salta sin TEST_DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('calendario (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ZERNIO_API_KEY = 'sk_test';
  const express = require('express');
  const { pool, migrar } = require('../server/lib/db');
  const zernio = require('../server/lib/zernio');
  const redes = require('../server/redes');
  const { router } = redes;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => { req.user = { email: 'admin@nebo.com', rol: 'admin', puedePublicar: true }; next() }, router);
  let srv, base, genId, pubId;
  const llamadas = [];
  zernio.reprogramarPost = async (...a) => { llamadas.push(['reprogramar', ...a]); return { post: { status: 'scheduled' } }; };
  zernio.borrarPost = async (...a) => { llamadas.push(['borrar', ...a]); return {}; };
  const enDias = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return d; };

  test.before(async () => {
    await migrar();
    await pool.query('TRUNCATE pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY CASCADE');
    const { rows: [g] } = await pool.query(
      `INSERT INTO generaciones (creado_por, preset_id, preset_nombre, preset_tipo, entrada, estado, terminado, resultados)
       VALUES ('vendedor@jh.com','p1','Badge Orbit','marketplace','{}','completado', $1, '[{"url":"https://cdn/x.png"}]') RETURNING id`, [enDias(0, 9)]
    );
    genId = g.id;
    // Una creacion vieja (fuera del rango que se pide) y una que fallo: no deben salir.
    await pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado, terminado) VALUES ('v@jh','p2','ads','{}','completado', now() - interval '60 days')`);
    await pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado, terminado) VALUES ('v@jh','p3','ads','{}','fallido', now())`);
    const { rows: [p] } = await pool.query(
      `INSERT INTO publicaciones (generacion_id, creado_por, texto, medio, cuentas, estado, zernio_post_id, programada_para, zona)
       VALUES ($1,'vendedor@jh.com','Texto','{"url":"https://cdn/x.png","tipo":"image"}','[{"plataforma":"instagram"}]','programada','post-1',$2,'America/Santo_Domingo') RETURNING id`,
      [genId, enDias(2)]
    );
    pubId = p.id;
    await pool.query(`INSERT INTO publicaciones (generacion_id, creado_por, medio, cuentas, estado, programada_para) VALUES ($1,'v@jh','{}','[]','cancelada',$2)`, [genId, enDias(2)]);
    await new Promise((r) => { srv = app.listen(0, r); });
    base = `http://localhost:${srv.address().port}`;
  });
  test.after(async () => { srv.close(); await pool.end(); });
  const get = (r) => fetch(base + '/api' + r).then(async (x) => [x.status, await x.json()]);
  const post = (r, b) => fetch(base + '/api' + r, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (x) => [x.status, await x.json()]);

  test('publicaciones del rango: con su creación, sin canceladas y solo dentro del rango', async () => {
    const [s, j] = await get(`/publicaciones/calendario?desde=${enDias(-1).toISOString()}&hasta=${enDias(7).toISOString()}`);
    assert.equal(s, 200);
    assert.equal(j.items.length, 1, 'la cancelada no sale');
    assert.equal(j.items[0].preset_nombre, 'Badge Orbit', 'trae los datos de la creación');
    assert.equal(j.items[0].cuentas[0].plataforma, 'instagram');
    const [, fuera] = await get(`/publicaciones/calendario?desde=${enDias(20).toISOString()}&hasta=${enDias(27).toISOString()}`);
    assert.equal(fuera.items.length, 0);
  });

  test('rangos inválidos o demasiado grandes se rechazan', async () => {
    assert.equal((await get('/publicaciones/calendario?desde=x&hasta=y'))[0], 400);
    assert.equal((await get(`/publicaciones/calendario?desde=${enDias(0).toISOString()}&hasta=${enDias(-1).toISOString()}`))[0], 400);
    assert.equal((await get(`/publicaciones/calendario?desde=${enDias(0).toISOString()}&hasta=${enDias(60).toISOString()}`))[0], 400);
  });

  test('mover la fecha: la guarda y la manda a la red; fechas en el pasado no', async () => {
    const f = enDias(5, 15);
    const [s, j] = await post(`/publicaciones/${pubId}/reprogramar`, { fechaLocal: '2027-01-02T15:00', fechaIso: f.toISOString(), zona: 'America/Santo_Domingo' });
    assert.equal(s, 200, JSON.stringify(j));
    assert.deepEqual(llamadas.at(-1), ['reprogramar', 'post-1', '2027-01-02T15:00:00', 'America/Santo_Domingo']);
    const { rows: [p] } = await pool.query('SELECT programada_para FROM publicaciones WHERE id = $1', [pubId]);
    assert.equal(new Date(p.programada_para).toISOString(), f.toISOString());
    const [sPasado] = await post(`/publicaciones/${pubId}/reprogramar`, { fechaLocal: '2020-01-01T10:00', fechaIso: '2020-01-01T14:00:00.000Z' });
    assert.equal(sPasado, 400);
  });

  test('una publicada no se puede mover ni cancelar', async () => {
    await pool.query(`UPDATE publicaciones SET estado = 'publicada' WHERE id = $1`, [pubId]);
    assert.equal((await post(`/publicaciones/${pubId}/reprogramar`, { fechaLocal: '2027-01-02T15:00', fechaIso: enDias(6).toISOString() }))[0], 400);
    assert.equal((await post(`/publicaciones/${pubId}/cancelar`, {}))[0], 400);
    await pool.query(`UPDATE publicaciones SET estado = 'programada' WHERE id = $1`, [pubId]);
  });

  test('cancelar: la quita de la red y deja de salir en el calendario', async () => {
    const [s] = await post(`/publicaciones/${pubId}/cancelar`, {});
    assert.equal(s, 200);
    assert.deepEqual(llamadas.at(-1), ['borrar', 'post-1']);
    const [, j] = await get(`/publicaciones/calendario?desde=${enDias(-1).toISOString()}&hasta=${enDias(9).toISOString()}`);
    assert.equal(j.items.length, 0);
  });
  test('solo salen las publicaciones de las cuentas conectadas hoy', async () => {
    // Una publicacion en la cuenta conectada y otra en una cuenta que ya se desconecto.
    const { rows: [a] } = await pool.query(
      `INSERT INTO publicaciones (generacion_id, creado_por, medio, cuentas, estado, programada_para)
       VALUES ($1,'v@jh','{}','[{"id":"acc-viva","plataforma":"instagram","usuario":"jh"}]','publicada',$2) RETURNING id`, [genId, enDias(1)]
    );
    await pool.query(
      `INSERT INTO publicaciones (generacion_id, creado_por, medio, cuentas, estado, programada_para)
       VALUES ($1,'v@jh','{}','[{"id":"acc-vieja","plataforma":"instagram","usuario":"otra"}]','publicada',$2)`, [genId, enDias(1)]
    );
    zernio.cuentas = async () => [{ id: 'acc-viva', plataforma: 'instagram', usuario: 'jh' }];
    redes._olvidarCuentas();
    const [s, j] = await get(`/publicaciones/calendario?desde=${enDias(-1).toISOString()}&hasta=${enDias(7).toISOString()}`);
    assert.equal(s, 200);
    assert.equal(j.filtrado, true);
    assert.ok(j.ocultas >= 1, 'la de la cuenta desconectada queda fuera');
    assert.deepEqual(j.items.map((x) => Number(x.id)), [Number(a.id)], 'solo la de la cuenta conectada');
  });

  test('si no se pueden leer las cuentas, se muestran todas y se avisa', async () => {
    zernio.cuentas = async () => { throw new Error('Zernio caido'); };
    redes._olvidarCuentas();
    const [s, j] = await get(`/publicaciones/calendario?desde=${enDias(-1).toISOString()}&hasta=${enDias(7).toISOString()}`);
    assert.equal(s, 200);
    assert.equal(j.filtrado, false);
    // Mejor mostrar todo que dejar el calendario vacio: vuelve la de la cuenta desconectada.
    const usuarios = j.items.flatMap((x) => (x.cuentas || []).map((c) => c.usuario));
    assert.ok(usuarios.includes('otra'), 'se muestra tambien la de la cuenta desconectada');
  });

}
