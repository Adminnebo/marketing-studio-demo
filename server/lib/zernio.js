/**
 * Cliente minimo de la API de Zernio (https://zernio.com/api/v1): conecta
 * cuentas de redes (OAuth alojado por Zernio) y publica/programa posts.
 * Todas las cuentas del panel viven en un solo "perfil" de Zernio; su id se
 * guarda en la tabla config (o se fija con ZERNIO_PROFILE_ID).
 *
 * La cuenta de Zernio es compartida con otros proyectos (Nebo, otros clientes):
 * el panel NUNCA crea perfiles ni toca los ajenos. Sin perfil elegido toma el unico
 * con "JH" en el nombre; si no hay uno claro, se elige en Super Admin.
 */
const { pool } = require('./db');

const BASE = (process.env.ZERNIO_API_URL || 'https://zernio.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.ZERNIO_API_KEY || '';
const PISTA_PERFIL = new RegExp(process.env.ZERNIO_PROFILE_HINT || '\\bJH\\b', 'i');

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

const idDe = (x) => (x && typeof x === 'object' ? x._id : x) || null;
const guardarConfig = (clave, valor) => pool.query(
  `INSERT INTO config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [clave, valor]);

// Perfiles de la cuenta de Zernio con sus redes (para elegir en Super Admin).
async function perfiles() {
  const [{ profiles = [] }, { accounts = [] }] = await Promise.all([llamar('GET', '/profiles'), llamar('GET', '/accounts')]);
  return profiles.map((p) => ({
    id: p._id, nombre: p.name,
    cuentas: accounts.filter((a) => idDe(a.profileId) === p._id).map((a) => ({
      plataforma: a.platform, usuario: a.username || a.displayName || null, activa: a.isActive !== false, reconectar: !!a.needsReconnection,
    })),
  }));
}

// Perfil del panel: config -> ZERNIO_PROFILE_ID -> el unico con "JH" en el nombre. Nunca crea uno.
async function perfilId() {
  const { rows } = await pool.query(`SELECT valor FROM config WHERE clave = 'zernio_profile_id'`);
  if (rows[0]?.valor) return rows[0].valor;
  let id = process.env.ZERNIO_PROFILE_ID || null;
  if (!id) {
    const { profiles = [] } = await llamar('GET', '/profiles');
    const candidatos = profiles.filter((p) => PISTA_PERFIL.test(p.name || ''));
    if (candidatos.length !== 1) throw new ZernioError('Falta elegir el perfil de redes', { codigo: 'sin_perfil' });
    id = candidatos[0]._id;
  }
  await guardarConfig('zernio_profile_id', id);
  return id;
}

async function elegirPerfil(id) {
  const { profiles = [] } = await llamar('GET', '/profiles');
  const p = profiles.find((x) => x._id === id);
  if (!p) throw new ZernioError('Ese perfil no existe en la cuenta de Zernio', { status: 404, codigo: 'perfil_inexistente' });
  await guardarConfig('zernio_profile_id', id);
  return { id: p._id, nombre: p.name };
}

async function perfilElegido() {
  const { rows } = await pool.query(`SELECT valor FROM config WHERE clave = 'zernio_profile_id'`);
  return rows[0]?.valor || process.env.ZERNIO_PROFILE_ID || null;
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
// Cambiar la fecha de una programada (Zernio acepta editar posts 'scheduled').
const reprogramarPost = (postId, scheduledFor, timezone) => llamar('PUT', `/posts/${encodeURIComponent(postId)}`, { body: { scheduledFor, timezone } });

// ── Webhooks: Zernio avisa cuando un post sale, falla o una cuenta se desconecta ──
const SECRETO_WEBHOOK = process.env.ZERNIO_WEBHOOK_SECRET || '';
const EVENTOS = [
  'post.scheduled', 'post.published', 'post.partial', 'post.failed', 'post.cancelled',
  'post.platform.published', 'post.platform.failed', 'post.platform.deleted',
  'account.connected', 'account.disconnected',
];
const webhookListo = () => !!(API_KEY && SECRETO_WEBHOOK);

const NOMBRE_WEBHOOK = 'Marketing JH';
const RUTA_WEBHOOK = '/api/zernio/webhook';

const rutaDe = (u) => { try { return new URL(u).pathname; } catch { return null; } };
// Para MOSTRAR: cualquiera que lleve nuestro nombre o nuestra ruta.
const pareceNuestro = (w) => w?.name === NOMBRE_WEBHOOK || rutaDe(w?.url) === RUTA_WEBHOOK;
// Para BORRAR: las dos cosas a la vez. La cuenta de Zernio es compartida con
// otros proyectos y no se puede tocar nada que no sea inequivocamente nuestro.
const seguroBorrar = (w) => w?.name === NOMBRE_WEBHOOK && rutaDe(w?.url) === RUTA_WEBHOOK;

const webhookGuardado = () => pool.query(`SELECT valor FROM config WHERE clave = 'zernio_webhook_id'`)
  .then((r) => r.rows[0]?.valor || null).catch(() => null);

/**
 * Registra (o mueve) el webhook del panel en Zernio.
 *
 * Busca el nuestro en este orden: el id que ya teniamos anotado, el de la misma
 * URL, el del mismo nombre. Buscar SOLO por URL —como hacia antes— dejaba un
 * huerfano cada vez que cambiaba el dominio: creaba uno nuevo y el viejo seguia
 * activo, asi que cada evento llegaba dos veces. La deduplicacion por id de
 * evento lo hacia inofensivo, pero quedaba basura en una cuenta compartida.
 */
async function asegurarWebhook(base) {
  if (!webhookListo()) return { ok: false, motivo: !API_KEY ? 'sin_api_key' : 'sin_secreto' };
  const url = `${base.replace(/\/+$/, '')}${RUTA_WEBHOOK}`;
  const { webhooks = [] } = await llamar('GET', '/webhooks/settings');
  const guardado = await webhookGuardado();
  const hay = (guardado && webhooks.find((w) => w._id === guardado))
    || webhooks.find((w) => w.url === url)
    || webhooks.find((w) => w.name === NOMBRE_WEBHOOK);
  const cuerpo = { name: NOMBRE_WEBHOOK, url, secret: SECRETO_WEBHOOK, events: EVENTOS, isActive: true };
  const r = hay ? await llamar('PUT', '/webhooks/settings', { body: { _id: hay._id, ...cuerpo } }) : await llamar('POST', '/webhooks/settings', { body: cuerpo });
  const id = r.webhook?._id || hay?._id;
  await pool.query(`INSERT INTO config (clave, valor) VALUES ('zernio_webhook_id', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [id || '']);
  // Los que sobran NO se borran solos: la cuenta es compartida. Se avisan para
  // que un super admin decida (Super Admin -> Redes).
  const sobran = webhooks.filter((w) => pareceNuestro(w) && w._id !== id)
    .map((w) => ({ id: w._id, nombre: w.name, url: w.url, ultimo: w.lastFiredAt || null, fallos: w.failureCount || 0, borrable: seguroBorrar(w) }));
  if (sobran.length) {
    console.warn(`[zernio] AVISO: hay ${sobran.length} webhook/s nuestro/s de más (${sobran.map((w) => w.url).join(', ')}). Cada evento llega repetido; se limpian desde Super Admin → Redes.`);
  }
  return { ok: true, id, url, creado: !hay, movido: !!(hay && hay.url !== url), sobran };
}

// Los webhooks que parecen nuestros, para mostrarlos en Super Admin.
async function webhooksNuestros() {
  const { webhooks = [] } = await llamar('GET', '/webhooks/settings');
  const guardado = await webhookGuardado();
  return webhooks.filter(pareceNuestro).map((w) => ({
    id: w._id, nombre: w.name, url: w.url, activo: w.isActive !== false,
    eventos: (w.events || []).length, ultimo: w.lastFiredAt || null, fallos: w.failureCount || 0,
    enUso: w._id === guardado, borrable: seguroBorrar(w) && w._id !== guardado,
  }));
}

/**
 * Borra los webhooks nuestros que sobran (los que quedaron de una URL vieja).
 * Solo toca los que llevan nuestro nombre Y nuestra ruta, y nunca el que esta
 * en uso: en esta cuenta de Zernio viven tambien los webhooks de otros proyectos.
 */
async function limpiarWebhooks() {
  const { webhooks = [] } = await llamar('GET', '/webhooks/settings');
  const guardado = await webhookGuardado();
  const sobran = webhooks.filter((w) => seguroBorrar(w) && w._id !== guardado);
  const borrados = [];
  for (const w of sobran) {
    await llamar('DELETE', '/webhooks/settings', { query: { webhookId: w._id } });
    console.log(`[zernio] webhook de más borrado: ${w.url} (${w._id})`);
    borrados.push({ id: w._id, url: w.url });
  }
  return { borrados, enUso: guardado, revisar: webhooks.filter((w) => pareceNuestro(w) && !seguroBorrar(w) && w._id !== guardado).map((w) => ({ id: w._id, nombre: w.name, url: w.url })) };
}

async function probarWebhook() {
  const { rows } = await pool.query(`SELECT valor FROM config WHERE clave = 'zernio_webhook_id'`);
  if (!rows[0]?.valor) throw new ZernioError('El webhook no está registrado', { codigo: 'sin_webhook' });
  return llamar('POST', '/webhooks/test', { body: { webhookId: rows[0].valor } });
}

// Firma: HMAC-SHA256 en hex del cuerpo crudo con el secreto.
function firmaValida(cuerpoCrudo, firma) {
  if (!SECRETO_WEBHOOK || !firma || !Buffer.isBuffer(cuerpoCrudo)) return false;
  const esperada = require('crypto').createHmac('sha256', SECRETO_WEBHOOK).update(cuerpoCrudo).digest('hex');
  const a = Buffer.from(String(firma).toLowerCase()); const b = Buffer.from(esperada);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

// Plataformas del post (webhook o GET /v1/posts/:id) -> la forma que guardamos.
// Una sola forma: el calendario cuenta con platformPostUrl para abrir la publicacion.
const plataformasDe = (post) => (post?.platforms || []).map((x) => ({
  platform: x.platform, status: x.status, accountId: x.accountId || null,
  platformPostUrl: x.publishedUrl || x.platformPostUrl || null,
  errorMessage: x.error || x.errorMessage || x.errorCategory || null,
}));

module.exports = {
  plataformasDe, configurado, llamar, perfilId, perfiles, elegirPerfil, perfilElegido, cuentas, urlConexion, desconectar, infoTiktok, crearPost, leerPost, borrarPost, reprogramarPost, ZernioError,
  webhookListo, asegurarWebhook, webhooksNuestros, limpiarWebhooks, probarWebhook, firmaValida, EVENTOS, NOMBRE_WEBHOOK,
};
