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
const { filtrosGeneraciones } = require('./lib/filtros-gen');
const conciliacion = require('./lib/conciliacion');
const catalogo = require('./lib/catalogo');
const billetera = require('./lib/billetera');
const modelos = require('./lib/modelos');
const promptAuto = require('./lib/prompt-auto');
const hfOauth = require('./lib/hf-oauth');
const hfCli = require('./lib/hf-cli');
const pagos = require('./lib/pagos');
const saldoExterno = require('./lib/saldo-externo');
const encolarLib = require('./lib/encolar');
const zernio = require('./lib/zernio');
const { conEspanol } = require('./lib/idioma');
const saldoMarketing = require('./lib/saldo-marketing');

const reglasP = import('../shared/reglas.mjs');
const personalizarP = import('../shared/personalizar.mjs');
const PORT = process.env.PORT || 3002;

const app = express();
app.set('trust proxy', 1);
// Webhook de Zernio: necesita el cuerpo crudo para verificar la firma, va antes del parser JSON.
app.use('/api', require('./zernio-webhook').router);
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
    if (e instanceof hf.HiggsfieldError || e instanceof hfCli.CliError) {
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

// Vuelta del OAuth del generador (la inicia un super_admin desde Super Admin). Sin sesion
// del panel: la protege el state de un solo uso guardado al iniciar.
app.get('/api/hf/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/?generador=error&motivo=' + encodeURIComponent(String(req.query.error).slice(0, 80)));
  try {
    const r = await hfOauth.completar({ code: req.query.code, state: req.query.state });
    res.redirect('/?generador=conectado&cuenta=' + encodeURIComponent(r.cuenta || ''));
  } catch (e) {
    console.error('[generador callback]', e.message);
    res.redirect('/?generador=error&motivo=' + encodeURIComponent(e.message.slice(0, 120)));
  }
});

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

// Costo real de cada busqueda con Camila: lo informa el flujo "Camila Paralela - Costos" de n8n
// (misma clave que el panel usa para hablarle a Camila). Se descuenta del saldo de Marketing.
app.post('/api/n8n/costo-camila', ruta(async (req, res) => {
  const clave = process.env.CAMILA_N8N_TOKEN || '';
  if (!clave || req.headers['x-panel-token'] !== clave) return res.status(401).json({ error: 'no autorizado' });
  const b = req.body || {};
  const conv = /^mkt-(\d+)-/.exec(String(b.contact_id || ''))?.[1];
  const costo = Number(b.costo_usd);
  if (!conv || !b.execution_id || !(costo >= 0)) return res.status(400).json({ error: 'faltan datos' });
  const { rows: [c] } = await pool.query('SELECT email FROM camila_conversaciones WHERE id = $1', [Number(conv)]);
  if (!c) return res.json({ ok: true, cobrado: 0, motivo: 'conversacion desconocida' });
  // Super admin: se registra igual y va al saldo general de JH.
  const perfil = (await auth.perfiles().catch(() => [])).find((p) => (p.email || '').toLowerCase() === c.email);
  const cobrado = await saldoMarketing.cobrarIa({ por: c.email, clase: 'camila', costoUsd: costo, ref: `camila:${b.execution_id}`, aJh: perfil?.role === 'super_admin' });
  console.log(`[camila] costo de la ejecucion ${b.execution_id} (${c.email}): ${costo} USD -> cobrado ${cobrado}`);
  res.json({ ok: true, cobrado });
}));

// ── Con sesion y acceso a este panel ──
app.use('/api', auth.requireAcceso);

app.get('/api/me', ruta(async (req, res) => {
  const a = await ajustes.leer();
  res.json({
    email: req.user.email, nombre: req.user.nombre, rol: req.user.rol,
    rolReal: req.user.rolReal, verComo: req.user.rol !== req.user.rolReal ? req.user.rol : null, puedePublicar: !!req.user.puedePublicar,
    puedeAprobar: !!req.user.puedeAprobar,
    // Precio de 1 credito para JH (costo + ganancia); el costo solo lo ve el super_admin.
    precios: ajustes.precioCredito(a) != null
      ? { precioCredito: ajustes.precioCredito(a), ...(req.user.rol === 'super_admin' ? { usdPorCredito: a.usd_por_credito, margenPct: a.margen_pct } : {}) }
      : null,
    ...(await saldoDe({ user: req.user })),
  });
}));

