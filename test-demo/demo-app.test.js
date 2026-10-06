/**
 * El servidor de la demo, contra un panel de mentira.
 *
 * Lo que se cuida aqui es lo que queda expuesto a internet: que sin codigo no se
 * entre, que el codigo salga de la cookie firmada y no de lo que mande el
 * navegador, que la clave de servicio nunca baje al navegador, y que del pedido
 * de crear solo viaje a produccion lo que el prospecto puede decidir.
 */
process.env.DEMO_CLAVE = 'clave-de-servicio-de-prueba-0123456789';
process.env.DEMO_SESION = 'secreto-de-sesion-de-prueba-0123456789';
process.env.DEMO_CONTACTO = 'https://wa.me/18095550100';
const PUERTO_PANEL = 39417;
process.env.PANEL_API = `http://127.0.0.1:${PUERTO_PANEL}/`;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, sellar, abrir, _intentos } = require('../server/demo-app');

const BUENO = 'NEBO-ABCD-2345';
const MODELOS = [
  { id: 'kling3_0', nombre: 'Kling 3.0', tipo: 'video', bloqueado: true },
  { id: 'seedance_2_5', nombre: 'Seedance 2.5', tipo: 'video', bloqueado: false, demo: { fijo: { resolution: '480p' }, duracion: 5 } },
  { id: 'gpt_image_2_5', nombre: 'GPT Image 2.5', tipo: 'imagen', bloqueado: false, demo: { fijo: { quality: 'medium' }, duracion: null } },
];
const CUPO = { imagenes: { usadas: 0, max: 1, quedan: 1 }, videos: { usadas: 0, max: 1, quedan: 1 } };

// ── El panel de mentira ──────────────────────────────────────────────────────
const panel = { llamadas: [], revocado: false, claveMala: false, caido: false };
const srvPanel = http.createServer((req, res) => {
  const trozos = [];
  req.on('data', (c) => trozos.push(c));
  req.on('end', () => {
    const crudo = Buffer.concat(trozos);
    let cuerpo = null;
    try { cuerpo = JSON.parse(crudo.toString() || 'null'); } catch { cuerpo = crudo; }
    const ll = { metodo: req.method, ruta: req.url, clave: req.headers['x-demo-clave'], codigo: req.headers['x-demo-codigo'], tipo: req.headers['content-type'], nombre: req.headers['x-nombre'], cuerpo };
    panel.llamadas.push(ll);
    const dar = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/archivo.mp4') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 5 }); return res.end('video'); }
    if (panel.caido) return req.socket.destroy();
    if (panel.claveMala || ll.clave !== process.env.DEMO_CLAVE) return dar(401, { error: 'Clave de servicio inválida.' });
    const codigo = req.url === '/api/demo/entrar' ? cuerpo?.codigo : ll.codigo;
    if (codigo !== BUENO) return dar(401, { error: 'Ese código no existe. Revisa que esté bien escrito.', motivo: 'inexistente' });
    if (panel.revocado) return dar(401, { error: 'Ese código ya no está activo.', motivo: 'revocado' });
    if (req.url === '/api/demo/entrar') return dar(200, { codigo: BUENO, prospecto: 'Ferretería El Progreso', caduca: '2026-10-20T00:00:00Z', cupo: CUPO });
    if (req.url === '/api/demo/estado') return dar(200, { codigo: BUENO, prospecto: 'Ferretería El Progreso', caduca: '2026-10-20T00:00:00Z', activa: true, cupo: CUPO, descripciones: { usadas: 0, max: 6 } });
    if (req.url === '/api/demo/opciones') return dar(200, { modelos: MODELOS });
    if (req.url === '/api/demo/medios') return dar(200, { media_id: 'm1', url: 'https://cdn/p.png', nombre: 'p.png' });
    if (req.url === '/api/demo/descripcion') return dar(200, { prompt: 'A product on a table', avisos: [], quedan: 5 });
    if (req.url === '/api/demo/generaciones' && req.method === 'POST') return dar(201, { id: 7, tipo: cuerpo.tipo, estado: 'pendiente' });
    if (req.url === '/api/demo/generaciones') return dar(200, { items: [{ id: 7, estado: 'completado' }] });
    if (req.url === '/api/demo/generaciones/7') return dar(200, { id: 7, estado: 'completado', resultados: [{ url: `http://127.0.0.1:${PUERTO_PANEL}/archivo.mp4` }] });
    if (req.url.startsWith('/api/demo/generaciones/')) return dar(404, { error: 'Esa pieza no existe.' });
    dar(404, { error: 'No encontrado.' });
  });
});

