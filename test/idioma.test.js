const test = require('node:test');
const assert = require('node:assert/strict');
const { conEspanol, CLAUSULA } = require('../server/lib/idioma');

test('conEspanol: agrega la clausula una sola vez y sirve sin prompt', () => {
  assert.equal(conEspanol(''), CLAUSULA);
  const p = conEspanol('Breaker on a wooden table');
  assert.match(p, /^Breaker on a wooden table\n\nLANGUAGE: Spanish/);
  assert.equal(conEspanol(p), p);
  assert.match(CLAUSULA, /Brand names and model codes printed on the product stay exactly as they are/);
  assert.match(CLAUSULA, /voice-over must be in Spanish/);
});
