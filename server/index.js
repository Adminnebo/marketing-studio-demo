/**
 * Panel web de Marketing Studio: login propio, catalogo (proxy cacheado del MCP
 * de Higgsfield), subida de imagenes y alta de generaciones. Las generaciones
 * las manda y sigue el worker (server/worker.js); aqui solo se encolan.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { pool, migrar } = require('./lib/db');
const hf = require('./lib/higgsfield');
const auth = require('./lib/auth');

const reglasP = import('../shared/reglas.mjs');
const PORT = process.env.PORT || 3002;
const CREDITOS_VISIBLES = process.env.CREDITOS_VISIBLES === '1';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ── Cache en memoria para el catalogo (cambia poco y cada llamada va al MCP) ──
const cache = new Map();
async function cacheado(clave, ms, fn) {
  const hit = cache.get(clave);
  if (hit && hit.exp > Date.now()) return hit.valor;
  const valor = await fn();
  cache.set(clave, { valor, exp: Date.now() + ms });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return valor;
}

const categorias = () => cacheado('categorias', 30 * 60e3, async () => {
  const d = await hf.llamar('show_marketing_studio_v2', { category: 'all' });
  return d.categories || [];
});
const costos = () => cacheado('costos', 60 * 60e3, () => hf.llamar('marketing_studio_v2_costs', {}));

// Envuelve rutas async: errores de Higgsfield -> 502 con mensaje claro.
const ruta = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`[${req.method} ${req.path}]`, e.message);
    const status = e instanceof hf.HiggsfieldError ? (e.desconectado ? 503 : 502) : 500;
    res.status(status).json({ error: e.message, desconectado: !!e.desconectado });
  }
};

// ── Publico ──
app.get('/api/health', (req, res) => res.json({ ok: true, auth: auth.configurado() }));
app.post('/api/login', auth.login);

// ── Con sesion ──
app.use('/api', auth.requireAuth);

app.get('/api/me', (req, res) => res.json({ email: req.user.email, creditosVisibles: CREDITOS_VISIBLES }));

app.get('/api/estado', ruta(async (req, res) => res.json(await hf.estadoConexion())));

app.get('/api/saldo', ruta(async (req, res) => {
  if (!CREDITOS_VISIBLES) return res.status(404).json({ error: 'oculto' });
  res.json(await cacheado('saldo', 60e3, () => hf.llamar('balance', {})));
}));

app.get('/api/catalogo/categorias', ruta(async (req, res) => res.json({ categorias: await categorias() })));

app.get('/api/catalogo/costos', ruta(async (req, res) => res.json(await costos())));

app.get('/api/catalogo/plantillas', ruta(async (req, res) => {
  const categoria = String(req.query.categoria || 'all');
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;
  const args = { category: categoria, size: 30, ...(cursor ? { cursor } : {}) };
  const d = await cacheado(`plantillas:${categoria}:${cursor || 0}`, 10 * 60e3,
    () => hf.llamar('marketing_studio_v2_presets', args));
  const p = d.presets || { total: 0, cursor: null, items: [] };
  res.json({ total: p.total, cursor: p.cursor ?? null, items: p.items || [] });
}));

app.get('/api/catalogo/avatares', ruta(async (req, res) => {
  const args = { size: 50 };
  if (req.query.preset_cursor) args.preset_cursor = Number(req.query.preset_cursor);
  if (req.query.user_cursor) args.user_cursor = Number(req.query.user_cursor);
  const d = await cacheado('avatares:' + JSON.stringify(args), 10 * 60e3,
    () => hf.llamar('marketing_studio_v2_avatars', args));
  res.json({ items: d.items || [], preset_cursor: d.preset_cursor ?? null, user_cursor: d.user_cursor ?? null, has_more: !!d.has_more });
}));

// Subida de la imagen del producto: el navegador manda los bytes aqui y el
// servidor los pasa a Higgsfield (URL prefirmada + confirmacion), como el widget.
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
app.post('/api/medios', express.raw({ type: Object.keys(EXT), limit: '20mb' }), ruta(async (req, res) => {
  const tipo = (req.headers['content-type'] || '').split(';')[0];
  if (!EXT[tipo] || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Sube una imagen PNG, JPG o WEBP (máx. 20 MB).' });
  }
  const base = String(req.headers['x-nombre'] || 'producto').replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 60) || 'producto';
  const nombre = `${base}.${EXT[tipo]}`;
  const slot = (await hf.llamar('media_upload', { method: 'upload_url', filename: nombre, content_type: tipo })).uploads?.[0];
  if (!slot?.upload_url || !slot.media_id) throw new hf.HiggsfieldError('media_upload no devolvió dónde subir');
  const put = await fetch(slot.upload_url, {
    method: 'PUT', headers: { 'content-type': slot.content_type || tipo }, body: req.body,
    signal: AbortSignal.timeout(120000),
  });
  if (!put.ok) throw new hf.HiggsfieldError(`Falló la subida a Higgsfield (HTTP ${put.status})`);
  const conf = await hf.llamar('media_confirm', { type: 'image', media_id: slot.media_id });
  const r = conf.results?.[0];
  if (!r?.media_id) throw new hf.HiggsfieldError('media_confirm no devolvió media_id');
  res.json({ media_id: r.media_id, url: r.url || slot.url || null, nombre: String(req.headers['x-nombre'] || nombre).slice(0, 120) });
}));

// ── Generaciones ──
const COLS = `id, creado_por, estado, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados,
  resultados, error, creado, enviado, terminado`;

app.post('/api/generaciones', ruta(async (req, res) => {
  const { entradasDe, faltantes, formatoDe, creditosDe } = await reglasP;
  const b = req.body || {};
  const preset = b.preset || {};
  if (!preset.id || !preset.type) return res.status(400).json({ error: 'Falta la plantilla.' });
  const categoria = String(b.categoria || 'all');
  const cats = await categorias();
  const { formatSlug, formato } = formatoDe({ ...preset, format_slugs: preset.format_slugs || [] }, cats, categoria);
  const e = entradasDe(preset, { formatSlug, formato });
  const producto = e.producto && b.producto?.media_id ? b.producto : null;
  const avatar = e.avatar && b.avatar?.id ? b.avatar : null;
  const prompt = String(b.prompt || '').trim().slice(0, 5000);
  const url = e.aceptaUrl ? String(b.url || '').trim().slice(0, 4096) : '';
  const errores = faltantes(e, { producto, avatar, prompt, url });
  if (errores.length) return res.status(400).json({ error: errores.join(' ') });
  if (avatar && preset.type === 'product_shots_people' && !avatar.preview_url) {
    return res.status(400).json({ error: 'Ese avatar no tiene imagen para usar.' });
  }

  // Argumentos exactos de marketing_studio_v2_create (igual que el widget). El
  // avatar de product_shots_people se importa como imagen en el worker.
  const entrada = {
    preset_id: preset.id, preset_type: preset.type, preset_name: preset.name, category_slug: categoria,
    ...(formatSlug ? { format_slug: formatSlug } : {}),
    ...(formato?.name ? { format_name: formato.name } : {}),
    ...(preset.group_name ? { group_name: preset.group_name } : {}),
    ...(preset.required_inputs !== undefined ? { required_inputs: preset.required_inputs } : {}),
    ...(producto ? { product_media_id: producto.media_id } : {}),
    ...(avatar && preset.type === 'ugc' ? { avatar: { id: avatar.id, type: avatar.type } } : {}),
    ...(prompt ? { prompt } : {}),
    ...(url ? { brand_url: url } : {}),
  };
  const extra = {
    categoria,
    preset: {
      id: preset.id, type: preset.type, name: preset.name || null, cover_image: preset.cover_image || null,
      format_slugs: preset.format_slugs || [],
      ...(preset.group_name ? { group_name: preset.group_name } : {}),
      ...(preset.required_inputs !== undefined ? { required_inputs: preset.required_inputs } : {}),
    },
    producto: producto ? { url: producto.url || null, nombre: producto.nombre || null } : null,
    avatar: avatar ? { id: avatar.id, type: avatar.type, name: avatar.name || null, preview_url: avatar.preview_url || null } : null,
  };
  let creditos = null;
  try { creditos = creditosDe(preset.type, await costos(), Number(b.duracion)); } catch { /* estimado opcional */ }

  const { rows: [g] } = await pool.query(
    `INSERT INTO generaciones (creado_por, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
    [req.user.email, preset.id, preset.name || null, preset.type, preset.cover_image || null,
      { args: entrada, ...extra }, creditos]
  );
  res.status(201).json(g);
}));

app.get('/api/generaciones', ruta(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 30, 100);
  const antes = Number(req.query.antes) || null;
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM generaciones ${antes ? 'WHERE id < $2' : ''} ORDER BY id DESC LIMIT $1`,
    antes ? [limite, antes] : [limite]
  );
  res.json({ items: rows, siguiente: rows.length === limite ? rows.at(-1).id : null });
}));

app.get('/api/generaciones/:id', ruta(async (req, res) => {
  const { rows: [g] } = await pool.query(`SELECT ${COLS} FROM generaciones WHERE id = $1`, [Number(req.params.id) || 0]);
  if (!g) return res.status(404).json({ error: 'No existe.' });
  res.json(g);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// ── Frontend compilado ──
const dist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

async function arrancar() {
  await migrar();
  if (await hf.sembrarToken()) console.log('Token de Higgsfield sembrado desde HF_REFRESH_TOKEN.');
  if (!auth.configurado()) console.warn('AVISO: falta SESSION_SECRET o PANEL_USUARIOS; nadie podrá entrar.');
  app.listen(PORT, () => console.log(`Panel Marketing Studio en :${PORT}`));
}

if (require.main === module) arrancar().catch((e) => { console.error(e); process.exit(1); });

module.exports = { app, arrancar };
