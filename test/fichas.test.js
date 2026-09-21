const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY ||= 'sk-prueba';
process.env.SUPABASE_URL ||= 'https://ref.supabase.co';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const cat = require('../server/lib/jh-catalogo');
const fichas = require('../server/lib/fichas');

const RESP = { model: 'gpt-prueba', usage: { input_tokens: 1836, output_tokens: 299 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
  producto: 'Panel LED Slim V2', datos: [{ dato: 'Potencia', valor: '40 W' }, { dato: 'Flujo luminoso', valor: '3,200 lm' }, { dato: '', valor: 'x' }],
  visibles: ['panel blanco', 'diseño ultra delgado'], texto: 'Panel LED blanco y ultra delgado de 40 W y 3,200 lm.', sin_datos: false,
}) }] }] };

test('pedido: la IA lee el PDF desde la URL del bucket con respuesta estructurada', () => {
  const b = fichas.pedido('https://ref.supabase.co/storage/v1/object/public/Lucas_fichas_tecnicas/301383.pdf');
  assert.deepEqual(b.input[0].content[0], { type: 'input_file', file_url: 'https://ref.supabase.co/storage/v1/object/public/Lucas_fichas_tecnicas/301383.pdf' });
  assert.equal(b.text.format.strict, true);
  assert.equal(b.store, false);
  assert.match(fichas.INSTRUCCIONES, /Nunca inventes/);
});

test('leer: limpia pares vacios y respeta los topes', () => {
  const d = fichas.leer(RESP);
  assert.equal(d.producto, 'Panel LED Slim V2');
  assert.deepEqual(d.datos, [{ dato: 'Potencia', valor: '40 W' }, { dato: 'Flujo luminoso', valor: '3,200 lm' }]);
  assert.equal(d.sinDatos, false);
  assert.throws(() => fichas.leer({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'no json' }] }] }), fichas.ErrorDeFicha);
});

if (!process.env.TEST_DATABASE_URL) {
  test('extraer con base de datos (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  test('extraer: sin ficha no llama a la IA; con ficha la lee una sola vez y la guarda', async () => {
    const { pool } = require('../server/lib/db');
    await fichas.migrar();
    await pool.query('TRUNCATE camila_fichas');
    cat._simular({ listar: async (b) => (b === cat.BUCKETS.ficha ? ['301383.pdf'] : ['301383.png', '15.png']) });
    let llamadas = 0;
    const f = async (url, init) => { llamadas++; assert.match(JSON.parse(init.body).input[0].content[0].file_url, /301383\.pdf$/); return { ok: true, json: async () => RESP }; };
    assert.deepEqual(await fichas.extraer('15', { fetch: f }), { sinFicha: true });
    assert.equal(llamadas, 0);
    const r1 = await fichas.extraer('301383', { fetch: f });
    assert.equal(r1.guardada, false);
    assert.equal(r1.datos[0].valor, '40 W');
    const r2 = await fichas.extraer('301383', { fetch: f });
    assert.equal(r2.guardada, true);
    assert.equal(llamadas, 1);
    const { rows: [g] } = await pool.query('SELECT tokens_entrada, archivo FROM camila_fichas WHERE codigo = $1', ['301383']);
    assert.equal(g.tokens_entrada, 1836);
    assert.deepEqual(await fichas.extraer('302000', { fetch: f }), { sinFicha: true }); // codigo sin ficha: aviso, no error
    await pool.end();
  });
}
