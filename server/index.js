/**
 * Panel web de Marketing Studio: login con el Supabase de los paneles, catalogo
 * (proxy cacheado del MCP de Higgsfield), subida de imagenes, alta de
 * generaciones, redes sociales y pestaña Super Admin. Las generaciones las
 * manda y sigue el worker (server/worker.js); aqui solo se encolan.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { pool, migrar } = require('./lib/db');
const hf = require('./lib/higgsfield');
const auth = require('./lib/auth');
const ajustes = require('./lib/config');
const catalogo = require('./lib/catalogo');
const billetera = require('./lib/billetera');

const reglasP = import('../shared/reglas.mjs');
const PORT = process.env.PORT || 3002;

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

// Envuelve rutas async. Al navegador no le llega el detalle tecnico (ni el
// nombre del proveedor): solo un mensaje generico; el detalle queda en el log.
const ruta = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`[${req.method} ${req.path}]`, e.message);
    if (e instanceof hf.HiggsfieldError) {
      return res.status(e.desconectado ? 503 : 502).json({
        error: e.desconectado
          ? 'El generador de contenido está desconectado. Avísale al administrador.'
          : 'El generador de contenido no respondió bien. Intenta de nuevo en un momento.',
        desconectado: !!e.desconectado,
      });
    }
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
};

// ── Publico ──
app.get('/api/health', (req, res) => res.json({ ok: true, auth: auth.configurado() }));
app.get('/api/config', (req, res) => res.json(auth.configPublica()));

// Lo consultan los otros paneles (Conversaciones, Cotizaciones, Cobranzas) con su
// propio token de Supabase para decidir si muestran la pestaña Marketing.
const ORIGEN_PANELES = /^https:\/\/([a-z0-9-]+\.)*neboaiconsulting\.com$/;
function corsPaneles(req, res, next) {
  const o = req.headers.origin;
  if (o && ORIGEN_PANELES.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
app.options('/api/acceso', corsPaneles);
app.get('/api/acceso', corsPaneles, auth.sesion, ruta(async (req, res) => {
  const { rol } = await auth.rolMarketing(req.user.id);
  res.json({ acceso: !!rol, rol });
}));

// ── Con sesion y acceso a este panel ──
app.use('/api', auth.requireAcceso);

app.get('/api/me', ruta(async (req, res) => {
  const a = await ajustes.leer();
  res.json({
    email: req.user.email, nombre: req.user.nombre, rol: req.user.rol,
    // Precio de 1 credito para JH (costo + ganancia); el costo solo lo ve el super_admin.
    precios: ajustes.precioCredito(a) != null
      ? { precioCredito: ajustes.precioCredito(a), ...(req.user.rol === 'super_admin' ? { usdPorCredito: a.usd_por_credito, margenPct: a.margen_pct } : {}) }
      : null,
    saldo: await billetera.saldo(),
  });
}));

app.get('/api/estado', ruta(async (req, res) => res.json({ conectado: (await hf.estadoConexion()).conectado })));

app.get('/api/saldo', auth.requireRol('super_admin'), ruta(async (req, res) => {
  res.json(await cacheado('saldo', 60e3, () => hf.llamar('balance', {})));
}));

app.get('/api/catalogo/categorias', ruta(async (req, res) => res.json({ categorias: await categorias() })));

app.get('/api/catalogo/costos', ruta(async (req, res) => res.json(await costos())));

// Catalogo completo, filtrado y ordenado para JH (ver server/lib/catalogo.js).
app.get('/api/catalogo/plantillas', ruta(async (req, res) => {
  const q = req.query;
  const f = {
    categoria: String(q.categoria || 'all'), formato: q.formato || '', sirve: q.sirve || '', producto: q.producto || '', estilo: q.estilo || '',
    persona: ['si', 'no'].includes(q.persona) ? q.persona : '', medio: ['foto', 'video'].includes(q.medio) ? q.medio : '',
    orientacion: ['vertical', 'horizontal', 'cuadrada'].includes(q.orientacion) ? q.orientacion : '',
    q: String(q.q || '').slice(0, 80), orden: q.orden === 'original' ? 'original' : 'jh',
  };
  res.json(await catalogo.pagina(f, { desde: Math.max(0, Number(q.cursor) || 0), tam: 30 }));
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
  if (!put.ok) throw new hf.HiggsfieldError(`PUT de la subida fallo (HTTP ${put.status})`);
  const conf = await hf.llamar('media_confirm', { type: 'image', media_id: slot.media_id });
  const r = conf.results?.[0];
  if (!r?.media_id) throw new hf.HiggsfieldError('media_confirm no devolvió media_id');
  res.json({ media_id: r.media_id, url: r.url || slot.url || null, nombre: String(req.headers['x-nombre'] || nombre).slice(0, 120) });
}));

// ── Generaciones ──
const COLS = `id, creado_por, estado, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados,
  precio_usd, resultados, error, creado, enviado, terminado`;

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

  // Tope diario de creditos por usuario (lo fija el super_admin; a el no le aplica).
  const a = await ajustes.leer();
  if (a.limite_diario_creditos > 0 && req.user.rol !== 'super_admin') {
    const { rows: [u] } = await pool.query(
      `SELECT COALESCE(SUM(creditos_estimados), 0) AS usados FROM generaciones
       WHERE user_id = $1 AND estado <> 'fallido'
         AND (creado AT TIME ZONE 'America/Santo_Domingo')::date = (now() AT TIME ZONE 'America/Santo_Domingo')::date`,
      [req.user.id]
    );
    if (Number(u.usados) + (Number(creditos) || 0) > a.limite_diario_creditos) {
      return res.status(429).json({ error: 'Llegaste al límite de uso de hoy. Pídele a un super admin que lo amplíe.' });
    }
  }
  const pr = ajustes.precioDe(a, preset.type, creditos);
  // Los usuarios pagan con la billetera de JH; el super_admin (Nebo) no la toca.
  const cobra = req.user.rol !== 'super_admin';
  if (cobra && !(Number(creditos) > 0)) {
    return res.status(400).json({ error: 'No se pudo calcular el costo de esta plantilla. Espera a que cargue la vista previa e intenta de nuevo.' });
  }

  const cli = await pool.connect();
  let g;
  try {
    await cli.query('BEGIN');
    ({ rows: [g] } = await cli.query(
      `INSERT INTO generaciones (creado_por, user_id, preset_id, preset_nombre, preset_tipo, portada, entrada, creditos_estimados,
         usd_por_credito, margen_pct, costo_usd, precio_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${COLS}`,
      [req.user.email, req.user.id, preset.id, preset.name || null, preset.type, preset.cover_image || null,
        { args: entrada, ...extra }, creditos, a.usd_por_credito || null, pr.margen, pr.costo, pr.precio]
    ));
    if (cobra) await billetera.cobrar(cli, { generacionId: g.id, creditos: Number(creditos), usd: pr.precio, por: req.user.email });
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    if (e.saldo) return res.status(402).json({ error: e.message + ' Recarga créditos para continuar.', sinSaldo: true });
    throw e;
  } finally {
    cli.release();
  }
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

// Descarga via el panel, con nombre de archivo propio (el original trae el
// prefijo del proveedor). Solo sirve URLs que esten en los resultados de la fila.
app.get('/api/generaciones/:id/descargar', ruta(async (req, res) => {
  const { rows: [g] } = await pool.query('SELECT id, preset_nombre, resultados FROM generaciones WHERE id = $1', [Number(req.params.id) || 0]);
  const ok = (g?.resultados || []).filter((r) => r.url);
  const i = Math.max(0, Math.min(Number(req.query.i) || 0, ok.length - 1));
  if (!ok[i]) return res.status(404).json({ error: 'No hay archivo para descargar.' });
  const r = await fetch(ok[i].url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok || !r.body) return res.status(502).json({ error: 'No se pudo descargar el archivo.' });
  const ext = (new URL(ok[i].url).pathname.match(/\.(png|jpe?g|webp|mp4|mov|webm)$/i) || [, 'bin'])[1].toLowerCase();
  const base = (g.preset_nombre || 'marketing').normalize('NFD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'marketing';
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  if (r.headers.get('content-length')) res.setHeader('Content-Length', r.headers.get('content-length'));
  res.setHeader('Content-Disposition', `attachment; filename="${base}_${g.id}${ok.length > 1 ? `_${i + 1}` : ''}.${ext}"`);
  const { Readable } = require('stream');
  Readable.fromWeb(r.body).pipe(res);
}));

app.get('/api/generaciones/:id', ruta(async (req, res) => {
  const { rows: [g] } = await pool.query(`SELECT ${COLS} FROM generaciones WHERE id = $1`, [Number(req.params.id) || 0]);
  if (!g) return res.status(404).json({ error: 'No existe.' });
  res.json(g);
}));

// Billetera de JH: saldo, precio por credito, paquetes con ganancia y movimientos.
app.get('/api/creditos', ruta(async (req, res) => {
  const a = await ajustes.leer();
  const pc = ajustes.precioCredito(a);
  const paquetes = (a.costo_info?.paquetes || []).map((p) => p.creditos).sort((x, y) => x - y);
  res.json({
    saldo: await billetera.saldo(),
    precioCredito: pc,
    paquetes: (paquetes.length ? paquetes : [500, 1000, 2000, 4000]).map((cr) => ({ creditos: cr, usd: pc != null ? Math.round(cr * pc * 100) / 100 : null })),
    pagoEnLinea: false, // en standby: por ahora las recargas las carga un super admin
    movimientos: (await billetera.movimientos(40)).map((m) => ({ ...m, creditos: Number(m.creditos), usd: m.usd != null ? Number(m.usd) : null })),
  });
}));

// Redes sociales (conectar cuentas y publicar): admin de Marketing en adelante.
app.use(['/api/redes', '/api/publicaciones'], auth.requireRol('admin'));
app.use('/api', require('./redes').router);

// Super Admin (margen, usuarios, consumo).
app.use('/api', require('./superadmin').router);

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// ── Frontend compilado ──
const dist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

async function arrancar() {
  await migrar();
  if (await hf.sembrarToken()) console.log('Token de Higgsfield sembrado desde HF_REFRESH_TOKEN.');
  if (!auth.configurado()) console.warn('AVISO: faltan SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY; nadie podrá entrar.');
  app.listen(PORT, () => console.log(`Panel Marketing Studio en :${PORT}`));
}

if (require.main === module) arrancar().catch((e) => { console.error(e); process.exit(1); });

module.exports = { app, arrancar };
