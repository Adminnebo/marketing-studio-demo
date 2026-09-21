/**
 * Rutas de Camila (buscar productos de JH y dejarlos listos para crear).
 * Van detras de auth.requireAcceso: cualquiera con acceso al panel la puede usar.
 */
const express = require('express');
const camila = require('./lib/camila');
const catalogo = require('./lib/jh-catalogo');
const hf = require('./lib/higgsfield');

const router = express.Router();

// Tope simple por usuario para que un bucle o un doble clic no dispare costos.
const TOPE = { mensajes: 40, ventanaMs: 10 * 60e3 };
const _uso = new Map();
function dentroDelTope(email) {
  const ahora = Date.now();
  const lista = (_uso.get(email) || []).filter((t) => ahora - t < TOPE.ventanaMs);
  if (lista.length >= TOPE.mensajes) { _uso.set(email, lista); return false; }
  lista.push(ahora);
  _uso.set(email, lista);
  return true;
}

const errorDe = (res, e) => {
  if (e instanceof camila.ErrorDeCamila) {
    console.error('[camila]', e.message, e.detalle || '');
    return res.status(e.status).json({ error: e.message, conversacionId: e.conversacionId || null });
  }
  if (e instanceof hf.HiggsfieldError) {
    console.error('[camila usar]', e.message);
    return res.status(502).json({ error: 'No se pudo preparar la foto para crear. Intenta de nuevo en un momento.' });
  }
  console.error('[camila]', e.message);
  res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
};

router.get('/camila/estado', (req, res) => res.json({ configurado: camila.configurado() }));

// La ultima conversacion del usuario, para seguir donde la dejo.
router.get('/camila/conversacion', async (req, res) => {
  try { res.json({ conversacion: await camila.ultima(req.user.email) }); } catch (e) { errorDe(res, e); }
});

router.post('/camila/mensaje', async (req, res) => {
  const b = req.body || {};
  const texto = String(b.texto || '').trim().slice(0, 600);
  if (!texto) return res.status(400).json({ error: 'Escribe qué producto buscas.' });
  if (!camila.configurado()) return res.status(503).json({ error: 'Camila todavía no está conectada al catálogo. Avísale al administrador.' });
  if (!dentroDelTope(req.user.email)) return res.status(429).json({ error: 'Vas muy rápido: espera unos minutos y sigue.' });
  try {
    const conversacionId = Number(b.conversacionId) > 0 ? Number(b.conversacionId) : null;
    res.json(await camila.conversar({ user: req.user, conversacionId, texto }));
  } catch (e) { errorDe(res, e); }
});

// "Usar para crear": importa la foto del producto al generador y la devuelve lista
// ({ media_id, url, nombre }), igual que una subida desde la computadora.
router.post('/camila/usar', async (req, res) => {
  const b = req.body || {};
  const codigo = String(b.codigo || '').trim().slice(0, 30);
  if (!codigo) return res.status(400).json({ error: 'Falta el producto.' });
  try {
    const { productos: [p] } = await catalogo.buscar({ codigo });
    if (!p) return res.status(404).json({ error: 'Ese producto ya no aparece en el catálogo.' });
    const foto = p.foto || (await catalogo.archivosDe(p.codigo, { relistar: true })).imagen;
    if (!foto) return res.status(404).json({ error: 'Ese producto no tiene foto cargada. Sube una foto propia en el paso "Tu foto".' });
    const imp = await hf.llamar('media_import_url', { url: foto, type: 'image' });
    if (!imp?.media_id) throw new hf.HiggsfieldError('media_import_url sin media_id: ' + JSON.stringify(imp).slice(0, 200));
    await camila.registrarUso({ email: req.user.email, conversacionId: Number(b.conversacionId) || null, codigo: p.codigo, descripcion: p.descripcion, mediaId: imp.media_id })
      .catch((e) => console.error('[camila usar] registro', e.message));
    res.json({
      media_id: imp.media_id, url: foto, nombre: p.descripcion || p.codigo,
      producto: { codigo: p.codigo, descripcion: p.descripcion, marca: p.marca, ficha: p.ficha },
    });
  } catch (e) { errorDe(res, e); }
});

module.exports = { router };
