const test = require('node:test');
const assert = require('node:assert/strict');
const pa = require('../server/lib/prompt-auto');

test('tramos del video en 40/40/20 como el manual V2', () => {
  assert.deepEqual(pa.tramos(5), ['00:00-00:02', '00:02-00:04', '00:04-00:05']);
  assert.deepEqual(pa.tramos(10), ['00:00-00:04', '00:04-00:08', '00:08-00:10']);
  assert.match(pa.ritmo(5), /como máximo dos verbos/);
  assert.match(pa.ritmo(8), /hasta tres verbos/);
});

test('pedido de video: reglas de video, imagen, tramos, audio y formato', () => {
  const b = pa.pedido({ imagenUrl: 'https://cdn/x.png', tipo: 'video', duracion: 5, conAudio: false, aspecto: '16:9', producto: 'Breaker 2P 40A', instrucciones: 'con mano' });
  assert.equal(b.instructions, pa.INSTRUCCIONES_VIDEO);
  const [img, txt] = b.input[0].content;
  assert.deepEqual(img, { type: 'input_image', image_url: 'https://cdn/x.png', detail: 'high' });
  assert.match(txt.text, /00:00-00:02, 00:02-00:04 y 00:04-00:05/);
  assert.match(txt.text, /no lleva audio/);
  assert.match(txt.text, /16:9 horizontal/);
  assert.match(txt.text, /"Breaker 2P 40A"/);
  assert.match(txt.text, /"con mano"/);
  assert.equal(b.text.format.strict, true);
});

test('pedido de foto usa las reglas de foto; sin imagen https falla', () => {
  const b = pa.pedido({ imagenUrl: 'https://cdn/x.png', tipo: 'imagen', aspecto: '1:1' });
  assert.equal(b.instructions, pa.INSTRUCCIONES_FOTO);
  assert.match(b.input[0].content[1].text, /escena por defecto/);
  assert.throws(() => pa.pedido({ imagenUrl: 'http://x', tipo: 'video' }), pa.ErrorDePrompt);
});

test('las reglas bloquean lo critico de ferreteria', () => {
  for (const r of [pa.INSTRUCCIONES_VIDEO, pa.INSTRUCCIONES_FOTO]) {
    assert.match(r, /No sparks, no electrical arcs, no smoke, no fire/);
    assert.match(r, /No invented, altered, translated or misspelled text/);
    assert.match(r, /fila por fila/);
  }
  assert.match(pa.INSTRUCCIONES_VIDEO, /Nunca abras puertas, tapas/);
  assert.match(pa.INSTRUCCIONES_VIDEO, /Ninguna parte se mueve sola/);
});

test('leer: prompt y avisos; rechazo y respuesta cortada dan error claro', () => {
  const ok = pa.leer({ status: 'completed', model: 'gpt-4.1', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ prompt: 'x'.repeat(250), avisos: [' conteo dudoso ', ''] }) }] }], usage: { input_tokens: 10, output_tokens: 20 } });
  assert.equal(ok.prompt.length, 250);
  assert.deepEqual(ok.avisos, ['conteo dudoso']);
  assert.throws(() => pa.leer({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /no terminó/);
  assert.throws(() => pa.leer({ output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }), /no quiso/);
  assert.throws(() => pa.leer({ output: [{ content: [{ type: 'output_text', text: '{"prompt":"corto","avisos":[]}' }] }] }), /incompleto/);
});

test('modo guiado: el pedido manda y los tramos pasan a ser sugeridos', () => {
  const guiado = pa.pedido({ imagenUrl: 'https://cdn/x.png', tipo: 'video', duracion: 10, instrucciones: 'arranca en una obra, un obrero se pone el casco' });
  const t = guiado.input[0].content[1].text;
  assert.match(t, /MODO GUIADO/);
  assert.match(t, /Tramos por defecto/);
  assert.match(t, /repartí esos mismos 10 segundos/);
  assert.match(t, /no lo conviertas en un plano de catálogo/i);
  const producto = pa.pedido({ imagenUrl: 'https://cdn/x.png', tipo: 'video', duracion: 10 });
  const tp = producto.input[0].content[1].text;
  assert.match(tp, /MODO PRODUCTO/);
  assert.match(tp, /Tramos de SHOT SEQUENCE: 00:00-00:04/);
  assert.doesNotMatch(tp, /por defecto de SHOT SEQUENCE/);
});

test('corrección: lleva el prompt rechazado, el motivo y sus reglas', () => {
  const b = pa.pedido({
    imagenUrl: 'https://cdn/x.png', tipo: 'video', duracion: 5, instrucciones: 'un técnico prueba el breaker',
    correccion: { prompt: 'PRODUCT: "Pretul" ... No bare skin.', motivo: 'nsfw' },
  });
  const t = b.input[0].content[1].text;
  assert.match(t, /CORRECCIÓN/);
  assert.match(t, /contenido sensible/);
  assert.match(t, /No bare skin\./);              // el prompt rechazado va completo
  assert.match(t, /"bare skin"/);                  // y las palabras a reemplazar
  assert.match(t, /prompt corregido/);
  assert.match(t, /misma duración/);
  const c = pa.pedido({ imagenUrl: 'https://cdn/x.png', tipo: 'imagen', correccion: { prompt: 'Siemens 5SX1', motivo: 'copyright' } });
  assert.match(c.input[0].content[1].text, /marcas registradas/);
  assert.match(c.input[0].content[1].text, /without transcribing them/);
});

test('corrección de texto de plantilla: sin foto y con las reglas del motivo', () => {
  const b = pa.pedidoDeTexto({ texto: 'un electricista sin camisa instala el breaker', motivo: 'nsfw' });
  assert.equal(b.instructions, pa.INSTRUCCIONES_TEXTO);
  assert.equal(b.input[0].content.length, 1);
  assert.equal(b.input[0].content[0].type, 'input_text');
  assert.match(b.input[0].content[0].text, /sin camisa/);
  assert.match(b.input[0].content[0].text, /piel descubierta/);
  assert.throws(() => pa.pedidoDeTexto({ texto: '  ', motivo: 'nsfw' }), /No hay texto/);
});
