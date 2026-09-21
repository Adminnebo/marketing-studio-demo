/**
 * Camila dentro del panel: el equipo le pide un producto en lenguaje natural,
 * ella lo busca en el catalogo de JH (lib/jh-catalogo.js), dice si tiene foto y
 * deja la foto lista para crear. No es el flujo de WhatsApp: no manda mensajes,
 * no pasa por el CRM ni por Sword. Usa las mismas reglas de busqueda que la
 * Camila de WhatsApp (normalizacion, abreviaturas de la base, reintentos).
 *
 * Todo queda guardado por usuario: camila_conversaciones, camila_mensajes (con
 * las busquedas que hizo) y camila_usos (cada producto que se uso para crear).
 */
const { pool } = require('./db');
const catalogo = require('./jh-catalogo');

const API_KEY = process.env.OPENAI_API_KEY || '';
const URL_OPENAI = 'https://api.openai.com/v1/responses';
const MODELO = process.env.CAMILA_MODELO || 'gpt-4.1-mini';
const MAX_VUELTAS = 5; // busquedas por mensaje (con reintentos)
const HISTORIAL = 16; // mensajes anteriores que ve la IA
const TIEMPO_MAX_MS = 60000;

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
];

let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

class ErrorDeCamila extends Error {
  constructor(mensaje, { status = 502, detalle = null } = {}) { super(mensaje); this.status = status; this.detalle = detalle; }
}

const configurado = () => !!(API_KEY && catalogo.configurado());

const INSTRUCCIONES = `Eres Camila, la asistente de JH Electro Alambres (ferretería y material eléctrico en República Dominicana). Aquí trabajas dentro del panel de Marketing: el equipo de JH te pide productos del catálogo para crear fotos y videos con IA. Tu trabajo es encontrar el producto correcto, decir si tiene foto y dejarlo listo.

Tono: cercano, breve y claro, tuteo, español dominicano neutro. Un emoji como mucho. Nada de relleno.

## Cómo respondes
- SIEMPRE buscas con la herramienta buscar_productos antes de afirmar si hay o no hay un producto o foto. Nunca inventes códigos, nombres ni precios: solo usa filas que devolvió la herramienta.
- Tu respuesta final va en "texto" (1 a 3 frases cortas) y en "productos" (los códigos a mostrar, en orden, máximo 6). Las tarjetas ya muestran foto, código, nombre, precio e inventario: NO repitas esa lista en el texto.
- Di claramente si el producto tiene foto o no. Si el que pidió no tiene foto pero hay parecidos que sí, dilo y muéstralos. Si ninguno tiene foto, dilo y sugiere subir una foto propia en el paso "Tu foto".
- Si hay una sola coincidencia clara, muéstrala sola y di que ya se puede usar para crear.
- Si hay varias, muestra las mejores (primero las que tienen foto) y pregunta cuál usar.
- "sugerencias": hasta 3 respuestas rápidas que el usuario podría tocar para seguir buscando, concretas para ESTE producto (ej. "El de 2 polos", "En color negro", "Marca Siemens", "Solo con foto"). Máximo 25 caracteres cada una. Nada genérico como "Ver opciones" o "Ayuda". Si el pedido no era de productos, van vacías.
- Si piden algo que no es buscar productos (redactar textos, precios de competidores, etc.), di con amabilidad que aquí solo buscas productos del catálogo para crear contenido.
- Si el usuario se refiere a un producto ya mostrado ("el segundo", "ese"), búscalo por su código para confirmarlo.
- El precio es el de lista (P1) y el inventario es el total de las sedes: son datos internos del equipo, puedes mencionarlos si los piden.

## Cómo buscar (mismas reglas que en WhatsApp)
La herramienta recibe "palabras": cada palabra es un filtro y TODAS deben aparecer (en la descripción, los sinónimos o la marca). Si te dan un código o referencia, usa "codigo".

Normaliza SIEMPRE antes de buscar:
A. Abreviaturas de la base: tomacorriente/enchufe → ["toma","cte"]; interruptor → ["int"]; breaker/brake/bréiker → ["breaker"]; condulet/letra conduit → ["letra"] (+ tipo LB, LR, LL, T).
B. Separa compuestas: portalámpara → ["porta","lampara"]; portafusible → ["porta","fusible"]; cortacircuito → ["corta","circuito"]; guardamotor → ["guarda","motor"]. Excepción: destornillador no se separa.
C. Raíz singular, sin tildes ni diminutivos: breakers → breaker; bombillos/bombillas → "bombill"; tuberías → tubo; lámparas → lampara; válvulas → valvula; arnés → arnes; cajetines → cajetin.
D. Ignora frases de propósito ("de seguridad", "para baño", "para exteriores", "de agua", "para X"): el producto es el sustantivo. "arnés de seguridad para altura" → ["arnes"].
Componentes: producto (obligatorio) + marca, medida, color o tipo si los dijo. Ejemplos:
- "alambre cordiflex 6.0mm" → ["alambre","cordiflex","6.0"]
- "breakers Siemens 1P 20A" → ["breaker","siemens","20","1p"]
- "bombillo sylvania 40watts" → ["bombill","sylvania","40w"]
- "tuberías PVC 1/2" → ["tubo","pvc","1/2"]
- "tomacorriente doble blanco" → ["toma","cte","doble","blanco"]
- "lamparitas LED" → ["lampara","led"]
Corrige grafías de marcas conocidas (silvania → sylvania, sieme → siemens, levinton → leviton). Una marca de varias palabras va junta como una sola palabra clave: "square d", "cutler hammer", "general electric". Nunca uses letras o números sueltos de una sola letra como palabra clave.

Si no hay resultados, reintenta relajando UNA cosa a la vez: haz al menos 2 reintentos antes de decir que no hay (máximo 4 búsquedas en total): 1) quita la medida; 2) quita la marca; 3) solo el producto; 4) con "amplio": true (busca también en usos comunes) o un sinónimo (cable↔alambre, lampara↔bombill↔luminaria, valvula↔llave). Si encontraste algo parecido y no lo exacto, dilo: "No encontré exactamente X, pero tengo estas opciones".
Si la búsqueda trae demasiados resultados de una categoría amplia ("cable", "breaker"), muestra los más relevantes con foto y pregunta por el detalle que falta (calibre, amperaje, polos, marca, color…).`;