let base; let srv; let nIp = 0;
test.before(async () => {
  await new Promise((r) => srvPanel.listen(PUERTO_PANEL, '127.0.0.1', r));
  srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.close(); srvPanel.close(); srvPanel.closeAllConnections?.(); srv.closeAllConnections?.(); });
test.beforeEach(() => { panel.llamadas.length = 0; panel.revocado = false; panel.claveMala = false; panel.caido = false; _intentos.clear(); });

// Cada peticion llega "desde" una IP distinta salvo que se pida otra cosa: el
// freno de intentos es por IP y no debe mezclar pruebas.
async function pedir(ruta, { metodo, cuerpo, cookie, ip, cabeceras, crudo } = {}) {
  const r = await fetch(base + ruta, {
    method: metodo || (cuerpo || crudo ? 'POST' : 'GET'),
    headers: { 'x-forwarded-for': ip || `10.0.0.${++nIp % 250}`, ...(cuerpo ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(cabeceras || {}) },
    body: crudo || (cuerpo ? JSON.stringify(cuerpo) : undefined),
  });
  const texto = await r.text();
  let j = null; try { j = JSON.parse(texto); } catch { j = texto; }
  return { s: r.status, j, h: r.headers };
}
const galleta = (h) => (h.get('set-cookie') || '').split(';')[0];
const sesion = async () => galleta((await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO } })).h);

// ── Entrar ───────────────────────────────────────────────────────────────────

test('sin sesión no se ve nada del panel; salud y configuración sí', async () => {
  for (const ruta of ['/api/me', '/api/modelos', '/api/generaciones', '/api/demo/sesion']) {
    assert.equal((await pedir(ruta)).s, 401, ruta);
  }
  assert.equal((await pedir('/api/libre', { cuerpo: { modelo: 'seedance_2_5', prompt: 'x' } })).s, 401);
  assert.equal(panel.llamadas.length, 0, 'sin sesión no se le pregunta nada a producción');
  assert.deepEqual((await pedir('/api/config')).j, { demo: true, contacto: 'https://wa.me/18095550100' });
  assert.equal((await pedir('/api/health')).j.configurado, true);
});

test('con el código bueno se entra y la cookie no la puede leer el navegador', async () => {
  const r = await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO } });
  assert.equal(r.s, 200);
  assert.equal(r.j.prospecto, 'Ferretería El Progreso');
  const c = r.h.get('set-cookie');
  assert.match(c, /^ms_demo=/); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/);
  assert.doesNotMatch(c, /Secure/, 'en local, sin https, la cookie tiene que funcionar');
  assert.equal(r.j.codigo, undefined, 'el código no vuelve en la respuesta');
  const me = await pedir('/api/me', { cookie: galleta(r.h) });
  assert.equal(me.s, 200);
  assert.equal(me.j.rol, 'usuario');
  assert.deepEqual(me.j.demo.cupo, CUPO);
});

test('en producción la cookie solo viaja por https', async () => {
  process.env.NODE_ENV = 'production';
  try { assert.match((await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO } })).h.get('set-cookie'), /; Secure/); }
  finally { delete process.env.NODE_ENV; }
});

test('un código malo no entra, y a los 8 intentos esa IP queda frenada', async () => {
  const ip = '203.0.113.9';
  for (let i = 0; i < 8; i++) {
    const r = await pedir('/api/demo/entrar', { cuerpo: { codigo: `NEBO-XXXX-000${i}` }, ip });
    assert.equal(r.s, 401);
    assert.equal(r.h.get('set-cookie'), null);
  }
  const antes = panel.llamadas.length;
  const r = await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO }, ip });
  assert.equal(r.s, 429, 'frenada aunque ahora traiga el bueno');
  assert.equal(panel.llamadas.length, antes, 'frenada: ya no se consulta a producción');
  assert.equal((await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO }, ip: '203.0.113.10' })).s, 200, 'otra IP entra normal');
});

test('entrar bien no cuenta como intento fallido', async () => {
  const ip = '203.0.113.20';
  for (let i = 0; i < 12; i++) assert.equal((await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO }, ip })).s, 200);
});

