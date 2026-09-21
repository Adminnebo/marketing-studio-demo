const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CAMILA_N8N_URL ||= 'https://n8n.prueba/webhook/agente-jh-electro';
process.env.CAMILA_N8N_TOKEN ||= 'token-prueba';
process.env.SUPABASE_URL ||= 'https://ref.supabase.co';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const cat = require('../server/lib/jh-catalogo');
const camila = require('../server/lib/camila');

cat._simular({
  listar: async (bucket) => (bucket === cat.BUCKETS.imagen ? ['15.png', '42 - copia.png', '42.png', 'viejos/4165 (2).png'] : ['15.pdf']),
});

// Respuesta de n8n tal como la arma el nodo "Armar Respuesta Panel" (formato real del 2026-09-21).
const RESP = {
  ok: true,
  texto: 'El Square D de 20 amperios no lo tenemos; de 20 A sí hay varios con foto.\n\n¿Cuál de estos usás?',
  productos: [
    { codigo: '15', descripcion: 'Breaker fino 1 polo 20 amperios ABB THQP120', precio: 514.52, unidad: 'UND', inventario: 2521, tiene_imagen: true, tiene_ficha: true, atributos: { polos: '1p' } },
    { codigo: '42', descripcion: 'ABB Breaker grueso 2P 20 amperios THQL2120', precio: 1153.23, unidad: 'UND', inventario: 274, tiene_imagen: true, tiene_ficha: true },
    { codigo: '999', descripcion: 'Sin foto en el bucket', precio: null, unidad: 'UND', inventario: 0, tiene_imagen: false, tiene_ficha: false },
  ],
  sugerencias: ['El de 2 polos', 'El de 1 polo', '', 'Cuarta'],
  execution_id: '3065',
};

function n8nFalso(cuerpo = RESP, { status = 200 } = {}) {
  const pedidos = [];
  const f = async (url, init) => {
    pedidos.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) };
  };
  f.pedidos = pedidos;
  return f;
}

test('indice de fotos: copias y carpetas apuntan al mismo codigo, gana el original', async () => {
  const ix = cat.armarIndice(['0774 - copia.png', '0774.png', '11815 (2).png', 'sub/abc.png']);
  assert.equal(ix.get('0774'), '0774.png');
  assert.equal(ix.get('11815'), '11815 (2).png');
  assert.equal(ix.get('ABC'), 'sub/abc.png');
  assert.equal(cat.normalizarNombre('305400 copy (3).PNG'), '305400');
  assert.deepEqual(await cat.archivosDe('4165'), { imagen: 'https://ref.supabase.co/storage/v1/object/public/Lucas_imagenes/viejos/4165%20(2).png', ficha: null });
});

test('responder: le pregunta a n8n con canal marketing_request, la clave y la memoria por conversacion', async () => {
  const f = n8nFalso();
  const r = await camila.responder({ contactId: 'mkt-7-abc', texto: 'breaker square d 20', usuario: 'yo@jh.do' }, { fetch: f });
  const [p] = f.pedidos;
  assert.equal(p.url, 'https://n8n.prueba/webhook/agente-jh-electro');
  assert.equal(p.init.headers['x-panel-token'], 'token-prueba');
  assert.deepEqual(p.body, { canal: 'marketing_request', contact_id: 'mkt-7-abc', mensaje: 'breaker square d 20', usuario_panel: 'yo@jh.do', user_id: 'marketing:yo@jh.do' });
  assert.equal(r.texto, RESP.texto);
  assert.equal(r.ejecucion, '3065');
  assert.deepEqual(r.sugerencias, ['El de 2 polos', 'El de 1 polo', 'Cuarta']);
  // Tarjetas con las URLs del bucket por codigo.
  assert.deepEqual(r.productos.map((x) => [x.codigo, !!x.foto, !!x.ficha]), [['15', true, true], ['42', true, false], ['999', false, false]]);
  assert.match(r.productos[1].foto, /Lucas_imagenes\/42\.png$/);
  assert.equal(r.productos[0].precio, 514.52);
  assert.equal(r.productos[0].inventario, 2521);
});