const HERRAMIENTAS = [{
  type: 'function',
  name: 'buscar_productos',
  description: 'Busca en el catálogo de JH. Devuelve productos con código, descripción, marca, precio P1, unidad, inventario total y si tienen foto y ficha técnica. Los que tienen foto vienen primero.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['palabras', 'codigo', 'amplio'],
    properties: {
      palabras: { type: 'array', items: { type: 'string' }, description: 'Palabras clave ya normalizadas (todas deben aparecer). Vacío si se busca por código.' },
      codigo: { type: ['string', 'null'], description: 'Código o referencia exacta del producto, o null.' },
      amplio: { type: 'boolean', description: 'true para buscar también en los usos comunes (solo como reintento).' },
    },
  },
}];

const RESPUESTA = {
  type: 'json_schema', name: 'respuesta_camila', strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['texto', 'productos', 'sugerencias'],
    properties: {
      texto: { type: 'string' },
      productos: { type: 'array', items: { type: 'string' } },
      sugerencias: { type: 'array', items: { type: 'string' } },
    },
  },
};

// Lo que ve la IA de cada producto (compacto: sin URLs).
const paraIa = (p) => ({ codigo: p.codigo, descripcion: p.descripcion, marca: p.marca, referencia: p.referencia, precio: p.precio, unidad: p.unidad, inventario: p.inventario, foto: !!p.foto, ficha: !!p.ficha });

// Historial para la IA: los productos mostrados van como texto para que pueda referirse a ellos.
function historialIa(mensajes) {
  return mensajes.slice(-HISTORIAL).map((m) => ({
    role: m.rol === 'usuario' ? 'user' : 'assistant',
    content: m.rol === 'camila' && m.productos?.length
      ? `${m.texto}\n[Productos mostrados: ${m.productos.map((p) => `${p.codigo} ${p.descripcion}${p.foto ? '' : ' (sin foto)'}`).join(' | ')}]`
      : m.texto,
  }));
}

async function llamarIa(cuerpo, pedir) {
  let r;
  try {
    r = await pedir(URL_OPENAI, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
  } catch (e) {
    throw new ErrorDeCamila('Camila no respondió. Intenta de nuevo en un momento.', { status: 503, detalle: e.message });
  }
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 300);
    throw new ErrorDeCamila(r.status === 401 || r.status === 403
      ? 'Camila no está bien configurada. Avísale al administrador.'
      : 'Camila está ocupada. Intenta de nuevo en un momento.', { status: 503, detalle: `HTTP ${r.status} ${detalle}` });
  }
  return r.json();
}

/**
 * Una vuelta de conversacion: historial + mensaje nuevo → respuesta con tarjetas.
 * Devuelve { texto, productos (tarjetas), sugerencias, busquedas, tokens, modelo }.
 */