test('una cookie tocada, firmada con otro secreto o vencida no vale', async () => {
  const buena = sellar(BUENO);
  assert.equal(abrir(buena), BUENO);
  const [cuerpo, firma] = buena.split('.');
  const otro = Buffer.from(JSON.stringify({ c: 'NEBO-OTRO-2222', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(abrir(`${otro}.${firma}`), null, 'cambiar el código rompe la firma');
  assert.equal(abrir(`${cuerpo}.${crypto.createHmac('sha256', 'otro-secreto').update(cuerpo).digest('base64url')}`), null);
  const vencido = Buffer.from(JSON.stringify({ c: BUENO, e: Date.now() - 1000 })).toString('base64url');
  const firmaVencido = crypto.createHmac('sha256', process.env.DEMO_SESION).update(vencido).digest('base64url');
  assert.equal(abrir(`${vencido}.${firmaVencido}`), null, 'bien firmada pero vencida');
  for (const mala of [`${otro}.${firma}`, 'cualquier-cosa', `${cuerpo}.`, '']) {
    assert.equal((await pedir('/api/me', { cookie: `ms_demo=${mala}` })).s, 401);
  }
  assert.equal(panel.llamadas.length, 0);
});

test('el código sale de la cookie, no de lo que mande el navegador', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  await pedir('/api/me', { cookie, cabeceras: { 'x-demo-codigo': 'NEBO-OTRO-2222', 'x-demo-clave': 'la-que-yo-quiera' } });
  assert.equal(panel.llamadas[0].codigo, BUENO);
  assert.equal(panel.llamadas[0].clave, process.env.DEMO_CLAVE);
});

test('la clave de servicio nunca baja al navegador', async () => {
  const cookie = await sesion();
  const rutas = ['/api/me', '/api/modelos', '/api/generaciones', '/api/generaciones/7', '/api/config', '/api/health', '/api/estado', '/api/demo/sesion', '/api/no-existe'];
  for (const ruta of rutas) {
    const r = await pedir(ruta, { cookie });
    assert.equal(JSON.stringify(r.j).includes(process.env.DEMO_CLAVE), false, ruta);
    assert.equal([...r.h.entries()].some(([, v]) => v.includes(process.env.DEMO_CLAVE)), false, ruta);
  }
});

test('si el código se revoca a mitad de sesión, se cierra', async () => {
  const cookie = await sesion();
  panel.revocado = true;
  const r = await pedir('/api/me', { cookie });
  assert.equal(r.s, 401);
  assert.equal(r.j.motivo, 'revocado');
  assert.match(r.h.get('set-cookie'), /ms_demo=;.*Max-Age=0/);
});

test('salir borra la cookie', async () => {
  const r = await pedir('/api/demo/salir', { metodo: 'POST', cookie: await sesion() });
  assert.match(r.h.get('set-cookie'), /ms_demo=;.*Max-Age=0/);
});

// ── Lo que viaja a producción ────────────────────────────────────────────────

test('al crear solo viaja lo que el prospecto puede decidir', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  const r = await pedir('/api/libre', { cookie, cuerpo: {
    modelo: 'seedance_2_5', prompt: 'un taladro', aspecto: '9:16', imagen: { media_id: 'm1', url: 'https://cdn/p.png' },
    duracion: 30, opciones: { resolution: '1080p', generate_audio: true }, tipo: 'imagen', precio: 0, demo: false, codigo: 'NEBO-OTRO-2222',
  } });
  assert.equal(r.s, 201);
  const ll = panel.llamadas.find((x) => x.ruta === '/api/demo/generaciones');
  assert.deepEqual(ll.cuerpo, { tipo: 'video', prompt: 'un taladro', aspecto: '9:16', imagen: { media_id: 'm1', url: 'https://cdn/p.png' } },
    'ni duración, ni resolución, ni modelo: eso lo decide producción');
  assert.equal(ll.codigo, BUENO);
});

test('un modelo con candado no llega a pedirse', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  const r = await pedir('/api/libre', { cookie, cuerpo: { modelo: 'kling3_0', prompt: 'x' } });
  assert.equal(r.s, 403);
  assert.equal(r.j.bloqueado, true);
  assert.match(r.j.error, /versión completa/);
  assert.equal(panel.llamadas.some((x) => x.metodo === 'POST'), false);
  assert.equal((await pedir('/api/libre', { cookie, cuerpo: { modelo: 'no_existe', prompt: 'x' } })).s, 400);
  assert.equal((await pedir('/api/libre/autoprompt', { cookie, cuerpo: { modelo: 'kling3_0', imagen: { url: 'https://cdn/p.png' } } })).s, 403);
});

test('los modelos llegan con los abiertos primero, y el costo no existe', async () => {
  const cookie = await sesion();
  const { j } = await pedir('/api/modelos', { cookie });
  assert.deepEqual(j.modelos.map((m) => m.id), ['seedance_2_5', 'gpt_image_2_5', 'kling3_0']);
  assert.deepEqual((await pedir('/api/libre/costo', { cookie, cuerpo: { modelo: 'seedance_2_5' } })).j, { creditos: null, precio: null, demo: true });
});

