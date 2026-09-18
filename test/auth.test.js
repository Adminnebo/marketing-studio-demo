const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'secreto-de-prueba';
const auth = require('../server/lib/auth');
const HASH = auth.hashPassword('Clave-Prueba1');
process.env.PANEL_USUARIOS = `edmond@neboaiconsulting.com:${HASH}`;

function resMock() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('hash y verificacion', () => {
  assert.ok(auth.verificarPassword('Clave-Prueba1', HASH));
  assert.ok(!auth.verificarPassword('otra', HASH));
  assert.ok(!auth.verificarPassword('Clave-Prueba1', 'basura'));
});

test('login correcto emite token valido; incorrecto da 401', () => {
  const ok = resMock();
  auth.login({ body: { email: 'EDMOND@neboaiconsulting.com ', password: 'Clave-Prueba1' }, ip: '1' }, ok);
  assert.equal(ok.code, 200);
  assert.equal(auth.leerToken(ok.body.token).email, 'edmond@neboaiconsulting.com');
  const mal = resMock();
  auth.login({ body: { email: 'edmond@neboaiconsulting.com', password: 'x' }, ip: '1' }, mal);
  assert.equal(mal.code, 401);
});

test('token alterado o de usuario quitado no sirve', () => {
  const t = auth.emitirToken('edmond@neboaiconsulting.com');
  assert.equal(auth.leerToken(t.slice(0, -2) + 'xx'), null);
  assert.equal(auth.leerToken(auth.emitirToken('otro@x.com')), null);
});

test('bloquea tras 8 fallos', () => {
  let r;
  for (let i = 0; i < 9; i++) { r = resMock(); auth.login({ body: { email: 'edmond@neboaiconsulting.com', password: 'no' }, ip: '9' }, r); }
  assert.equal(r.code, 429);
});
