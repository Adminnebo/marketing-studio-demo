const test = require('node:test');
const assert = require('node:assert/strict');
const { precioDe, precioCredito } = require('../server/lib/config');

test('precio por credito = costo x (1 + margen)', () => {
  const a = { usd_por_credito: 26 / 500, margen_pct: 20 };
  assert.ok(Math.abs(precioCredito(a) - 0.0624) < 1e-9);
  const p = precioDe(a, 'product_shots', 21);
  assert.ok(Math.abs(p.costo - 1.092) < 1e-9);
  assert.ok(Math.abs(p.precio - 1.3104) < 1e-9);
  assert.equal(p.margen, 20);
});

test('sin costo no hay precio', () => {
  assert.equal(precioCredito({ usd_por_credito: 0, margen_pct: 20 }), null);
  assert.equal(precioDe({ usd_por_credito: 0, margen_pct: 20 }, 'ads', 7.5).precio, null);
  assert.equal(precioDe({ usd_por_credito: 0.05, margen_pct: 20 }, 'ads', null).precio, null);
});
