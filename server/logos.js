/**
 * Logos de la marca de agua: la lista y los archivos los ve cualquiera con acceso; subir,
 * cambiar y borrar pide el permiso 'subir_logos' (o ser super admin). Los ajustes (esquina,
 * tamaño, margen, opacidad y si se pone sola) viven en config (lib/config.js).
 */
const express = require('express');
const logos = require('./lib/logos');
const marca = require('./lib/marca');
const ajustes = require('./lib/config');

const router = express.Router();

const ruta = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof logos.ErrorDeLogo || e instanceof marca.ErrorDeMarca) return res.status(e.status || 400).json({ error: e.message });
    console.error(`[${req.method} ${req.originalUrl}]`, e.message);
    res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
  }
};
const soloLogos = (req, res, next) => (req.user.puedeLogos ? next()
  : res.status(403).json({ error: 'Tu usuario no puede subir ni borrar logos.' }));

const AJUSTES = ['logo_auto', 'logo_tam', 'logo_margen', 'logo_opacidad', 'logo_pos_vertical', 'logo_pos_resto'];
const soloAjustes = (a) => Object.fromEntries(AJUSTES.map((k) => [k, a[k]]));

router.get('/logos', ruta(async (req, res) => {
  const [lista, a] = await Promise.all([logos.lista(), ajustes.leer()]);
  res.json({ logos: lista, ajustes: soloAjustes(a), puedeSubir: !!req.user.puedeLogos, ffmpeg: await marca.disponible() });
}));

// El archivo del logo. Va aparte y SIN sesión: las etiquetas <img> del navegador no mandan el
// token, y un logo de marca no es secreto (termina impreso en lo que se publica).
const publico = express.Router();
publico.get('/logos/:id/:version', ruta(async (req, res) => {
  const a = await logos.archivo(Number(req.params.id) || 0, req.params.version.replace(/\.\w+$/, ''));
  if (!a) return res.status(404).json({ error: 'No está.' });
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.end(a.bytes);
}));

// Sube una versión del logo. Cabeceras: x-nombre, x-version (claro|oscuro), x-logo-id (para añadir
// la otra versión a uno que ya existe) y x-quitar-fondo: 1 para dejar transparente el fondo blanco.
const TIPOS = Object.keys(logos.TIPOS);
router.post('/logos', soloLogos, express.raw({ type: TIPOS, limit: '3mb' }), ruta(async (req, res) => {
  const mime = (req.headers['content-type'] || '').split(';')[0];
  let bytes = req.body;
  let quitado = false;
  if (req.headers['x-quitar-fondo'] === '1') {
    const r = await marca.quitarFondo(bytes, logos.TIPOS[mime] || 'png').catch((e) => { console.error('[logos] quitar fondo', e.message); return null; });
    if (r) { bytes = r; quitado = true; }
  }
  const l = await logos.guardar({
    id: Number(req.headers['x-logo-id']) || null,
    nombre: req.headers['x-nombre'] ? decodeURIComponent(req.headers['x-nombre']) : 'Logo',
    version: req.headers['x-version'] === 'oscuro' ? 'oscuro' : 'claro',
    bytes, mime: quitado ? 'image/png' : mime, por: req.user.email,
  });
  console.log(`[logos] ${req.user.email} subió "${l.nombre}" (${req.headers['x-version'] || 'claro'}${quitado ? ', sin fondo' : ''})`);
  res.status(201).json(l);
}));

router.put('/logos/:id', soloLogos, ruta(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (req.body?.porDefecto === true) return res.json(await logos.marcarDefecto(id));
  res.json(await logos.renombrar(id, req.body?.nombre));
}));

router.delete('/logos/:id', soloLogos, ruta(async (req, res) => {
  const l = await logos.borrar(Number(req.params.id) || 0, { version: req.query.version || null });
  console.log(`[logos] ${req.user.email} borró el logo ${req.params.id}${req.query.version ? ` (${req.query.version})` : ''}`);
  res.json({ ok: true, logo: l });
}));

router.put('/logos/ajustes', soloLogos, ruta(async (req, res) => {
  const cambios = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => AJUSTES.includes(k)));
  await ajustes.guardar(cambios, req.user.email);
  res.json({ ajustes: soloAjustes(await ajustes.leer()) });
}));

module.exports = { router, publico };
