/**
 * Marketing Studio · DEMO para prospectos.
 *
 * Este servidor NO genera nada ni habla con el generador. Sirve la misma
 * interfaz del panel y traduce lo que ella pide a las rutas de servicio del
 * panel de produccion (`/api/demo/*`, ver server/demo.js alla). Tiene que ser
 * asi: el token del generador rota en cada renovacion y solo un proceso puede
 * rotarlo, asi que una segunda app con su propia copia dejaria a produccion sin
 * poder generar.
 *
 * Por eso tampoco tiene base de datos. La sesion es una cookie firmada con el
 * codigo del prospecto, y todo lo que importa —si el codigo vale, cuanto le
 * queda, que se puede generar, que no lo pague nadie— lo decide produccion.
 * Esta app es lo que queda expuesto a internet: si alguien la rompe, lo unico
 * que consigue es lo mismo que ya le daba su codigo.
 *
 * Variables:
 *   PANEL_API     URL del panel de produccion, sin barra final
 *   DEMO_CLAVE    la misma clave de servicio que tiene produccion
 *   DEMO_SESION   secreto para firmar la cookie (cualquier cadena larga)
 */
require('dotenv').config();
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');

const PORT = process.env.PORT || 3003;
const PANEL_API = (process.env.PANEL_API || '').replace(/\/+$/, '');
const CLAVE = process.env.DEMO_CLAVE || '';
const SECRETO = process.env.DEMO_SESION || '';
const COOKIE = 'ms_demo';
const DIAS_SESION = 7;
const configurado = () => !!(PANEL_API && CLAVE.length >= 24 && SECRETO.length >= 24);

class ErrorPanel extends Error {
  constructor(msg, status, datos) { super(msg); this.status = status; this.datos = datos || {}; }
}

