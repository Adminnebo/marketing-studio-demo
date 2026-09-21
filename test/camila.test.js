const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY ||= 'sk-prueba';
process.env.SUPABASE_URL ||= 'https://ref.supabase.co';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const cat = require('../server/lib/jh-catalogo');
const camila = require('../server/lib/camila');

// Catalogo simulado: 3 breakers (uno sin foto) y un tomacorriente.
const FILAS = [
  { Codigo: '1001 ', Referencia: 'QOB120', Descripcion: 'BREAKER SQUARE D 1P 20A ATORNILLABLE', Marca: 'SQUARE D', P1: 450.5, Und: 'UND', Inventario: 12 },
  { Codigo: '1002', Referencia: 'QO120', Descripcion: 'BREAKER SQUARE D 1P 20A', Marca: 'SQUARE D', P1: 395, Und: 'UND', Inventario: 40 },
  { Codigo: '1002', Referencia: 'QO120', Descripcion: 'BREAKER SQUARE D 1P 20A', Marca: 'SQUARE D', P1: 395, Und: 'UND', Inventario: 40 },
  { Codigo: '1003', Referencia: 'X', Descripcion: 'BREAKER GENERICO 1P 20A', Marca: 'GENERICA', P1: 150, Und: 'UND', Inventario: 0 },
];
const consultas = [];
cat._simular({
  consulta: async (texto, params) => {
    consultas.push({ texto, params });
    if (params.cod) return FILAS.filter((f) => f.Codigo.trim() === params.cod || f.Referencia === params.cod);
    return params.k0 === '%breaker%' && !Object.values(params).includes('%siemens%') ? FILAS : [];
  },
  listar: async (bucket) => (bucket === cat.BUCKETS.imagen ? ['1002.png', '1003 - copia.png', '1003.png', 'viejos/1004 (2).png'] : ['1002.pdf']),
});

test('la consulta usa parametros, un bloque por palabra y sin comodines del usuario', () => {
  const q = cat.armar({ palabras: ['Bréiker', 'square d', '20%', 'breaker'] });
  assert.deepEqual(q.params, { k0: '%Breiker%', k1: '%square d%', k2: '%20[%]%', k3: '%breaker%' });
  assert.equal((q.texto.split('ORDER BY')[0].match(/Descripcion LIKE @k\d/g) || []).length, 4);
  assert.match(q.texto, /\) AND \(/);
  assert.doesNotMatch(q.texto, /UsoComun LIKE @k1/);
  assert.doesNotMatch(q.texto, /Breiker|square/); // los valores nunca van en el texto SQL
  assert.match(cat.armar({ palabras: ['x'], amplio: true }).texto, /UsoComun LIKE @k0\)/);
  assert.deepEqual(cat.armar({ codigo: " 1002'; DROP --" }).params, { cod: "1002'; DROP --" });
  assert.equal(cat.armar({ palabras: ['  ', ''] }), null);
  assert.deepEqual(cat.armar({ palabras: ['breaker', 'square', 'd'] }).params, { k0: '%breaker%', k1: '%square%' });
  assert.deepEqual(cat.armar({ palabras: ['T'] }).params, { k0: '%T%' });
});

test('indice de fotos: copias y carpetas apuntan al mismo codigo, gana el original', () => {
  const ix = cat.armarIndice(['0774 - copia.png', '0774.png', '11815 (2).png', 'sub/abc.png']);
  assert.equal(ix.get('0774'), '0774.png');
  assert.equal(ix.get('11815'), '11815 (2).png');
  assert.equal(ix.get('ABC'), 'sub/abc.png');
  assert.equal(cat.normalizarNombre('305400 copy (3).PNG'), '305400');
});

