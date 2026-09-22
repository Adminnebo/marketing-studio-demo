/**
 * Rutas de redes sociales (via Zernio): conectar/desconectar cuentas y
 * publicar/programar un resultado del panel. El seguimiento del estado de cada
 * publicacion lo hace el worker.
 */
const express = require('express');
const { pool } = require('./lib/db');
const zernio = require('./lib/zernio');
const auth = require('./lib/auth');
const { requirePublicar } = require('./lib/permisos');
const captions = require('./lib/captions');
const saldoMarketing = require('./lib/saldo-marketing');
const soloAdmin = auth.requireRol('admin');

const redesP = import('../shared/redes.mjs');
const router = express.Router();

// Al navegador solo le llega un mensaje claro; el detalle va al log.
const ruta = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`[${req.method} ${req.originalUrl}]`, e.message);
    if (e instanceof zernio.ZernioError) {
      if (e.codigo === 'sin_api_key') return res.status(503).json({ error: 'La conexión con redes todavía no está configurada.', sinConfigurar: true });
      if (e.codigo === 'sin_perfil') return res.status(503).json({ error: 'Falta elegir el perfil de redes: un super admin lo hace en Super Admin → Redes.', sinConfigurar: true });
      if (e.status === 402) return res.status(402).json({ error: 'Esta red requiere un método de pago en la cuenta de redes.' });
      if (e.status === 401 || e.status === 403) return res.status(503).json({ error: 'La conexión con redes no está autorizada. Avísale al administrador.' });
      if (e.status === 429) return res.status(429).json({ error: 'Demasiadas solicitudes a las redes. Espera un momento.' });
      if (e.status === 409) return res.status(409).json({ error: 'Ese mismo contenido ya se publicó o está programado en esa cuenta (últimas 24 h).' });
      return res.status(502).json({ error: 'La conexión con redes no respondió bien. Intenta de nuevo.' });
    }
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
};

const COLS = `id, generacion_id, indice, creado_por, texto, medio, cuentas, opciones, programada_para, zona, estado,
  plataformas, error, creado, actualizado`;

router.get('/redes/estado', (req, res) => res.json({ configurado: zernio.configurado() }));

// Solo las redes en las que el panel sabe publicar (el perfil puede tener otras, p. ej. WhatsApp).
const cuentasPanel = async () => { const { REDES } = await redesP; return (await zernio.cuentas()).filter((c) => REDES[c.plataforma]); };
router.get('/redes/cuentas', ruta(async (req, res) => res.json({ cuentas: await cuentasPanel() })));

// Devuelve la URL de autorizacion de la red; al terminar vuelve al panel.
router.post('/redes/conectar', soloAdmin, ruta(async (req, res) => {
  const { REDES } = await redesP;
  const plataforma = String(req.body?.plataforma || '');
  if (!REDES[plataforma]) return res.status(400).json({ error: 'Red no soportada.' });
  const base = process.env.PANEL_URL || `${req.protocol}://${req.get('host')}`;
  const url = await zernio.urlConexion(plataforma, `${base.replace(/\/+$/, '')}/?redes=1`);
  res.json({ url });
}));

router.delete('/redes/cuentas/:id', soloAdmin, ruta(async (req, res) => {
  const lista = await cuentasPanel();
  if (!lista.some((c) => c.id === req.params.id)) return res.status(404).json({ error: 'Esa cuenta no está conectada a este panel.' });
  await zernio.desconectar(req.params.id);
  console.log(`[redes] ${req.user.email} desconecto la cuenta ${req.params.id}`);
  res.json({ ok: true });
}));

router.get('/redes/cuentas/:id/tiktok', ruta(async (req, res) => {
  const d = await zernio.infoTiktok(req.params.id, req.query.tipo === 'image' ? 'photo' : 'video');
  res.json({
    privacidades: (d.privacyLevels || []).map((p) => ({ valor: p.value, etiqueta: p.label })),
    interacciones: d.postingLimits?.interactionSettings || {},
    puedePublicar: d.creator?.canPostMore !== false,
    maxDuracion: d.postingLimits?.maxVideoDurationSec || null,
  });
}));

