const test = require('node:test');
const assert = require('node:assert/strict');
const { precioDe } = require('../server/lib/config');

test('precio = creditos x costo x (1 + margen), con margen por tipo', () => {
  const a = { usd_por_credito: 0.05, margen_pct: 40, margen_por_tipo: { ugc: 25 } };
  const foto = precioDe(a, 'product_shots', 1.5);
  assert.equal(foto.margen, 40);
  assert.ok(Math.abs(foto.costo - 0.075) < 1e-9);
  assert.ok(Math.abs(foto.precio - 0.105) < 1e-9);
  const ugc = precioDe(a, 'ugc', 65);
  assert.equal(ugc.margen, 25);
  assert.ok(Math.abs(ugc.precio - 4.0625) < 1e-9);
});

test('sin costo por credito o sin creditos no hay precio', () => {
  assert.deepEqual(precioDe({ usd_por_credito: 0, margen_pct: 40, margen_por_tipo: {} }, 'ads', 7.5), { costo: null, precio: null, margen: null });
  assert.equal(precioDe({ usd_por_credito: 0.05, margen_pct: 40, margen_por_tipo: {} }, 'ads', null).precio, null);
});
