const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY ||= 'sk-prueba';
const c = require('../server/lib/captions');

test('limpiarTag: #, sin tildes ni espacios ni simbolos', () => {
  assert.equal(c.limpiarTag('Iluminación LED'), '#IluminacionLED');
  assert.equal(c.limpiarTag('##RepúblicaDominicana'), '#RepublicaDominicana');
  assert.equal(c.limpiarTag('#a'), null);
  assert.equal(c.limpiarTag(''), null);
});

test('leer: marca primero, sin repetidos y caption al largo pedido', () => {
  const r = { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
    caption: 'x'.repeat(500),
    hashtags: [{ tag: '#PanelLED', tipo: 'producto' }, { tag: '#panelled', tipo: 'producto' }, { tag: '#JHElectroAlambres', tipo: 'marca' }, { tag: '#RD', tipo: 'local' }],
  }) }] }] };
  const d = c.leer(r, 200);
  assert.equal(d.caption.length, 200);
  assert.deepEqual(d.hashtags.map((h) => h.tag), ['#JHElectroAlambres', '#PanelLED', '#RD']);
  const sinMarca = c.leer({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ caption: 'Hola', hashtags: [{ tag: '#Breaker', tipo: 'producto' }] }) }] }] }, 100);
  assert.equal(sinMarca.hashtags[0].tag, '#JHElectroAlambres'); // se agrega si la IA la olvida
});

test('pedido: imagen, tono, largo, ficha y reglas de no inventar', () => {
  const b = c.pedido({ imagenUrl: 'https://x/y.png', ctx: { producto: 'Panel LED 2x2', codigo: '301383', ficha: { datos: [{ dato: 'Potencia', valor: '40 W' }] } }, redes: ['Instagram'], tono: 'promocion', indicaciones: 'para oficinas', largo: 900 });
  const txt = b.input[0].content[1].text;
  assert.equal(b.input[0].content[0].image_url, 'https://x/y.png');
  assert.match(txt, /Largo máximo del caption: 900/);
  assert.match(txt, /código 301383/);
  assert.match(txt, /40 W/);
  assert.match(txt, /para oficinas/);
  assert.match(txt, new RegExp(c.TONOS.promocion.slice(0, 20)));
  assert.match(c.INSTRUCCIONES, /Nunca inventes datos, precios/);
  assert.equal(b.text.format.strict, true);
});
