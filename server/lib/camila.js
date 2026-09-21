/**
 * Camila dentro del panel: el equipo le pide un producto en lenguaje natural y
 * responde la Camila paralela de n8n (flujo "Agente JH Electro Alambres", canal
 * marketing_request): busca en el catalogo de JH con el normalizador, dice si hay
 * foto y ficha y devuelve { texto, productos, sugerencias }. Aqui se le agregan
 * las URLs de foto y ficha (buckets de Supabase, archivo = codigo) y se guarda todo.
 *
 * n8n no manda nada a clientes con ese canal, guarda el mensaje en mensajes_chat
 * (canal marketing_request) y registra el costo real en Sword (Camila Marketing).
 *
 * Aqui queda guardado por usuario: camila_conversaciones, camila_mensajes y
 * camila_usos (cada producto que se uso para crear).
 */
const { pool } = require('./db');
const catalogo = require('./jh-catalogo');

const N8N_URL = process.env.CAMILA_N8N_URL || '';
const N8N_TOKEN = process.env.CAMILA_N8N_TOKEN || '';
const HISTORIAL = 16; // mensajes anteriores que se devuelven al retomar
const TIEMPO_MAX_MS = 150000; // DeepSeek con razonamiento tarda (15-40 s tipico)

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS camila_conversaciones (
     id BIGSERIAL PRIMARY KEY,
     user_id UUID,
     email TEXT NOT NULL,
     titulo TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS camila_conv_usuario_idx ON camila_conversaciones (email, actualizado DESC)`,
  `CREATE TABLE IF NOT EXISTS camila_mensajes (
     id BIGSERIAL PRIMARY KEY,
     conversacion_id BIGINT NOT NULL REFERENCES camila_conversaciones(id),
     rol TEXT NOT NULL CHECK (rol IN ('usuario', 'camila')),
     texto TEXT NOT NULL,
     productos JSONB,
     sugerencias JSONB,
     busquedas JSONB,
     modelo TEXT,
     tokens_entrada INT,
     tokens_salida INT,
     ms INT,
     error TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS camila_msj_conv_idx ON camila_mensajes (conversacion_id, id)`,
  `CREATE TABLE IF NOT EXISTS camila_usos (
     id BIGSERIAL PRIMARY KEY,
     conversacion_id BIGINT REFERENCES camila_conversaciones(id),
     email TEXT NOT NULL,
     codigo TEXT NOT NULL,
     descripcion TEXT,
     media_id TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Id de la ejecucion de n8n de cada respuesta (para cruzar con n8n, mensajes_chat y Sword).
  `ALTER TABLE camila_mensajes ADD COLUMN IF NOT EXISTS n8n_ejecucion TEXT`,
];

let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

class ErrorDeCamila extends Error {
  constructor(mensaje, { status = 502, detalle = null } = {}) { super(mensaje); this.status = status; this.detalle = detalle; }
}

const configurado = () => !!(N8N_URL && N8N_TOKEN);

// La memoria de n8n va por contact_id: uno por conversacion del panel.
const contactoDe = (conv) => `mkt-${conv.id}-${new Date(conv.creado).getTime().toString(36)}`;

/** Tarjeta del panel a partir de un producto de n8n, con las URLs de foto y ficha del bucket. */
async function tarjeta(p) {
  const codigo = String(p.codigo || '').trim();
  let arch = { imagen: null, ficha: null };
  try { arch = await catalogo.archivosDe(codigo); } catch (e) { console.error('[camila] indice de fotos', e.message); }
  const inv = Number(p.inventario);
  return {
    codigo,
    descripcion: String(p.descripcion || codigo),
    marca: p.marca || null,
    precio: p.precio != null && Number.isFinite(Number(p.precio)) ? Number(p.precio) : null,
    unidad: p.unidad || null,
    inventario: Number.isFinite(inv) ? inv : null,
    foto: arch.imagen,
    ficha: arch.ficha,
    tiene_imagen: !!p.tiene_imagen,
  };
}

/**
 * Pregunta a la Camila paralela de n8n. Devuelve { texto, productos (tarjetas), sugerencias, ejecucion }.
 */
async function responder({ contactId, texto, usuario }, { fetch: pedir = globalThis.fetch } = {}) {
  if (!configurado()) throw new ErrorDeCamila('Camila todavía no está conectada. Avísale al administrador.', { status: 503 });
  let r;
  try {
    r = await pedir(N8N_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-panel-token': N8N_TOKEN },
      body: JSON.stringify({ canal: 'marketing_request', contact_id: contactId, mensaje: texto, usuario_panel: usuario, user_id: `marketing:${usuario}` }),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
  } catch (e) {
    throw new ErrorDeCamila(e.name === 'TimeoutError' ? 'Camila tardó demasiado. Intenta de nuevo.' : 'Camila no respondió. Intenta de nuevo en un momento.', { status: 503, detalle: e.message });
  }
  const crudo = await r.text().catch(() => '');
  if (!r.ok) {
    throw new ErrorDeCamila(r.status === 401 || r.status === 403
      ? 'Camila no está bien conectada. Avísale al administrador.'
      : 'Camila está ocupada. Intenta de nuevo en un momento.', { status: 503, detalle: `HTTP ${r.status} ${crudo.slice(0, 300)}` });
  }
  let d;
  try { d = JSON.parse(crudo); } catch { d = null; }
  if (!d || d.ok !== true || typeof d.texto !== 'string') {
    throw new ErrorDeCamila('Camila se enredó con la respuesta. Intenta de nuevo.', { detalle: crudo.slice(0, 300) });
  }
  const productos = await Promise.all((Array.isArray(d.productos) ? d.productos : []).filter((p) => p && p.codigo != null).slice(0, 6).map(tarjeta));
  return {
    texto: d.texto.trim() || 'Listo.',
    productos,
    sugerencias: (Array.isArray(d.sugerencias) ? d.sugerencias : []).map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 3),
    ejecucion: d.execution_id != null ? String(d.execution_id) : null,
  };
}

// ── Guardado ──
const COLS_MSJ = 'id, rol, texto, productos, sugerencias, creado';

async function conversacionDe(email, id) {
  const { rows: [c] } = await pool.query('SELECT id, titulo, creado FROM camila_conversaciones WHERE id = $1 AND email = $2', [id, email]);
  return c || null;
}

async function mensajes(conversacionId, limite = 60) {
  const { rows } = await pool.query(
    `SELECT * FROM (SELECT ${COLS_MSJ} FROM camila_mensajes WHERE conversacion_id = $1 ORDER BY id DESC LIMIT $2) x ORDER BY id`,
    [conversacionId, limite]
  );
  return rows;
}

async function ultima(email) {
  const { rows: [c] } = await pool.query('SELECT id, titulo, creado FROM camila_conversaciones WHERE email = $1 ORDER BY actualizado DESC LIMIT 1', [email]);
  return c ? { ...c, mensajes: await mensajes(c.id) } : null;
}

/** Guarda el mensaje del usuario, pregunta a Camila y guarda la respuesta (o el error). */
async function conversar({ user, conversacionId, texto }, opciones) {
  let conv = conversacionId ? await conversacionDe(user.email, conversacionId) : null;
  if (!conv) {
    const { rows: [c] } = await pool.query(
      'INSERT INTO camila_conversaciones (user_id, email, titulo) VALUES ($1, $2, $3) RETURNING id, titulo, creado',
      [user.id || null, user.email, texto.slice(0, 80)]
    );
    conv = c;
  }
  const { rows: [mu] } = await pool.query(
    `INSERT INTO camila_mensajes (conversacion_id, rol, texto) VALUES ($1, 'usuario', $2) RETURNING ${COLS_MSJ}`, [conv.id, texto]
  );
  await pool.query('UPDATE camila_conversaciones SET actualizado = now() WHERE id = $1', [conv.id]);
  const t0 = Date.now();
  try {
    const r = await responder({ contactId: contactoDe(conv), texto, usuario: user.email }, opciones);
    const { rows: [mc] } = await pool.query(
      `INSERT INTO camila_mensajes (conversacion_id, rol, texto, productos, sugerencias, modelo, ms, n8n_ejecucion)
       VALUES ($1, 'camila', $2, $3, $4, 'n8n', $5, $6) RETURNING ${COLS_MSJ}`,
      [conv.id, r.texto, JSON.stringify(r.productos), JSON.stringify(r.sugerencias), Date.now() - t0, r.ejecucion]
    );
    console.log(`[camila] ${user.email} conv ${conv.id} · ${r.productos.length} prod · n8n ${r.ejecucion} · ${Date.now() - t0} ms`);
    return { conversacionId: conv.id, usuario: mu, camila: mc };
  } catch (e) {
    await pool.query(
      `INSERT INTO camila_mensajes (conversacion_id, rol, texto, error, ms) VALUES ($1, 'camila', $2, $3, $4)`,
      [conv.id, e.message, String(e.detalle || e.message).slice(0, 500), Date.now() - t0]
    ).catch(() => {});
    e.conversacionId = conv.id;
    throw e;
  }
}

/** El producto tal como Camila se lo mostro a este usuario (el ultimo mensaje que lo trae). */
async function productoMostrado(email, codigo) {
  const { rows: [m] } = await pool.query(
    `SELECT m.productos FROM camila_mensajes m JOIN camila_conversaciones c ON c.id = m.conversacion_id
     WHERE c.email = $1 AND m.productos @> $2::jsonb ORDER BY m.id DESC LIMIT 1`,
    [email, JSON.stringify([{ codigo }])]
  );
  return m ? m.productos.find((p) => p.codigo === codigo) : null;
}

async function registrarUso({ email, conversacionId, codigo, descripcion, mediaId }) {
  await pool.query(
    'INSERT INTO camila_usos (conversacion_id, email, codigo, descripcion, media_id) VALUES ($1, $2, $3, $4, $5)',
    [conversacionId || null, email, codigo, descripcion || null, mediaId || null]
  );
}

module.exports = { migrar, configurado, responder, conversar, ultima, productoMostrado, registrarUso, contactoDe, ErrorDeCamila };
