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
