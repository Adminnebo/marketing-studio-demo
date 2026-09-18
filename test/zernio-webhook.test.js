// Webhook de Zernio contra Postgres real (TEST_DATABASE_URL); se salta si no esta.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.TEST_DATABASE_URL) {
  test('webhook zernio (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ZERNIO_WEBHOOK_SECRET = 'secreto-prueba';
  process.env.ZERNIO_API_KEY = 'sk_test';
  const express = require('express');
  const { pool, migrar } = require('../server/lib/db');
  const { router } = require('../server/zernio-webhook');
  const app = express(); app.use('/api', router);
  let srv, base;
  const firmar = (b) => crypto.createHmac('sha256', 'secreto-prueba').update(b).digest('hex');
  const enviar = (obj, firma) => { const b = JSON.stringify(obj); return fetch(base + '/api/zernio/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': firma ?? firmar(b) }, body: b }); };

  test.before(async () => {
    await migrar();
    await pool.query('TRUNCATE billetera, publicaciones, generaciones, zernio_eventos RESTART IDENTITY');
    const { rows: [g] } = await pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado) VALUES ('t@x','p','ads','{}','completado') RETURNING id`);
    await pool.query(`INSERT INTO publicaciones (generacion_id, creado_por, medio, cuentas, estado, zernio_post_id) VALUES ($1, 't@x', '{}', '[]', 'publicando', 'post-1')`, [g.id]);
    await new Promise((r) => { srv = app.listen(0, r); });
    base = `http://localhost:${srv.address().port}`;
  });
  test.after(async () => { srv.close(); await pool.end(); });

  test('firma invalida o ausente: 401 y no toca nada', async () => {
    assert.equal((await enviar({ id: 'e0', event: 'post.published', post: { id: 'post-1', status: 'published', platforms: [] } }, 'mala')).status, 401);
    assert.equal((await enviar({ id: 'e0', event: 'post.published' }, '')).status, 401);
  });

  test('post.partial actualiza la publicacion; el repetido no se procesa dos veces', async () => {
    const ev = { id: 'e1', event: 'post.partial', post: { id: 'post-1', status: 'partial', platforms: [
      { platform: 'instagram', status: 'published', accountId: 'a1', publishedUrl: 'https://instagram.com/p/1' },
      { platform: 'twitter', status: 'failed', accountId: 'a2', error: 'too long' }] } };
    assert.equal((await enviar(ev)).status, 200);
    const { rows: [p] } = await pool.query("SELECT estado, plataformas, error FROM publicaciones WHERE zernio_post_id = 'post-1'");
    assert.equal(p.estado, 'parcial');
    assert.equal(p.plataformas[0].platformPostUrl, 'https://instagram.com/p/1');
    assert.equal(p.error, 'No salió en: X.');
    const again = await (await enviar(ev)).json();
    assert.equal(again.repetido, true);
  });

  test('evento de prueba y de cuenta responden 200', async () => {
    assert.equal((await enviar({ id: 'e2', event: 'webhook.test' })).status, 200);
    assert.equal((await enviar({ id: 'e3', event: 'account.disconnected', account: { platform: 'instagram', username: 'jh' } })).status, 200);
  });
}
