/**
 * Login con el mismo Supabase que los otros paneles (Conversaciones,
 * Cotizaciones, Cobranzas). El navegador inicia sesion con Supabase y manda el
 * access_token en Authorization: Bearer; aqui se verifica y se resuelve el rol.
 *
 * Acceso a este panel:
 *  - super_admin (profiles.role): siempre, con todo y la pestaña Super Admin.
 *  - el resto: solo si un super_admin le dio acceso desde Super Admin (tabla
 *    accesos de ESTE panel, no profiles.permissions: los editores de usuarios
 *    de los otros paneles reescriben esa lista y borrarian el acceso).
 */
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { pool } = require('./db');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const configurado = () => !!(SUPABASE_URL && ANON_KEY && SERVICE_KEY);
const JWKS = SUPABASE_URL ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) : null;

function algDe(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).alg; } catch { return null; }
}

async function verificar(token) {
  const opts = { issuer: `${SUPABASE_URL}/auth/v1` };
  if (algDe(token) === 'HS256') {
    if (!JWT_SECRET) throw new Error('HS256 sin JWT secret');
    return (await jwtVerify(token, new TextEncoder().encode(JWT_SECRET), { ...opts, algorithms: ['HS256'] })).payload;
  }
  return (await jwtVerify(token, JWKS, opts)).payload;
}

// ── profiles (Supabase, via service key) ──
const svc = () => ({ apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY });
const _perfiles = new Map(); // id -> { p, exp }
async function perfil(id) {
  const hit = _perfiles.get(id);
  if (hit && hit.exp > Date.now()) return hit.p;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,email,full_name,role`, { headers: svc() });
  if (!r.ok) throw new Error('No se pudo leer el perfil (HTTP ' + r.status + ')');
  const p = (await r.json())[0] || null;
  _perfiles.set(id, { p, exp: Date.now() + 60e3 });
  return p;
}

async function perfiles() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,email,full_name,role&order=email`, { headers: svc() });
  if (!r.ok) throw new Error('No se pudo leer la lista de usuarios (HTTP ' + r.status + ')');
  return r.json();
}

// Rol dentro de ESTE panel: 'super_admin' | 'admin' | 'usuario' | null (sin acceso).
async function rolMarketing(userId) {
  const p = await perfil(userId);
  if (p?.role === 'super_admin') return { rol: 'super_admin', perfil: p };
  const { rows } = await pool.query('SELECT rol, puede_publicar FROM accesos WHERE user_id = $1', [userId]);
  return { rol: rows[0]?.rol || null, perfil: p, puedePublicar: !!rows[0]?.puede_publicar };
}

// Solo verifica la sesion (sin exigir acceso al panel): req.user = { id, email }.
async function sesion(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Inicia sesión.' });
  try {
    const p = await verificar(token);
    req.user = { id: p.sub, email: (p.email || '').toLowerCase() };
    next();
  } catch {
    res.status(401).json({ error: 'Sesión vencida. Vuelve a entrar.' });
  }
}

// Sesion + acceso a este panel: req.user.rol
function requireAcceso(req, res, next) {
  sesion(req, res, async () => {
    try {
      const { rol, perfil: p, puedePublicar } = await rolMarketing(req.user.id);
      if (!rol) return res.status(403).json({ error: 'Tu usuario no tiene acceso a Marketing. Pídeselo a un super admin.', sinAcceso: true });
      req.user.rol = rol;
      req.user.rolReal = rol;
      req.user.nombre = p?.full_name || null;
      // "Ver como": un super_admin puede ver el panel con los permisos de un rol menor.
      // Solo baja permisos, nunca los sube, y solo lo honra para super_admin.
      const verComo = String(req.headers['x-ver-como'] || '');
      if (rol === 'super_admin' && ['admin', 'usuario'].includes(verComo)) req.user.rol = verComo;
      // Publicar en redes: permiso puntual; los super admin siempre (menos en "Ver como").
      req.user.puedePublicar = rol === 'super_admin' ? req.user.rol === 'super_admin' : puedePublicar;
      next();
    } catch (e) {
      console.error('[auth]', e.message);
      res.status(503).json({ error: 'No se pudo verificar tu acceso. Intenta de nuevo.' });
    }
  });
}

// Nivel minimo: usuario < admin < super_admin
const NIVEL = { usuario: 1, admin: 2, super_admin: 3 };
const requireRol = (min) => (req, res, next) => (
  NIVEL[req.user?.rol] >= NIVEL[min] ? next() : res.status(403).json({ error: 'No tienes permiso para esto.' })
);

const configPublica = () => ({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: ANON_KEY });

function _limpiarCache(id) { if (id) _perfiles.delete(id); else _perfiles.clear(); }

module.exports = { configurado, sesion, requireAcceso, requireRol, rolMarketing, perfiles, configPublica, NIVEL, _limpiarCache };