test('la descripción con IA se pide con el tipo del modelo', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  const r = await pedir('/api/libre/autoprompt', { cookie, cuerpo: { modelo: 'gpt_image_2_5', imagen: { url: 'https://cdn/p.png' }, aspecto: '1:1', producto: 'Taladro', instrucciones: 'sobre una mesa', duracion: 30 } });
  assert.equal(r.s, 200);
  assert.deepEqual(r.j, { prompt: 'A product on a table', avisos: [], costoIa: 0, quedan: 5 });
  assert.deepEqual(panel.llamadas.find((x) => x.ruta === '/api/demo/descripcion').cuerpo,
    { tipo: 'imagen', imagen: { url: 'https://cdn/p.png' }, aspecto: '1:1', producto: 'Taladro', instrucciones: 'sobre una mesa' });
});

test('la foto se sube tal cual, con su tipo; otra cosa no pasa', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const r = await pedir('/api/medios', { cookie, crudo: png, cabeceras: { 'content-type': 'image/png', 'x-nombre': 'taladro.png' } });
  assert.equal(r.s, 200);
  assert.equal(r.j.media_id, 'm1');
  const ll = panel.llamadas.find((x) => x.ruta === '/api/demo/medios');
  assert.equal(ll.tipo, 'image/png'); assert.equal(ll.nombre, 'taladro.png');
  assert.equal(Buffer.compare(ll.cuerpo, png), 0);
  panel.llamadas.length = 0;
  assert.equal((await pedir('/api/medios', { cookie, crudo: Buffer.from('MZ...'), cabeceras: { 'content-type': 'application/octet-stream' } })).s, 400);
  assert.equal(panel.llamadas.length, 0);
});

test('descargar entrega el archivo con nombre, y solo lo propio', async () => {
  const cookie = await sesion();
  const r = await pedir('/api/generaciones/7/descargar', { cookie });
  assert.equal(r.s, 200);
  assert.equal(r.j, 'video');
  assert.equal(r.h.get('content-disposition'), 'attachment; filename="marketing_studio_demo_7.mp4"');
  assert.equal((await pedir('/api/generaciones/8/descargar', { cookie })).s, 404, 'lo que producción no reconoce como de este código');
  assert.equal((await pedir('/api/generaciones/7/descargar')).s, 401);
});

// ── Lo que no es de la demo, y los fallos ────────────────────────────────────

test('el resto del panel no existe aquí', async () => {
  const cookie = await sesion();
  panel.llamadas.length = 0;
  for (const [ruta, metodo] of [['/api/superadmin/demo', 'GET'], ['/api/superadmin/config', 'PUT'], ['/api/presets', 'GET'], ['/api/generar', 'POST'], ['/api/publicar', 'POST'], ['/api/demo/generaciones', 'POST'], ['/api/demo/codigos', 'GET']]) {
    const r = await pedir(ruta, { cookie, metodo, cuerpo: metodo === 'GET' ? undefined : { x: 1 } });
    assert.equal(r.s, 404, ruta);
    assert.equal(r.j.completa, true);
  }
  assert.equal(panel.llamadas.length, 0, 'nada de eso se le reenvía a producción');
});

test('si la clave de servicio está mal, es problema nuestro: no se culpa al código', async () => {
  const cookie = await sesion();
  panel.claveMala = true;
  const r = await pedir('/api/me', { cookie });
  assert.equal(r.s, 503);
  assert.equal(r.h.get('set-cookie'), null, 'no se le cierra la sesión al prospecto');
  const e = await pedir('/api/demo/entrar', { cuerpo: { codigo: BUENO }, ip: '203.0.113.30' });
  assert.equal(e.s, 503);
  assert.equal((_intentos.get('203.0.113.30') || []).length, 0, 'ni cuenta como intento fallido');
});

test('si producción no responde, se dice sin detalles', async () => {
  const cookie = await sesion();
  panel.caido = true;
  const r = await pedir('/api/me', { cookie });
  assert.equal(r.s, 502);
  assert.match(r.j.error, /No pudimos conectar/);
  assert.equal(JSON.stringify(r.j).includes('127.0.0.1'), false, 'la dirección de producción no se enseña');
});

test('cabeceras: el enlace con el código no se filtra por el Referer', async () => {
  const r = await pedir('/api/config');
  assert.equal(r.h.get('referrer-policy'), 'no-referrer');
  assert.equal(r.h.get('x-content-type-options'), 'nosniff');
  assert.equal(r.h.get('cache-control'), 'no-store');
  assert.equal(r.h.get('x-powered-by'), null);
});
