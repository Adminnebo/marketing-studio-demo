// Registro del webhook en Zernio. Lo que importa: al cambiar el dominio el
// webhook se MUEVE en vez de dejar uno viejo activo (cada evento llegaba dos
// veces), y la limpieza nunca toca lo que no es inequívocamente nuestro.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const PUERTO = 55483;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ZERNIO_API_KEY = 'zk_prueba';
process.env.ZERNIO_WEBHOOK_SECRET = 'secreto-prueba';
process.env.ZERNIO_API_URL = `http://127.0.0.1:${PUERTO}`;

if (!process.env.TEST_DATABASE_URL) {
  test('registro del webhook (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  const { pool, migrar } = require('../server/lib/db');
  const zernio = require('../server/lib/zernio');

  const VIEJA = 'https://panel-production-f46d.up.railway.app/api/zernio/webhook';
  const NUEVA = 'https://panelmarketing.neboaiconsulting.com/api/zernio/webhook';
  let almacen, srv, llamadas;

  const cuerpoDe = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });

  const mock = () => http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    llamadas.push(`${req.method} ${u.pathname}${u.searchParams.get('webhookId') ? '?webhookId=' + u.searchParams.get('webhookId') : ''}`);
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/webhooks/settings') {
      if (req.method === 'GET') return ok({ webhooks: almacen });
      if (req.method === 'POST') {
        const b = await cuerpoDe(req);
        const w = { _id: 'wh-' + (almacen.length + 1), ...b };
        almacen.push(w);
        return ok({ webhook: w });
      }
      if (req.method === 'PUT') {
        const b = await cuerpoDe(req);
        const w = almacen.find((x) => x._id === (b._id || b.webhookId));
        if (w) Object.assign(w, b);
        return ok({ webhook: w });
      }
      if (req.method === 'DELETE') {
        almacen = almacen.filter((x) => x._id !== u.searchParams.get('webhookId'));
        return ok({ ok: true });
      }
    }
    res.writeHead(404); res.end('{}');
  });

  test.before(async () => {
    await migrar();
    await new Promise((r) => { srv = mock().listen(PUERTO, '127.0.0.1', r); });
  });
  test.after(async () => { srv?.close(); await pool.end(); });
  test.beforeEach(async () => {
    llamadas = [];
    await pool.query(`DELETE FROM config WHERE clave = 'zernio_webhook_id'`);
  });

  const guardado = () => pool.query(`SELECT valor FROM config WHERE clave = 'zernio_webhook_id'`).then((r) => r.rows[0]?.valor || null);

  test('la primera vez lo crea y anota su id', async () => {
    almacen = [];
    const r = await zernio.asegurarWebhook('https://panelmarketing.neboaiconsulting.com');
    assert.equal(r.creado, true);
    assert.equal(r.url, NUEVA);
    assert.equal(almacen.length, 1);
    assert.equal(await guardado(), r.id);
    assert.deepEqual(r.sobran, []);
  });

  test('al cambiar de dominio MUEVE el que había, no crea otro', async () => {
    almacen = [{ _id: 'wh-viejo', name: 'Marketing JH', url: VIEJA, events: [], isActive: true }];
    await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', 'wh-viejo')`);
    const r = await zernio.asegurarWebhook('https://panelmarketing.neboaiconsulting.com');
    assert.equal(r.creado, false, 'no puede crear uno nuevo');
    assert.equal(r.movido, true);
    assert.equal(r.id, 'wh-viejo', 'sigue siendo el mismo registro');
    assert.equal(almacen.length, 1, 'y no queda ninguno de más');
    assert.equal(almacen[0].url, NUEVA);
    assert.ok(llamadas.includes('PUT /webhooks/settings'));
    assert.ok(!llamadas.includes('POST /webhooks/settings'));
  });

  test('sin el id anotado lo reconoce por el nombre', async () => {
    // Es el caso de una base nueva o de una config perdida.
    almacen = [{ _id: 'wh-viejo', name: 'Marketing JH', url: VIEJA, events: [], isActive: true }];
    const r = await zernio.asegurarWebhook('https://panelmarketing.neboaiconsulting.com');
    assert.equal(r.creado, false);
    assert.equal(r.id, 'wh-viejo');
    assert.equal(almacen.length, 1);
  });

  test('si ya quedó un huérfano, se avisa en vez de callarlo', async () => {
    almacen = [
      { _id: 'wh-viejo', name: 'Marketing JH', url: VIEJA, events: [], isActive: true, failureCount: 0 },
      { _id: 'wh-nuevo', name: 'Marketing JH', url: NUEVA, events: [], isActive: true },
    ];
    await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', 'wh-nuevo')`);
    const r = await zernio.asegurarWebhook('https://panelmarketing.neboaiconsulting.com');
    assert.equal(r.sobran.length, 1);
    assert.equal(r.sobran[0].url, VIEJA);
    assert.equal(r.sobran[0].borrable, true);
    assert.equal(almacen.length, 2, 'avisar no es borrar: eso lo decide un super admin');
  });

  test('la limpieza borra el huérfano y deja el que está en uso', async () => {
    almacen = [
      { _id: 'wh-viejo', name: 'Marketing JH', url: VIEJA },
      { _id: 'wh-nuevo', name: 'Marketing JH', url: NUEVA },
    ];
    await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', 'wh-nuevo')`);
    const r = await zernio.limpiarWebhooks();
    assert.deepEqual(r.borrados.map((x) => x.id), ['wh-viejo']);
    assert.deepEqual(almacen.map((x) => x._id), ['wh-nuevo']);
    assert.ok(llamadas.includes('DELETE /webhooks/settings?webhookId=wh-viejo'));
  });

  test('NUNCA borra los webhooks de otros proyectos de la cuenta compartida', async () => {
    almacen = [
      { _id: 'wh-nuevo', name: 'Marketing JH', url: NUEVA },
      // Otro proyecto en la misma cuenta de Zernio.
      { _id: 'wh-ajeno', name: 'My Webhook', url: 'https://web-production-9b1a4.up.railway.app/hook' },
      // Nuestro nombre pero otra ruta: no se borra, se manda a revisar.
      { _id: 'wh-raro', name: 'Marketing JH', url: 'https://otra-cosa.com/otro/camino' },
      // Nuestra ruta pero otro nombre: tampoco.
      { _id: 'wh-casi', name: 'Otro', url: 'https://tercero.com/api/zernio/webhook' },
    ];
    await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', 'wh-nuevo')`);
    const r = await zernio.limpiarWebhooks();
    assert.deepEqual(r.borrados, [], 'ninguno cumple las dos condiciones');
    assert.equal(almacen.length, 4);
    assert.deepEqual(r.revisar.map((x) => x.id).sort(), ['wh-casi', 'wh-raro']);
  });

  test('la lista para Super Admin marca cuál está en uso y cuál se puede borrar', async () => {
    almacen = [
      { _id: 'wh-viejo', name: 'Marketing JH', url: VIEJA, isActive: true, events: ['post.published'], failureCount: 2 },
      { _id: 'wh-nuevo', name: 'Marketing JH', url: NUEVA, isActive: true, events: ['post.published'] },
      { _id: 'wh-ajeno', name: 'My Webhook', url: 'https://web-production-9b1a4.up.railway.app/hook' },
    ];
    await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', 'wh-nuevo')`);
    const l = await zernio.webhooksNuestros();
    assert.equal(l.length, 2, 'el de otro proyecto no aparece');
    const enUso = l.find((w) => w.enUso);
    assert.equal(enUso.id, 'wh-nuevo');
    assert.equal(enUso.borrable, false, 'el que está en uso nunca es borrable');
    const otro = l.find((w) => !w.enUso);
    assert.equal(otro.borrable, true);
    assert.equal(otro.fallos, 2);
  });
}