test('buscar: sin duplicados, con foto primero y marca GENERICA oculta', async () => {
  const r = await cat.buscar({ palabras: ['breaker'] });
  assert.equal(r.total, 3);
  assert.deepEqual(r.productos.map((p) => p.codigo), ['1002', '1003', '1001']);
  assert.match(r.productos[0].foto, /\/object\/public\/Lucas_imagenes\/1002\.png$/);
  assert.match(r.productos[0].ficha, /Lucas_fichas_tecnicas\/1002\.pdf$/);
  assert.match(r.productos[1].foto, /\/1003\.png$/);
  assert.equal(r.productos[1].marca, null);
  assert.equal(r.productos[2].foto, null);
  assert.deepEqual(await cat.archivosDe('1004'), { imagen: 'https://ref.supabase.co/storage/v1/object/public/Lucas_imagenes/viejos/1004%20(2).png', ficha: null });
});

// IA simulada: responde segun la vuelta.
function iaFalsa(respuestas) {
  const pedidos = [];
  const f = async (url, init) => {
    const cuerpo = JSON.parse(init.body);
    pedidos.push(cuerpo);
    const r = respuestas[pedidos.length - 1];
    return { ok: true, json: async () => ({ model: 'gpt-prueba', usage: { input_tokens: 100, output_tokens: 20 }, ...r }) };
  };
  f.pedidos = pedidos;
  return f;
}
const llamada = (args, id = 'c1') => ({ output: [{ type: 'function_call', call_id: id, name: 'buscar_productos', arguments: JSON.stringify(args) }] });
const final = (d) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(d) }] }] });

test('responder: busca, reintenta y solo muestra codigos que devolvio el catalogo', async () => {
  const ia = iaFalsa([
    llamada({ palabras: ['breaker', 'siemens'], codigo: null, amplio: false }),
    llamada({ palabras: ['breaker'], codigo: null, amplio: false }, 'c2'),
    final({ texto: 'Tengo el QO120 con foto.', productos: ['1002', '9999', '1002', '1001'], sugerencias: ['El atornillable', ''] }),
  ]);
  const r = await camila.responder({ texto: 'bréiker siemens de 20' }, { fetch: ia });
  assert.equal(r.texto, 'Tengo el QO120 con foto.');
  assert.deepEqual(r.productos.map((p) => p.codigo), ['1002', '1001']); // 9999 inventado: fuera
  assert.deepEqual(r.sugerencias, ['El atornillable']);
  assert.deepEqual(r.busquedas.map((b) => [b.palabras.join(' '), b.total, b.conFoto]), [['breaker siemens', 0, 0], ['breaker', 3, 2]]);
  assert.deepEqual(r.tokens, { entrada: 300, salida: 60 });
  // La IA recibe la salida de la herramienta sin URLs y con foto: true/false.
  const salida = JSON.parse(ia.pedidos[2].input.find((i) => i.type === 'function_call_output' && i.call_id === 'c2').output);
  assert.equal(salida.con_foto, 2);
  assert.deepEqual(salida.productos[0], { codigo: '1002', descripcion: 'BREAKER SQUARE D 1P 20A', marca: 'SQUARE D', referencia: 'QO120', precio: 395, unidad: 'UND', inventario: 40, foto: true, ficha: true });
  assert.equal(ia.pedidos[0].tools[0].name, 'buscar_productos');
  assert.equal(ia.pedidos[0].store, false);
});

test('responder: el historial lleva los productos mostrados y sirven sin volver a buscar', async () => {
  const historial = [
    { rol: 'usuario', texto: 'breaker 20A' },
    { rol: 'camila', texto: 'Mira estos', productos: [{ codigo: '1002', descripcion: 'BREAKER SQUARE D 1P 20A', foto: 'https://x/1002.png' }, { codigo: '1001', descripcion: 'BREAKER ATORNILLABLE', foto: null }] },
  ];
  const ia = iaFalsa([final({ texto: 'Perfecto, el primero.', productos: ['1002'], sugerencias: [] })]);
  const r = await camila.responder({ historial, texto: 'el primero' }, { fetch: ia });
  assert.deepEqual(r.productos.map((p) => p.codigo), ['1002']);
  assert.match(ia.pedidos[0].input[1].content, /Productos mostrados: 1002 BREAKER SQUARE D 1P 20A \| 1001 BREAKER ATORNILLABLE \(sin foto\)/);
  assert.equal(ia.pedidos[0].input.at(-1).content, 'el primero');
});