// Arma el cuerpo de POST /v1/posts de Zernio.
function cuerpoZernio({ texto, medio, cuentas, opciones, modo, fechaLocal, zona }) {
  const tk = opciones.tiktok || {};
  const yt = opciones.youtube || {};
  const ig = opciones.instagram || {};
  const cuerpo = {
    content: texto,
    mediaItems: [{ url: medio.url, type: medio.tipo }],
    platforms: cuentas.map((c) => {
      const p = { platform: c.plataforma, accountId: c.id };
      if (c.plataforma === 'youtube') p.platformSpecificData = { title: yt.titulo.trim(), visibility: 'public', madeForKids: false };
      if (c.plataforma === 'instagram' && ig.formato === 'story') p.platformSpecificData = { contentType: 'story' };
      return p;
    }),
  };
  if (cuentas.some((c) => c.plataforma === 'tiktok')) {
    cuerpo.tiktokSettings = {
      privacy_level: tk.privacidad,
      allow_comment: !!tk.comentarios,
      ...(medio.tipo === 'video' ? { allow_duet: !!tk.duo, allow_stitch: !!tk.stitch } : {}),
      content_preview_confirmed: true,
      express_consent_given: true,
    };
  }
  if (modo === 'programar') { cuerpo.scheduledFor = fechaLocal; cuerpo.timezone = zona; } else cuerpo.publishNow = true;
  return cuerpo;
}