async function responder({ historial = [], texto }, { fetch: pedir = globalThis.fetch } = {}) {
  if (!API_KEY) throw new ErrorDeCamila('Camila todavía no está configurada.', { status: 503 });
  const input = [...historialIa(historial), { role: 'user', content: texto }];
  const encontrados = new Map(); // codigo -> tarjeta (solo lo que devolvio el catalogo)
  // Lo ya mostrado en esta conversacion tambien vale (p. ej. "usa el segundo").
  for (const m of historial) for (const p of m.productos || []) encontrados.set(p.codigo, p);
  const busquedas = [];
  const tokens = { entrada: 0, salida: 0 };

  for (let vuelta = 0; vuelta <= MAX_VUELTAS; vuelta++) {
    const conHerramientas = vuelta < MAX_VUELTAS; // la ultima vuelta obliga a contestar
    const r = await llamarIa({
      model: MODELO, instructions: INSTRUCCIONES, input, store: false, temperature: 0.3, max_output_tokens: 1200,
      ...(conHerramientas ? { tools: HERRAMIENTAS, parallel_tool_calls: true } : {}),
      text: { format: RESPUESTA },
    }, pedir);
    tokens.entrada += r.usage?.input_tokens || 0;
    tokens.salida += r.usage?.output_tokens || 0;
    const llamadas = (r.output || []).filter((o) => o.type === 'function_call');
    if (llamadas.length) {
      input.push(...r.output.filter((o) => o.type === 'function_call'));
      for (const c of llamadas) {
        let args = {};
        try { args = JSON.parse(c.arguments || '{}'); } catch { /* args vacios */ }
        const pedido = { palabras: Array.isArray(args.palabras) ? args.palabras.map(String) : [], codigo: args.codigo ? String(args.codigo) : '', amplio: !!args.amplio };
        let salida;
        try {
          const res = await catalogo.buscar(pedido);
          for (const p of res.productos) encontrados.set(p.codigo, p);
          const conFoto = res.productos.filter((p) => p.foto).length;
          busquedas.push({ ...pedido, total: res.total, conFoto });
          salida = { total: res.total, con_foto: conFoto, productos: res.productos.slice(0, 12).map(paraIa), ...(res.total > 12 ? { nota: `Hay ${res.total} resultados; se muestran 12.` } : {}) };
        } catch (e) {
          console.error('[camila] buscar', e.message);
          busquedas.push({ ...pedido, error: e.message.slice(0, 200) });
          salida = { error: 'El catálogo no respondió. Dile al usuario que intente de nuevo en un momento.' };
        }
        input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(salida) });
      }
      continue;
    }
    const txt = (r.output || []).flatMap((o) => o.content || []).filter((b) => b.type === 'output_text').map((b) => b.text || '').join('');
    let d;
    try { d = JSON.parse(txt); } catch { throw new ErrorDeCamila('Camila se enredó con la respuesta. Intenta de nuevo.', { detalle: txt.slice(0, 300) }); }
    const codigos = [...new Set((d.productos || []).map((c) => String(c).trim()))];
    return {
      texto: String(d.texto || '').trim() || 'Listo.',
      productos: codigos.filter((c) => encontrados.has(c)).slice(0, 6).map((c) => encontrados.get(c)),
      sugerencias: (d.sugerencias || []).map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 3),
      busquedas, tokens, modelo: r.model || MODELO,
    };
  }
  throw new ErrorDeCamila('Camila no terminó la búsqueda. Intenta decirlo de otra forma.');
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

/** Guarda el mensaje del usuario, responde y guarda la respuesta (o el error). */
async function conversar({ user, conversacionId, texto }, opciones) {
  let conv = conversacionId ? await conversacionDe(user.email, conversacionId) : null;
  if (!conv) {
    const { rows: [c] } = await pool.query(
      'INSERT INTO camila_conversaciones (user_id, email, titulo) VALUES ($1, $2, $3) RETURNING id, titulo, creado',
      [user.id || null, user.email, texto.slice(0, 80)]
    );
    conv = c;
  }
  const historial = await mensajes(conv.id, HISTORIAL);
  const { rows: [mu] } = await pool.query(
    `INSERT INTO camila_mensajes (conversacion_id, rol, texto) VALUES ($1, 'usuario', $2) RETURNING ${COLS_MSJ}`, [conv.id, texto]
  );
  await pool.query('UPDATE camila_conversaciones SET actualizado = now() WHERE id = $1', [conv.id]);
  const t0 = Date.now();
  try {
    const r = await responder({ historial, texto }, opciones);
    const { rows: [mc] } = await pool.query(
      `INSERT INTO camila_mensajes (conversacion_id, rol, texto, productos, sugerencias, busquedas, modelo, tokens_entrada, tokens_salida, ms)
       VALUES ($1, 'camila', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS_MSJ}`,
      [conv.id, r.texto, JSON.stringify(r.productos), JSON.stringify(r.sugerencias), JSON.stringify(r.busquedas), r.modelo, r.tokens.entrada, r.tokens.salida, Date.now() - t0]
    );
    console.log(`[camila] ${user.email} conv ${conv.id} ${r.busquedas.length} busq · ${r.productos.length} prod · ${r.tokens.entrada}/${r.tokens.salida} tok · ${Date.now() - t0} ms`);
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

async function registrarUso({ email, conversacionId, codigo, descripcion, mediaId }) {
  await pool.query(
    'INSERT INTO camila_usos (conversacion_id, email, codigo, descripcion, media_id) VALUES ($1, $2, $3, $4, $5)',
    [conversacionId || null, email, codigo, descripcion || null, mediaId || null]
  );
}

module.exports = { migrar, configurado, responder, conversar, ultima, registrarUso, historialIa, ErrorDeCamila, INSTRUCCIONES, HERRAMIENTAS, MODELO };
