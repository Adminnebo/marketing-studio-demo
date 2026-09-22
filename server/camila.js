/**
 * Rutas de Camila (buscar productos de JH y dejarlos listos para crear).
 * Van detras de auth.requireAcceso: cualquiera con acceso al panel la puede usar.
 */
const express = require('express');
const camila = require('./lib/camila');
const catalogo = require('./lib/jh-catalogo');
const hf = require('./lib/higgsfield');
const fichas = require('./lib/fichas');
const saldoMarketing = require('./lib/saldo-marketing');

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
  if (e instanceof fichas.ErrorDeFicha) {
    console.error('[fichas]', e.message, e.detalle || '');
    return res.status(e.status).json({ error: e.message });
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
  if (!camila.configurado()) return res.status(503).json({ error: 'Camila todavía no está conectada. Avísale al administrador.' });
  if (!dentroDelTope(req.user.email)) return res.status(429).json({ error: 'Vas muy rápido: espera unos minutos y sigue.' });
  try {
    const conversacionId = Number(b.conversacionId) > 0 ? Number(b.conversacionId) : null;
    res.json(await camila.conversar({ user: req.user, conversacionId, texto }));
  } catch (e) { errorDe(res, e); }
});

// "Usar para crear": importa la foto del producto al generador y la devuelve lista
// ({ media_id, url, nombre }), igual que una subida desde la computadora. Solo vale
// para productos que Camila le mostro a este usuario.
router.post('/camila/usar', async (req, res) => {
  const b = req.body || {};
  const codigo = String(b.codigo || '').trim().slice(0, 30);
  if (!codigo) return res.status(400).json({ error: 'Falta el producto.' });
  try {
    const p = await camila.productoMostrado(req.user.email, codigo);
    if (!p) return res.status(404).json({ error: 'Ese producto no aparece en tus búsquedas con Camila. Búscalo de nuevo.' });
    const foto = (await catalogo.archivosDe(codigo, { relistar: true })).imagen;
    if (!foto) return res.status(404).json({ error: 'Ese producto no tiene foto cargada. Sube una foto propia en el paso "Tu foto".' });
    const imp = await hf.llamar('media_import_url', { url: foto, type: 'image' });
    if (!imp?.media_id) throw new hf.HiggsfieldError('media_import_url sin media_id: ' + JSON.stringify(imp).slice(0, 200));
    await camila.registrarUso({ email: req.user.email, conversacionId: Number(b.conversacionId) || null, codigo, descripcion: p.descripcion, mediaId: imp.media_id })
      .catch((e) => console.error('[camila usar] registro', e.message));
    res.json({
      media_id: imp.media_id, url: foto, nombre: p.descripcion || codigo,
      producto: { codigo, descripcion: p.descripcion, marca: p.marca || null, ficha: p.ficha || null },
    });
  } catch (e) { errorDe(res, e); }
});

// Datos de la ficha tecnica para la descripcion (solo de productos que Camila le mostro a este usuario).
router.post('/camila/ficha', async (req, res) => {
  const codigo = String((req.body || {}).codigo || '').trim().slice(0, 30);
  if (!codigo) return res.status(400).json({ error: 'Falta el producto.' });
  try {
    if (!(await camila.productoMostrado(req.user.email, codigo))) return res.status(404).json({ error: 'Ese producto no aparece en tus búsquedas con Camila.' });
    if (!(await saldoMarketing.puedeGastarIa(req.user))) return res.status(402).json({ error: 'No hay saldo de Marketing para usar la IA. Pide una recarga en Créditos.', sinSaldo: true });
    // Solo se cobra la primera lectura (despues queda guardada y no cuesta); un super admin va al saldo general.
    const cobrar = (uso, extra = '') => saldoMarketing.cobrarIa({ por: req.user.email, clase: 'ficha', detalle: `cód. ${codigo}${extra}`, modelo: uso.modelo, entrada: uso.entrada, salida: uso.salida,
      ref: extra ? null : `ficha:${codigo}`, aJh: saldoMarketing.exento(req.user) }).catch((e) => { console.error('[fichas] cobro IA', e.message); return 0; });
    let uso; let r;
    try { ({ uso, ...r } = await fichas.extraer(codigo)); } catch (e) { if (e.uso) await cobrar(e.uso, ' · no salió'); throw e; }
    if (r.sinFicha) return res.json({ sinFicha: true });
    const costoIa = uso ? await cobrar(uso) : 0;
    res.json({ ...r, costoIa });
  } catch (e) { errorDe(res, e); }
});

module.exports = { router };