// Una llamada al servicio de produccion, con la clave y el codigo del prospecto.
async function panel(ruta, { metodo = 'GET', cuerpo, codigo, crudo, cabeceras = {}, timeoutMs = 60000 } = {}) {
  if (!configurado()) throw new ErrorPanel('La demo no está configurada todavía.', 503);
  let r;
  try {
    r = await fetch(`${PANEL_API}/api/demo${ruta}`, {
      method: metodo,
      headers: {
        'x-demo-clave': CLAVE,
        ...(codigo ? { 'x-demo-codigo': codigo } : {}),
        ...(cuerpo ? { 'content-type': 'application/json' } : {}),
        ...cabeceras,
      },
      body: crudo || (cuerpo ? JSON.stringify(cuerpo) : undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error(`[panel] ${metodo} ${ruta}: ${e.message}`);
    throw new ErrorPanel('No pudimos conectar con el servicio. Intenta de nuevo en un momento.', 502);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 401 de la clave (no del codigo) es un problema nuestro, no del prospecto.
    if (r.status === 401 && !j.motivo) {
      console.error('[panel] la clave de servicio no coincide con la de producción');
      throw new ErrorPanel('La demo no está disponible en este momento.', 503);
    }
    throw new ErrorPanel(j.error || 'No se pudo completar.', r.status, j);
  }
  return j;
}

// ── Sesion: una cookie firmada con el codigo ─────────────────────────────────
const firma = (texto) => crypto.createHmac('sha256', SECRETO).update(texto).digest('base64url');

function sellar(codigo) {
  const cuerpo = Buffer.from(JSON.stringify({ c: codigo, e: Date.now() + DIAS_SESION * 864e5 })).toString('base64url');
  return `${cuerpo}.${firma(cuerpo)}`;
}

function abrir(valor) {
  if (!valor || !SECRETO) return null;
  const [cuerpo, f] = String(valor).split('.');
  if (!cuerpo || !f) return null;
  const esperada = firma(cuerpo);
  if (f.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(f), Buffer.from(esperada))) return null;
  try {
    const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    return d.e > Date.now() && d.c ? d.c : null;
  } catch { return null; }
}

const cookieDe = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((x) => x.trim().split('=').map(decodeURIComponent)).filter((x) => x.length === 2))[COOKIE];
const ponerCookie = (res, valor, segundos) => res.setHeader('Set-Cookie',
  `${COOKIE}=${encodeURIComponent(valor)}; Path=/; Max-Age=${segundos}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);

// ── Freno a quien prueba codigos ─────────────────────────────────────────────
// Los codigos tienen ~40 bits; con 8 intentos cada 10 minutos por IP no se
// adivinan. Es memoria del proceso: con una sola instancia alcanza.
const intentos = new Map();
const MAX_INTENTOS = 8;
const VENTANA_MS = 10 * 60e3;
function frenado(ip) {
  const ahora = Date.now();
  const lista = (intentos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  intentos.set(ip, lista);
  return lista.length >= MAX_INTENTOS;
}
const anotarFallo = (ip) => intentos.set(ip, [...(intentos.get(ip) || []), Date.now()]);
setInterval(() => { const a = Date.now(); for (const [ip, l] of intentos) if (!l.some((t) => a - t < VENTANA_MS)) intentos.delete(ip); }, 60e3).unref();

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// El enlace de acceso puede llevar el codigo (?codigo=...): que no salga en el
// Referer hacia el almacenamiento de los videos ni hacia ningun otro sitio.
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const ruta = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof ErrorPanel) {
      // Codigo revocado o caducado a mitad de sesion: se cierra y vuelve al acceso.
      if (e.status === 401) { ponerCookie(res, '', 0); return res.status(401).json({ ...e.datos, error: e.message }); }
      return res.status(e.status || 500).json({ ...e.datos, error: e.message });
    }
    console.error(`[${req.method} ${req.originalUrl}]`, e.message);
    res.status(500).json({ error: 'No se pudo completar. Intenta de nuevo.' });
  }
};

app.get('/api/health', (req, res) => res.json({ ok: true, demo: true, configurado: configurado() }));

// La interfaz pregunta esto al arrancar: con `demo` no monta el login del panel.
app.get('/api/config', (req, res) => res.json({ demo: true, contacto: process.env.DEMO_CONTACTO || null }));

app.post('/api/demo/entrar', ruta(async (req, res) => {
  if (frenado(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' });
  const codigo = String(req.body?.codigo || '').trim();
  if (!codigo) return res.status(400).json({ error: 'Escribe tu código de acceso.' });
  try {
    const d = await panel('/entrar', { metodo: 'POST', cuerpo: { codigo } });
    ponerCookie(res, sellar(d.codigo), DIAS_SESION * 86400);
    res.json({ prospecto: d.prospecto, cupo: d.cupo, caduca: d.caduca });
  } catch (e) {
    if (e instanceof ErrorPanel && e.status === 401) {
      anotarFallo(req.ip);
      return res.status(401).json({ ...e.datos, error: e.message });
    }
    throw e;
  }
}));

app.post('/api/demo/salir', (req, res) => { ponerCookie(res, '', 0); res.json({ ok: true }); });

// De aqui para abajo, todo necesita la sesion.
app.use('/api', (req, res, next) => {
  const codigo = abrir(cookieDe(req));
  if (!codigo) return res.status(401).json({ error: 'Entra con tu código de acceso.' });
  req.codigo = codigo;
  next();
});

app.get('/api/demo/sesion', ruta(async (req, res) => res.json(await panel('/estado', { codigo: req.codigo }))));

// ── La API del panel, tal como la espera la interfaz ─────────────────────────

// Quien soy: un usuario sin saldo ni permisos, con su cupo de demo.
app.get('/api/me', ruta(async (req, res) => {
  const e = await panel('/estado', { codigo: req.codigo });
  res.json({
    email: e.prospecto, nombre: e.prospecto, rol: 'usuario', rolReal: 'usuario', verComo: null,
    puedePublicar: false, puedeAprobar: false, puedeLogos: false, precios: null,
    demo: { cupo: e.cupo, caduca: e.caduca, activa: e.activa, descripciones: e.descripciones },
  });
}));

app.get('/api/estado', (req, res) => res.json({ conectado: true, demo: true }));

// Los modelos, con `bloqueado` en los que la demo no puede usar. Primero los
// abiertos: la interfaz elige el primero de cada tipo.
app.get('/api/modelos', ruta(async (req, res) => {
  const o = await panel('/opciones', { codigo: req.codigo });
  const modelos = [...o.modelos].sort((a, b) => Number(a.bloqueado) - Number(b.bloqueado));
  res.json({ modelos });
}));

app.post('/api/medios', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '60mb' }), ruta(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Sube una imagen PNG, JPG o WEBP.' });
  res.json(await panel('/medios', {
    metodo: 'POST', codigo: req.codigo, crudo: req.body, timeoutMs: 180000,
    cabeceras: { 'content-type': String(req.headers['content-type'] || '').split(';')[0], 'x-nombre': String(req.headers['x-nombre'] || 'producto').slice(0, 120) },
  }));
}));

// En la demo no hay precio: las dos piezas son de cortesia.
app.post('/api/libre/costo', (req, res) => res.json({ creditos: null, precio: null, demo: true }));

// El tipo sale del modelo pedido; el resto de lo que mande el navegador se ignora
// alla: modelo, resolucion y duracion los decide produccion.
async function tipoDe(codigo, modeloId) {
  const o = await panel('/opciones', { codigo });
  const m = o.modelos.find((x) => x.id === modeloId);
  if (!m) throw new ErrorPanel('Elige un modelo.', 400);
  if (m.bloqueado) throw new ErrorPanel(`${m.nombre} está en la versión completa.`, 403, { bloqueado: true });
  return m.tipo;
}

app.post('/api/libre/autoprompt', ruta(async (req, res) => {
  const b = req.body || {};
  const tipo = await tipoDe(req.codigo, String(b.modelo || ''));
  const r = await panel('/descripcion', {
    metodo: 'POST', codigo: req.codigo, timeoutMs: 120000,
    cuerpo: { tipo, imagen: b.imagen, aspecto: b.aspecto, producto: b.producto, instrucciones: b.instrucciones },
  });
  res.json({ prompt: r.prompt, avisos: r.avisos, costoIa: 0, quedan: r.quedan });
}));

app.post('/api/libre', ruta(async (req, res) => {
  const b = req.body || {};
  const tipo = await tipoDe(req.codigo, String(b.modelo || ''));
  const g = await panel('/generaciones', {
    metodo: 'POST', codigo: req.codigo,
    cuerpo: { tipo, prompt: b.prompt, aspecto: b.aspecto, imagen: b.imagen },
  });
  res.status(201).json(g);
}));

app.get('/api/generaciones', ruta(async (req, res) => {
  const { items } = await panel('/generaciones', { codigo: req.codigo });
  res.json({ items, siguiente: null });
}));

app.get('/api/generaciones/:id', ruta(async (req, res) => {
  res.json(await panel(`/generaciones/${Number(req.params.id) || 0}`, { codigo: req.codigo }));
}));

// Descargar: se baja del almacenamiento del generador y se entrega con nombre.
app.get('/api/generaciones/:id/descargar', ruta(async (req, res) => {
  const g = await panel(`/generaciones/${Number(req.params.id) || 0}`, { codigo: req.codigo });
  const ok = (g.resultados || []).filter((r) => r.url);
  const i = Math.max(0, Math.min(Number(req.query.i) || 0, ok.length - 1));
  if (!ok[i]) return res.status(404).json({ error: 'No hay archivo para descargar.' });
  const r = await fetch(ok[i].url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok || !r.body) return res.status(502).json({ error: 'No se pudo descargar el archivo.' });
  const ext = (new URL(ok[i].url).pathname.match(/\.(png|jpe?g|webp|mp4|mov|webm)$/i) || [, 'bin'])[1].toLowerCase();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  if (r.headers.get('content-length')) res.setHeader('Content-Length', r.headers.get('content-length'));
  res.setHeader('Content-Disposition', `attachment; filename="marketing_studio_demo_${g.id}.${ext}"`);
  Readable.fromWeb(r.body).pipe(res);
}));

// Cualquier otra ruta del panel no existe en la demo.
app.use('/api', (req, res) => res.status(404).json({ error: 'Eso está en la versión completa.', completa: true }));

// ── La interfaz ──────────────────────────────────────────────────────────────
const dist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(dist, { index: false, maxAge: '1h' }));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));

if (require.main === module) {
  if (!configurado()) console.warn('AVISO: faltan PANEL_API, DEMO_CLAVE o DEMO_SESION (24 caracteres o más): nadie podrá entrar.');
  app.listen(PORT, () => console.log(`Marketing Studio DEMO en :${PORT} → ${PANEL_API || '(sin PANEL_API)'}`));
}

module.exports = { app, sellar, abrir, frenado, anotarFallo, _intentos: intentos };