// Caption y hashtags recomendados con IA para un resultado (antes de publicar).
router.post('/publicaciones/caption', requirePublicar, async (req, res) => {
  const b = req.body || {};
  const { REDES, limiteDe, tipoMedio } = await redesP;
  try {
    const { rows: [g] } = await pool.query('SELECT id, preset_nombre, entrada, portada, resultados FROM generaciones WHERE id = $1', [Number(b.generacion_id) || 0]);
    if (!g) return res.status(404).json({ error: 'Esa creación no existe.' });
    const redes = (Array.isArray(b.redes) ? b.redes : []).filter((r) => REDES[r]);
    const ok = (g.resultados || []).filter((r) => r.url);
    const tipo = tipoMedio(ok[Math.min(Number(b.indice) || 0, ok.length - 1)]?.url);
    // Deja lugar para los hashtags dentro del limite de la red mas corta.
    const limite = redes.length ? Math.min(...redes.map((r) => limiteDe(r, tipo))) : 2200;
    const largo = Math.max(120, Math.min(1200, limite - (limite <= 300 ? 60 : 180)));
    if (!(await saldoMarketing.puedeGastarIa(req.user))) return res.status(402).json({ error: 'No hay saldo de Marketing para usar la IA. Pide una recarga en Créditos.', sinSaldo: true });
    // El caption se suma al total de esa creacion (super admin: al saldo general de JH). Si la IA respondio mal, se cobra igual.
    const cobrar = (uso, detalle = null) => saldoMarketing.cobrarIa({ por: req.user.email, clase: 'caption', detalle, modelo: uso.modelo, entrada: uso.entrada, salida: uso.salida, generacionId: g.id, aJh: saldoMarketing.exento(req.user) })
      .catch((e) => { console.error('[captions] cobro IA', e.message); return 0; });
    let uso; let out;
    try { ({ uso, ...out } = await captions.generar({ generacion: g, indice: Number(b.indice) || 0, redes: redes.map((r) => REDES[r].nombre), tono: b.tono, indicaciones: b.indicaciones, largo })); }
    catch (e) { if (e.uso) await cobrar(e.uso, 'no salió'); throw e; }
    const costoIa = await cobrar(uso);
    res.json({ ...out, costoIa });
  } catch (e) {
    if (e instanceof captions.ErrorDeCaption) { console.error('[captions]', e.message, e.detalle || ''); return res.status(e.status).json({ error: e.message }); }
    console.error('[captions]', e.message);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
});

router.post('/publicaciones', requirePublicar, ruta(async (req, res) => {
  const { validarPublicacion, tipoMedio, DESDE_ZERNIO } = await redesP;
  const b = req.body || {};
  const { rows: [g] } = await pool.query('SELECT id, estado, resultados FROM generaciones WHERE id = $1', [Number(b.generacion_id) || 0]);
  const ok = (g?.resultados || []).filter((r) => r.url);
  if (!g || g.estado !== 'completado' || !ok.length) return res.status(400).json({ error: 'Esa generación no tiene resultado para publicar.' });
  const indice = Math.max(0, Math.min(Number(b.indice) || 0, ok.length - 1));
  const medio = { url: ok[indice].url, tipo: tipoMedio(ok[indice].url) };

  // Las cuentas se validan contra las conectadas de verdad (no se confia en el navegador).
  const conectadas = new Map((await cuentasPanel()).map((c) => [c.id, c]));
  const ids = [...new Set((Array.isArray(b.cuentas) ? b.cuentas : []).map(String))];
  const cuentas = ids.map((id) => conectadas.get(id)).filter(Boolean);
  if (cuentas.length !== ids.length) return res.status(400).json({ error: 'Alguna cuenta ya no está conectada. Recarga la página.' });

  const texto = String(b.texto || '').trim();
  const opciones = b.opciones && typeof b.opciones === 'object' ? b.opciones : {};
  const modo = b.modo === 'programar' ? 'programar' : 'ahora';
  const zona = String(b.zona || 'America/Santo_Domingo');
  const fechaLocal = String(b.fechaLocal || '');
  const errores = validarPublicacion({ texto, tipo: medio.tipo, cuentas, opciones, modo, fecha: b.fechaIso });
  if (modo === 'programar' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(fechaLocal)) errores.push('Fecha inválida.');
  if (errores.length) return res.status(400).json({ error: errores.join(' ') });

  const snapshot = cuentas.map((c) => ({ id: c.id, plataforma: c.plataforma, usuario: c.usuario, nombre: c.nombre, foto: c.foto }));
  const { rows: [p] } = await pool.query(
    `INSERT INTO publicaciones (generacion_id, indice, creado_por, texto, medio, cuentas, opciones, programada_para, zona)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, request_id`,
    [g.id, indice, req.user.email, texto, medio, JSON.stringify(snapshot), opciones,
      modo === 'programar' ? new Date(b.fechaIso) : null, modo === 'programar' ? zona : null]
  );

  try {
    const cuerpo = cuerpoZernio({ texto, medio, cuentas, opciones, modo, fechaLocal: fechaLocal.length === 16 ? fechaLocal + ':00' : fechaLocal, zona });
    cuerpo.metadata = { publicacion_id: String(p.id), panel: 'marketing-jh' }; // vuelve en los webhooks
    const r = await zernio.crearPost(cuerpo, p.request_id);
    const post = r.post || {};
    await pool.query(
      `UPDATE publicaciones SET zernio_post_id = $2, estado = $3, plataformas = $4, actualizado = now() WHERE id = $1`,
      [p.id, post._id || null, DESDE_ZERNIO[post.status] || 'publicando', JSON.stringify(post.platforms || [])]
    );
    console.log(`[redes] ${req.user.email} publicacion #${p.id} (${modo}) -> ${cuentas.map((c) => c.plataforma).join(',')} post=${post._id}`);
  } catch (e) {
    await pool.query(`UPDATE publicaciones SET estado = 'fallida', error = $2, error_detalle = $3, actualizado = now() WHERE id = $1`,
      [p.id, 'No se pudo enviar a las redes.', e.message.slice(0, 1000)]);
    throw e;
  }
  const { rows: [out] } = await pool.query(`SELECT ${COLS} FROM publicaciones WHERE id = $1`, [p.id]);
  res.status(201).json(out);
}));

router.get('/publicaciones', ruta(async (req, res) => {
  const gen = Number(req.query.generacion) || null;
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM publicaciones ${gen ? 'WHERE generacion_id = $1' : ''} ORDER BY id DESC LIMIT 60`, gen ? [gen] : []
  );
  res.json({ items: rows });
}));

// Calendario: publicaciones programadas o hechas en un rango (por fecha programada o de envio),
// con lo necesario de su creacion para mostrarlas. Las canceladas no se muestran.
router.get('/publicaciones/calendario', ruta(async (req, res) => {
  const desde = new Date(req.query.desde); const hasta = new Date(req.query.hasta);
  if (Number.isNaN(+desde) || Number.isNaN(+hasta) || hasta <= desde || hasta - desde > 45 * 864e5) return res.status(400).json({ error: 'Rango de fechas inválido.' });
  const { rows } = await pool.query(
    `SELECT p.id, p.generacion_id, p.indice, p.creado_por, p.texto, p.medio, p.cuentas, p.programada_para, p.zona, p.estado,
            p.error, p.creado, COALESCE(p.programada_para, p.creado) AS fecha,
            g.preset_nombre, g.preset_tipo, g.portada, g.resultados
     FROM publicaciones p JOIN generaciones g ON g.id = p.generacion_id
     WHERE p.estado <> 'cancelada' AND COALESCE(p.programada_para, p.creado) >= $1 AND COALESCE(p.programada_para, p.creado) < $2
     ORDER BY fecha`, [desde, hasta]
  );
  res.json({ items: rows });
}));

// Mover la fecha de una programada (antes de que salga).
router.post('/publicaciones/:id/reprogramar', requirePublicar, ruta(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT id, estado, zernio_post_id, zona FROM publicaciones WHERE id = $1', [Number(req.params.id) || 0]);
  if (!p) return res.status(404).json({ error: 'No existe.' });
  if (p.estado !== 'programada' || !p.zernio_post_id) return res.status(400).json({ error: 'Solo se puede mover la fecha de publicaciones programadas.' });
  const fechaLocal = String(req.body?.fechaLocal || '');
  const zona = String(req.body?.zona || p.zona || 'America/Santo_Domingo');
  const fechaIso = new Date(req.body?.fechaIso);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(fechaLocal) || Number.isNaN(+fechaIso)) return res.status(400).json({ error: 'Fecha inválida.' });
  if (fechaIso - Date.now() < 5 * 60e3) return res.status(400).json({ error: 'Elige una fecha al menos 5 minutos en el futuro.' });
  await zernio.reprogramarPost(p.zernio_post_id, fechaLocal.length === 16 ? fechaLocal + ':00' : fechaLocal, zona);
  await pool.query(`UPDATE publicaciones SET programada_para = $2, zona = $3, actualizado = now() WHERE id = $1`, [p.id, fechaIso, zona]);
  console.log(`[redes] ${req.user.email} movio la publicacion #${p.id} a ${fechaLocal} (${zona})`);
  res.json({ ok: true, programada_para: fechaIso.toISOString() });
}));

// Cancelar una programada (antes de que salga).
router.post('/publicaciones/:id/cancelar', requirePublicar, ruta(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT id, estado, zernio_post_id FROM publicaciones WHERE id = $1', [Number(req.params.id) || 0]);
  if (!p) return res.status(404).json({ error: 'No existe.' });
  if (p.estado !== 'programada' || !p.zernio_post_id) return res.status(400).json({ error: 'Solo se pueden cancelar publicaciones programadas.' });
  await zernio.borrarPost(p.zernio_post_id);
  await pool.query(`UPDATE publicaciones SET estado = 'cancelada', actualizado = now() WHERE id = $1`, [p.id]);
  console.log(`[redes] ${req.user.email} cancelo la publicacion #${p.id}`);
  res.json({ ok: true });
}));

module.exports = { router, cuerpoZernio };
