const test = require('node:test');
const assert = require('node:assert/strict');
const { _internos: { leerRespuesta, datosDe } } = require('../server/lib/higgsfield');

test('lee respuesta SSE y elige el mensaje con nuestro id', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"structuredContent":{"credits":1}}}\n';
  const m = leerRespuesta(sse, 'text/event-stream', 7);
  assert.equal(m.id, 7);
  assert.deepEqual(datosDe(m.result), { credits: 1 });
});

test('sin structuredContent usa el JSON del texto, o el texto crudo', () => {
  assert.deepEqual(datosDe({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.deepEqual(datosDe({ content: [{ type: 'text', text: 'hola' }] }), { texto: 'hola' });
  assert.equal(datosDe({}), null);
});