test('responder: si el catalogo falla, la IA se entera y la busqueda queda registrada', async () => {
  cat._simular({ consulta: async () => { throw new Error('timeout'); }, listar: async () => [] });
  const ia = iaFalsa([llamada({ palabras: ['cable'], codigo: null, amplio: false }), final({ texto: 'El catálogo no respondió.', productos: [], sugerencias: [] })]);
  const r = await camila.responder({ texto: 'cable' }, { fetch: ia });
  assert.equal(r.busquedas[0].error, 'timeout');
  assert.match(ia.pedidos[1].input.at(-1).output, /no respondió/);
});

test('responder: errores de la IA salen como mensaje amable', async () => {
  const f = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(camila.responder({ texto: 'x' }, { fetch: f }), (e) => e instanceof camila.ErrorDeCamila && /administrador/.test(e.message) && e.status === 503);
  const g = iaFalsa([{ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no json' }] }] }]);
  await assert.rejects(camila.responder({ texto: 'x' }, { fetch: g }), /enredó/);
});

test('las instrucciones traen las reglas de busqueda de la Camila de WhatsApp', () => {
  for (const r of [/\["toma","cte"\]/, /\["porta","lampara"\]/, /"bombill"/, /quita la medida/, /Nunca inventes códigos/]) assert.match(camila.INSTRUCCIONES, r);
});

// Guardado (Postgres real, como los demas tests de base de datos).
if (!process.env.TEST_DATABASE_URL) {
  test('camila con base de datos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  test('conversar guarda todo por usuario y ultima() la retoma', async () => {
    const { pool } = require('../server/lib/db');
    await camila.migrar();
    await pool.query('TRUNCATE camila_usos, camila_mensajes, camila_conversaciones RESTART IDENTITY');
    cat._simular({ consulta: async () => FILAS, listar: async (b) => (b === cat.BUCKETS.imagen ? ['1002.png'] : []) });
    const yo = { id: '16ef13cc-6645-4fd6-8d56-09a5f8038d45', email: 'yo@x' };
    const ia1 = iaFalsa([llamada({ palabras: ['breaker'], codigo: null, amplio: false }), final({ texto: 'Este tiene foto.', productos: ['1002'], sugerencias: ['Otro'] })]);
    const r1 = await camila.conversar({ user: yo, texto: 'breaker de 20' }, { fetch: ia1 });
    assert.equal(r1.camila.productos[0].codigo, '1002');
    // Otro usuario no puede seguir mi conversacion: se le abre una nueva.
    const ia2 = iaFalsa([final({ texto: 'Hola', productos: [], sugerencias: [] })]);
    const r2 = await camila.conversar({ user: { email: 'otro@x' }, conversacionId: r1.conversacionId, texto: 'hola' }, { fetch: ia2 });
    assert.notEqual(r2.conversacionId, r1.conversacionId);
    // Un error queda guardado como respuesta de Camila.
    await assert.rejects(camila.conversar({ user: yo, conversacionId: r1.conversacionId, texto: 'x' }, { fetch: async () => ({ ok: false, status: 500, text: async () => '' }) }));
    const u = await camila.ultima('yo@x');
    assert.equal(u.id, r1.conversacionId);
    assert.deepEqual(u.mensajes.map((m) => m.rol), ['usuario', 'camila', 'usuario', 'camila']);
    const { rows: [m] } = await pool.query("SELECT busquedas, tokens_entrada, error FROM camila_mensajes WHERE rol = 'camila' ORDER BY id LIMIT 1");
    assert.equal(m.busquedas[0].total, 3);
    assert.equal(m.tokens_entrada, 200);
    await camila.registrarUso({ email: 'yo@x', conversacionId: r1.conversacionId, codigo: '1002', descripcion: 'B', mediaId: 'm1' });
    assert.equal((await pool.query('SELECT count(*)::int n FROM camila_usos')).rows[0].n, 1);
    await pool.end();
  });
}