// Saldo para el panel: el de la plataforma de pagos (USD) si esta configurada; si no, la billetera local (creditos).
async function saldoDe({ fresco = false, user = null } = {}) {
  // Saldo de Marketing: el equipo solo ve este; el general no sale de aca.
  if (saldoMarketing.activo()) {
    const a = await ajustes.leer();
    return {
      saldoFuente: 'marketing', saldoUsd: await saldoMarketing.saldo(), saldoNegativoPermitidoUsd: Number(a.saldo_negativo_permitido || 0),
      ...(user?.puedeAprobar ? { solicitudesPendientes: await saldoMarketing.pendientes() } : {}),
    };
  }
  if (!saldoExterno.configurado()) return { saldoFuente: 'local', saldo: await billetera.saldo() };
  if (fresco) saldoExterno.olvidar();
  try {
    const r = await saldoExterno.resumen();
    const a = await ajustes.leer();
    return { saldoFuente: 'externo', saldoUsd: r.saldoUsd, saldoPendienteUsd: r.pendienteUsd, saldoDisponibleUsd: r.disponibleUsd, saldoNegativoPermitidoUsd: Number(a.saldo_negativo_permitido || 0) };
  } catch (e) {
    console.error('[saldo]', e.message);
    return { saldoFuente: 'externo', saldoUsd: null, saldoDisponibleUsd: null, errorSaldo: 'No se pudo leer el saldo. Intenta de nuevo en un momento.' };
  }
}

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
  precio_usd, resultados, error, creado, enviado, terminado,
  (SELECT COALESCE(-SUM(s.usd), 0) FROM saldo_marketing s WHERE s.generacion_id = generaciones.id AND s.tipo = 'ia') AS ia_usd`;

// Encolar (tope diario, precio, cobro local o en la plataforma central): lib/encolar.js
const encolar = (req, datos) => encolarLib.encolar(req.user, datos);

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
  const { validar: validarPers, textoDe: textoPers } = await personalizarP;
  const personalizacion = validarPers(b.personalizacion, preset.type);
  const extra_ = textoPers(personalizacion, preset.type);
  const textoUsuario = String(b.prompt || '').trim().slice(0, 5000);
  // Lo que escribio el usuario + la personalizacion (colores, luz, fondo, estilo, textos), sin pasar de 5000.
  const prompt = (extra_ ? `${textoUsuario.slice(0, 4990 - extra_.length)}\n\n${extra_}` : textoUsuario).trim();
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
    prompt: conEspanol(prompt), // todo en español (lib/idioma.js)
    ...(url ? { brand_url: url } : {}),
  };
  const extra = {
    // Para 'Usar de nuevo': el texto propio y la personalizacion por separado (no el prompt ya armado).
    texto_usuario: textoUsuario || null,
    ...(Object.keys(personalizacion).length ? { personalizacion } : {}),
    categoria,
    preset: {
      id: preset.id, type: preset.type, name: preset.name || null, cover_image: preset.cover_image || null,
      format_slugs: preset.format_slugs || [],
      ...(preset.group_name ? { group_name: preset.group_name } : {}),
      ...(preset.required_inputs !== undefined ? { required_inputs: preset.required_inputs } : {}),
    },
    producto: producto ? { url: producto.url || null, nombre: producto.nombre || null } : null,
    // Para el detalle del cobro: la duracion viene de la portada de la plantilla; UGC se genera a 720p.
    detalle: { duracion_s: Number(b.duracion) || null, resolucion: preset.type === 'ugc' ? '720p' : null },
    avatar: avatar ? { id: avatar.id, type: avatar.type, name: avatar.name || null, preview_url: avatar.preview_url || null } : null,
  };
  let creditos = null;
  try { creditos = creditosDe(preset.type, await costos(), Number(b.duracion)); } catch { /* estimado opcional */ }

  const r = await encolar(req, {
    presetId: preset.id, presetNombre: preset.name || null, presetTipo: preset.type, portada: preset.cover_image || null,
    entrada: { args: entrada, ...extra }, creditos,
  });
  if (r.error) return res.status(r.status).json(r.error);
  const g = r.g;
  res.status(201).json(g);
}));

// Mis creaciones, con busqueda y filtros (lib/filtros-gen.js).
// Calendario: creaciones terminadas bien en un rango (por la fecha en que quedaron listas).
app.get('/api/calendario/generaciones', ruta(async (req, res) => {
  const desde = new Date(req.query.desde); const hasta = new Date(req.query.hasta);
  if (Number.isNaN(+desde) || Number.isNaN(+hasta) || hasta <= desde || hasta - desde > 45 * 864e5) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  const { rows } = await pool.query(
    `SELECT ${COLS}, COALESCE(terminado, creado) AS fecha FROM generaciones
     WHERE estado = 'completado' AND COALESCE(terminado, creado) >= $1 AND COALESCE(terminado, creado) < $2
     ORDER BY fecha LIMIT 500`, [desde, hasta]
  );
  res.json({ items: rows });
}));

app.get('/api/generaciones', ruta(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 30, 100);
  const { where, vals } = filtrosGeneraciones(req.query, { email: req.user.email, vals: [limite] });
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM generaciones ${where} ORDER BY id DESC LIMIT $1`, vals
  );
  res.json({ items: rows, siguiente: rows.length === limite ? rows.at(-1).id : null });
}));

