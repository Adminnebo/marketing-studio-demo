const test = require('node:test');
const assert = require('node:assert/strict');
const hf = require('../server/lib/higgsfield');
const modelos = require('../server/lib/modelos');

test('declina la recomendacion de preset y repite con el prompt literal', async () => {
  const llamadas = [];
  const original = hf.llamar;
  hf.llamar = async (tool, args) => {
    llamadas.push(args.params);
    if (!args.params.declined_preset_id) return { notice: { type: 'preset_recommendation', message: 'parece IN THE DARK', data: { preset: { id: 'p-dark', name: 'IN THE DARK' } } } };
    return { cost: { credits: 90, credits_exact: 90 } };
  };
  try {
    const c = await modelos.costo({ tool: 'generate_video', params: { model: 'seedance_2_5', prompt: 'breaker en la oscuridad' } });
    assert.equal(c, 90);
    assert.equal(llamadas.length, 2);
    assert.equal(llamadas[1].declined_preset_id, 'p-dark');
    assert.equal(llamadas[1].use_unlim, false);
  } finally { hf.llamar = original; }
});

test('un aviso distinto da error claro y no se queda en bucle', async () => {
  const original = hf.llamar;
  let n = 0;
  hf.llamar = async () => { n++; return { notice: { type: 'unlim_choice', message: 'usar ilimitadas?' } }; };
  try {
    await assert.rejects(modelos.llamarGenerador('generate_video', { model: 'x', prompt: 'y' }), /aviso sin resolver unlim_choice/);
    assert.equal(n, 1);
  } finally { hf.llamar = original; }
});