test('responder: errores de n8n salen como mensajes amables', async () => {
  const opt = { contactId: 'mkt-1', texto: 'x', usuario: 'yo@jh.do' };
  await assert.rejects(camila.responder(opt, { fetch: n8nFalso({ ok: false, error: 'no autorizado' }, { status: 401 }) }),
    (e) => e instanceof camila.ErrorDeCamila && /bien conectada/.test(e.message) && e.status === 503);
  await assert.rejects(camila.responder(opt, { fetch: n8nFalso('<html>error</html>', { status: 500 }) }), /ocupada/);
  await assert.rejects(camila.responder(opt, { fetch: n8nFalso({ ok: true, async: true }) }), /enredó/); // rama de WhatsApp por error
  await assert.rejects(camila.responder(opt, { fetch: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }), /tardó demasiado/);
});

test('contactoDe: un contact_id distinto por conversacion', () => {
  const a = camila.contactoDe({ id: 7, creado: '2026-09-21T17:00:00Z' });
  const b = camila.contactoDe({ id: 7, creado: '2026-09-22T17:00:00Z' });
  assert.match(a, /^mkt-7-[a-z0-9]+$/);
  assert.notEqual(a, b); // misma id en otra base (pruebas locales) no mezcla la memoria de n8n
});

// Guardado (Postgres real, como los demas tests de base de datos).
if (!process.env.TEST_DATABASE_URL) {
  test('camila con base de datos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  test('conversar guarda todo por usuario, ultima() la retoma y productoMostrado() valida el uso', async () => {
    const { pool } = require('../server/lib/db');
    await camila.migrar();
    await pool.query('TRUNCATE camila_usos, camila_mensajes, camila_conversaciones RESTART IDENTITY');
    const yo = { id: '16ef13cc-6645-4fd6-8d56-09a5f8038d45', email: 'yo@x' };
    const f = n8nFalso();
    const r1 = await camila.conversar({ user: yo, texto: 'breaker de 20' }, { fetch: f });
    assert.equal(r1.camila.productos[0].codigo, '15');
    assert.match(f.pedidos[0].body.contact_id, new RegExp(`^mkt-${r1.conversacionId}-`));
    // Segunda vuelta de la misma conversacion: mismo contact_id (memoria de n8n).
    await camila.conversar({ user: yo, conversacionId: r1.conversacionId, texto: 'el de 2 polos' }, { fetch: f });
    assert.equal(f.pedidos[1].body.contact_id, f.pedidos[0].body.contact_id);
    // Otro usuario no puede seguir mi conversacion: se le abre una nueva.
    const r2 = await camila.conversar({ user: { email: 'otro@x' }, conversacionId: r1.conversacionId, texto: 'hola' }, { fetch: n8nFalso({ ok: true, texto: 'Hola', productos: [], sugerencias: [] }) });
    assert.notEqual(r2.conversacionId, r1.conversacionId);
    // Un error queda guardado como respuesta de Camila.
    await assert.rejects(camila.conversar({ user: yo, conversacionId: r1.conversacionId, texto: 'x' }, { fetch: n8nFalso('', { status: 500 }) }));
    const u = await camila.ultima('yo@x');
    assert.equal(u.id, r1.conversacionId);
    assert.deepEqual(u.mensajes.map((m) => m.rol), ['usuario', 'camila', 'usuario', 'camila', 'usuario', 'camila']);
    const { rows: [m] } = await pool.query("SELECT n8n_ejecucion, modelo FROM camila_mensajes WHERE rol = 'camila' ORDER BY id LIMIT 1");
    assert.deepEqual(m, { n8n_ejecucion: '3065', modelo: 'n8n' });
    // Solo se puede usar un producto que Camila le mostro a ese usuario.
    assert.equal((await camila.productoMostrado('yo@x', '42')).descripcion, 'ABB Breaker grueso 2P 20 amperios THQL2120');
    assert.equal(await camila.productoMostrado('otro@x', '42'), null);
    assert.equal(await camila.productoMostrado('yo@x', '7777'), null);
    await camila.registrarUso({ email: 'yo@x', conversacionId: r1.conversacionId, codigo: '42', descripcion: 'B', mediaId: 'm1' });
    assert.equal((await pool.query('SELECT count(*)::int n FROM camila_usos')).rows[0].n, 1);
    await pool.end();
  });
}