// Quienes han creado (para el filtro "Quién").
app.get('/api/generaciones-autores', ruta(async (req, res) => {
  const { rows } = await pool.query(`SELECT creado_por, COUNT(*)::int AS n FROM generaciones GROUP BY creado_por ORDER BY n DESC LIMIT 50`);
  res.json({ autores: rows.map((r) => ({ email: r.creado_por, n: r.n })) });
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

// ── Generacion libre (cualquier modelo de video o imagen) ──
app.get('/api/modelos', ruta(async (req, res) => res.json({ modelos: await modelos.lista() })));

// Lee y valida lo que manda el formulario; devuelve { modelo, armado } o { error }.
async function leerLibre(b, { conPrompt = true } = {}) {
  const modelo = await modelos.obtener(String(b.modelo || ''));
  if (!modelo) return { error: 'Elige un modelo.' };
  const prompt = String(b.prompt || '').trim().slice(0, 5000);
  if (conPrompt && !prompt) return { error: 'Escribe qué quieres generar.' };
  const mediaId = b.imagen?.media_id ? String(b.imagen.media_id) : null;
  if (mediaId && !modelo.aceptaImagen) return { error: `${modelo.nombre} no acepta imagen de referencia.` };
  if (!mediaId && modelo.pideImagen) return { error: `${modelo.nombre} necesita una imagen.` };
  return { modelo, armado: modelos.armar(modelo, { prompt: conEspanol(prompt || 'preview'), aspecto: b.aspecto, duracion: b.duracion, opciones: b.opciones || {}, mediaId }) };
}

// Costo en creditos sin generar nada (y el precio para JH si hay costo configurado).
app.post('/api/libre/costo', ruta(async (req, res) => {
  const l = await leerLibre(req.body || {}, { conPrompt: false });
  if (l.error) return res.status(400).json({ error: l.error });
  const creditos = await modelos.costo(l.armado);
  const pr = ajustes.precioDe(await ajustes.leer(), null, creditos);
  res.json({ creditos, precio: pr.precio });
}));

// Autogenerar el prompt desde la imagen (reglas V2 del menu digital adaptadas a ferreteria: lib/prompt-auto.js).
app.post('/api/libre/autoprompt', ruta(async (req, res) => {
  const b = req.body || {};
  const modelo = await modelos.obtener(String(b.modelo || ''));
  if (!modelo) return res.status(400).json({ error: 'Elige un modelo.' });
  if (!b.imagen?.url) return res.status(400).json({ error: 'Sube una imagen para autogenerar el prompt.' });
  const op = b.opciones || {};
  const conAudio = op.generate_audio === true || op.sound === true || op.sound === 'on';
  if (!(await saldoMarketing.puedeGastarIa(req.user))) return res.status(402).json({ error: 'No hay saldo de Marketing para usar la IA. Pide una recarga en Créditos.', sinSaldo: true });
  try {
    const r = await promptAuto.generar({
      imagenUrl: b.imagen.url, tipo: modelo.tipo, duracion: b.duracion, conAudio, aspecto: b.aspecto,
      producto: b.producto, instrucciones: b.instrucciones,
    });
    console.log(`[autoprompt] ${req.user.email} ${modelo.id} ${r.modelo} tokens ${r.tokens.entrada}/${r.tokens.salida} avisos ${r.avisos.length}`);
    // Costo de la IA al saldo de Marketing (se suma al total de la creacion que se haga con esta descripcion).
    // Super admin: se registra igual y va al saldo general de JH.
    const costoIa = await saldoMarketing.cobrarIa({ por: req.user.email, clase: 'descripcion', modelo: r.modelo, entrada: r.tokens.entrada, salida: r.tokens.salida, aJh: saldoMarketing.exento(req.user) })
      .catch((e) => { console.error('[autoprompt] cobro IA', e.message); return 0; });
    res.json({ prompt: r.prompt, avisos: r.avisos, costoIa });
  } catch (e) {
    if (e.uso) { // la IA respondio pero no sirvio: los tokens se gastaron igual
      await saldoMarketing.cobrarIa({ por: req.user.email, clase: 'descripcion', detalle: 'no salió', modelo: e.uso.modelo, entrada: e.uso.entrada, salida: e.uso.salida, aJh: saldoMarketing.exento(req.user) })
        .catch((x) => console.error('[autoprompt] cobro IA', x.message));
    }
    if (e instanceof promptAuto.ErrorDePrompt) {
      console.error('[autoprompt]', e.message, e.detalle || '');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }
}));

app.post('/api/libre', ruta(async (req, res) => {
  const b = req.body || {};
  const l = await leerLibre(b);
  if (l.error) return res.status(400).json({ error: l.error });
  const creditos = await modelos.costo(l.armado); // el costo lo decide el servidor, no el navegador
  const r = await encolar(req, {
    presetId: l.modelo.id, presetNombre: l.modelo.nombre, presetTipo: l.modelo.tipo === 'video' ? 'libre_video' : 'libre_imagen',
    portada: b.imagen?.url ? { url: b.imagen.url } : null,
    entrada: {
      tool: l.armado.tool, params: l.armado.params,
      libre: { modelo: l.modelo.id, aspecto: b.aspecto || null, duracion: b.duracion || null, opciones: b.opciones || {}, promptAuto: !!b.promptAuto },
      producto: b.imagen?.media_id ? { media_id: b.imagen.media_id, url: b.imagen.url || null, nombre: b.imagen.nombre || null } : null,
    },
    creditos,
  });
  if (r.error) return res.status(r.status).json(r.error);
  res.status(201).json(r.g);
}));

// Saldo de Marketing (solicitudes de recarga); si no esta activo, sigue a la ruta de abajo.
app.use('/api', require('./creditos-marketing').router);

// Billetera de JH: saldo, precio por credito, paquetes con ganancia y movimientos.
app.get('/api/creditos', ruta(async (req, res) => {
  const a = await ajustes.leer();
  const pc = ajustes.precioCredito(a);
  if (saldoExterno.configurado()) {
    if (req.query.fresco) saldoExterno.olvidar();
    let r = null; let error = null;
    try { r = await saldoExterno.resumen(); } catch (e) { console.error('[saldo]', e.message); error = 'No se pudo leer el saldo. Intenta de nuevo en un momento.'; }
    const { rows } = await pool.query(
      `SELECT id, preset_nombre, preset_tipo, precio_usd, creditos_estimados, estado, creado, creado_por, gasto_informado
       FROM generaciones WHERE cobro_externo ORDER BY id DESC LIMIT 40`
    );
    return res.json({
      fuente: 'externo', error, precioCredito: pc, pagoUrl: saldoExterno.URL_PAGO(),
      cuenta: r && { nombre: r.nombre, email: r.email }, saldoUsd: r?.saldoUsd ?? null, pendienteUsd: r?.pendienteUsd ?? null,
      disponibleUsd: r?.disponibleUsd ?? null, autoRecarga: r?.autoRecarga || null, leido: r?.leido || null,
      negativoPermitidoUsd: Number(a.saldo_negativo_permitido || 0),
      consumos: rows.map((x) => ({ ...x, precio_usd: x.precio_usd != null ? Number(x.precio_usd) : null, creditos_estimados: x.creditos_estimados != null ? Number(x.creditos_estimados) : null })),
    });
  }
  const paquetes = (a.costo_info?.paquetes || []).map((p) => p.creditos).sort((x, y) => x - y);
  res.json({
    saldo: await billetera.saldo(),
    precioCredito: pc,
    fuente: 'local',
    paquetes: (paquetes.length ? paquetes : [500, 1000, 2000, 4000]).map((cr) => ({ creditos: cr, usd: pc != null ? Math.round(cr * pc * 100) / 100 : null })),
    pagoEnLinea: false, // en standby: por ahora las recargas las carga un super admin
    movimientos: (await billetera.movimientos(40)).map((m) => ({ ...m, creditos: Number(m.creditos), usd: m.usd != null ? Number(m.usd) : null })),
  });
}));

// Camila: busca productos de JH y deja la foto lista para crear (server/camila.js).
app.use('/api', require('./camila').router);

// Redes sociales: ver cuentas y publicaciones = admin o quien tiene permiso de publicar;
// publicar/programar exige el permiso (server/redes.js); conectar cuentas, admin.
app.use(['/api/redes', '/api/publicaciones'], (req, res, next) => (auth.NIVEL[req.user.rol] >= auth.NIVEL.admin || req.user.puedePublicar ? next()
  : res.status(403).json({ error: 'No tienes permiso para esto.' })));
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
  await require('./lib/camila').migrar();
  await require('./lib/permisos').migrar();
  await require('./lib/saldo-marketing').migrar();
  await conciliacion.migrar();
  require('./lib/jh-catalogo').calentar();
  if (await hf.sembrarToken()) console.log('Token de Higgsfield sembrado desde HF_REFRESH_TOKEN.');
  // Webhook de Zernio: se registra solo en cuanto hay clave y secreto.
  if (zernio.webhookListo() && process.env.PANEL_URL) {
    zernio.asegurarWebhook(process.env.PANEL_URL)
      .then((r) => console.log(`[zernio] webhook ${r.creado ? 'registrado' : 'actualizado'}: ${r.url}`))
      .catch((e) => console.error('[zernio] no se pudo registrar el webhook:', e.message));
  }
  if (!auth.configurado()) console.warn('AVISO: faltan SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY; nadie podrá entrar.');
  app.listen(PORT, () => console.log(`Panel Marketing Studio en :${PORT}`));
  // Conciliacion (lib/conciliacion.js): Camila cada 30 min, Higgsfield cada 6 h (arranca a los 5 min).
  const esSuperAdmin = async (email) => (await auth.perfiles().catch(() => [])).some((p) => p.role === 'super_admin' && (p.email || '').toLowerCase() === email);
  const camilaCada = () => conciliacion.conciliarCamila({ esSuperAdmin })
    .then((r) => r.faltantes && console.log(`[conciliacion] Camila: ${r.faltantes} sin costo de n8n, ${r.cobrados} cobradas estimadas ($${r.usd})`))
    .catch((e) => console.error('[conciliacion] Camila', e.message));
  const hfCada = () => conciliacion.conciliarHiggsfield({ llamar: hf.llamar })
    .then((r) => console.log(`[conciliacion] Higgsfield 24 h: ${r.panel.creaciones} creaciones, ${r.emparejadas} emparejadas, ${r.diferencias.length} con otro costo, ${r.sinGasto.length} sin gasto, ${r.fueraDelPanel.n} gastos fuera del panel (${r.fueraDelPanel.creditos} cr)`))
    .catch((e) => console.error('[conciliacion] Higgsfield', e.message));
  setTimeout(() => { camilaCada(); hfCada(); }, 5 * 60e3);
  setInterval(camilaCada, 30 * 60e3);
  setInterval(hfCada, 6 * 60 * 60e3);
}

if (require.main === module) arrancar().catch((e) => { console.error(e); process.exit(1); });

module.exports = { app, arrancar };
