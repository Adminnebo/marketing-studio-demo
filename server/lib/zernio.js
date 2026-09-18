/**
 * Cliente minimo de la API de Zernio (https://zernio.com/api/v1): conecta
 * cuentas de redes (OAuth alojado por Zernio) y publica/programa posts.
 * Todas las cuentas del panel viven en un solo "perfil" de Zernio; su id se
 * guarda en la tabla config (o se fija con ZERNIO_PROFILE_ID).
 */
const { pool } = require('./db');

const BASE = (process.env.ZERNIO_API_URL || 'https://zernio.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.ZERNIO_API_KEY || '';
const NOMBRE_PERFIL = process.env.ZERNIO_PROFILE_NAME || 'JH Marketing';

class ZernioError extends Error {
  constructor(msg, { status = 0, codigo = null, detalle = null } = {}) {
    super(msg);
    this.status = status;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

const configurado = () => !!API_KEY;

async function llamar(metodo, ruta, { query, body, headers = {}, timeoutMs = 30000 } = {}) {
  if (!API_KEY) throw new ZernioError('Falta ZERNIO_API_KEY', { status: 0, codigo: 'sin_api_key' });
  const url = new URL(BASE + ruta);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: metodo,
    headers: { authorization: 'Bearer ' + API_KEY, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : {}; } catch { j = { texto }; }
  if (!r.ok) {
    const msg = (typeof j.error === 'string' ? j.error : j.error?.message) || j.message || `HTTP ${r.status}`;
    throw new ZernioError(`${metodo} ${ruta}: ${msg}`, { status: r.status, codigo: j.code || j.error?.code || j.reason || null, detalle: j });
  }
  return j;
}

// Perfil unico del panel: config -> ZERNIO_PROFILE_ID -> uno existente con el nombre -> se crea.
async function perfilId() {
  const { rows } = await pool.query(`SELECT valor FROM config WHERE clave = 'zernio_profile_id'`);
  if (rows[0]) return rows[0].valor;
  let id = process.env.ZERNIO_PROFILE_ID || null;
  if (!id) {
    const lista = await llamar('GET', '/profiles');
    const existente = (lista.profiles || []).find((p) => p.name === NOMBRE_PERFIL);
    id = existente?._id || (await llamar('POST', '/profiles', { body: { name: NOMBRE_PERFIL } })).profile._id;
  }
  await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_profile_id', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [id]);
  return id;
}

async function cuentas() {
  const d = await llamar('GET', '/accounts', { query: { profileId: await perfilId() } });
  return (d.accounts || []).map((a) => ({
    id: a._id, plataforma: a.platform, usuario: a.username || null, nombre: a.displayName || a.username || null,
    foto: a.profilePicture || null, url: a.profileUrl || null,
    activa: a.isActive !== false, reconectar: !!a.needsReconnection,
  }));
}

async function urlConexion(plataforma, redirectUrl) {
  const d = await llamar('GET', `/connect/${encodeURIComponent(plataforma)}`, { query: { profileId: await perfilId(), redirect_url: redirectUrl } });
  if (!d.authUrl) throw new ZernioError('La conexión no devolvió URL de autorización');
  return d.authUrl;
}

const desconectar = (cuentaId) => llamar('DELETE', `/accounts/${encodeURIComponent(cuentaId)}`);
const infoTiktok = (cuentaId, tipo) => llamar('GET', `/accounts/${encodeURIComponent(cuentaId)}/tiktok/creator-info`, { query: { mediaType: tipo } });

// requestId hace el create idempotente (reintentos devuelven el mismo post).
const crearPost = (cuerpo, requestId) => llamar('POST', '/posts', { body: cuerpo, headers: { 'x-request-id': requestId }, timeoutMs: 90000 });
const leerPost = (postId) => llamar('GET', `/posts/${encodeURIComponent(postId)}`);
const borrarPost = (postId) => llamar('DELETE', `/posts/${encodeURIComponent(postId)}`);

module.exports = { configurado, llamar, perfilId, cuentas, urlConexion, desconectar, infoTiktok, crearPost, leerPost, borrarPost, ZernioError };
