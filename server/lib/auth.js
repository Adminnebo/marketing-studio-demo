/**
 * Login propio del panel (mientras se prueba, sin tocar el Supabase de
 * produccion). Usuarios en PANEL_USUARIOS = "correo:hash,correo:hash"; el hash
 * es scrypt (npm run hash-password). La sesion es un token firmado con HMAC que
 * el navegador manda en Authorization: Bearer.
 */
const crypto = require('crypto');

const SECRETO = process.env.SESSION_SECRET || '';
const DURACION_MS = 12 * 60 * 60 * 1000;

function usuarios() {
  const m = new Map();
  for (const par of (process.env.PANEL_USUARIOS || '').split(',')) {
    const i = par.indexOf(':');
    if (i > 0) m.set(par.slice(0, i).trim().toLowerCase(), par.slice(i + 1).trim());
  }
  return m;
}

// Formato: scrypt$<salt b64url>$<hash b64url>
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verificarPassword(password, guardado) {
  const [alg, salt, hash] = (guardado || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const esperado = Buffer.from(hash, 'base64url');
  const real = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), esperado.length);
  return crypto.timingSafeEqual(esperado, real);
}

const firmar = (datos) => crypto.createHmac('sha256', SECRETO).update(datos).digest('base64url');

function emitirToken(email) {
  const datos = Buffer.from(JSON.stringify({ email, exp: Date.now() + DURACION_MS })).toString('base64url');
  return `${datos}.${firmar(datos)}`;
}

function leerToken(token) {
  const [datos, firma] = (token || '').split('.');
  if (!datos || !firma || !SECRETO) return null;
  const a = Buffer.from(firma), b = Buffer.from(firmar(datos));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(datos, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    if (!usuarios().has(p.email)) return null; // usuario quitado = sesion invalida
    return p;
  } catch { return null; }
}

// Freno simple a fuerza bruta: 8 fallos por IP+correo cada 15 min.
const fallos = new Map();
function bloqueado(clave) {
  const f = fallos.get(clave);
  if (!f || f.hasta < Date.now()) { fallos.delete(clave); return false; }
  return f.n >= 8;
}
function anotarFallo(clave) {
  const f = fallos.get(clave);
  if (!f || f.hasta < Date.now()) fallos.set(clave, { n: 1, hasta: Date.now() + 15 * 60 * 1000 });
  else f.n++;
}

function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const clave = (req.ip || '') + '|' + email;
  if (bloqueado(clave)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const guardado = usuarios().get(email);
  if (!guardado || !verificarPassword(password, guardado)) {
    anotarFallo(clave);
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  fallos.delete(clave);
  res.json({ token: emitirToken(email), email });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const p = leerToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return res.status(401).json({ error: 'Sesión vencida. Vuelve a entrar.' });
  req.user = { email: p.email };
  next();
}

function configurado() { return !!SECRETO && usuarios().size > 0; }

module.exports = { login, requireAuth, hashPassword, verificarPassword, emitirToken, leerToken, configurado };
