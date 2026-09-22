/**
 * Caption y hashtags recomendados para publicar un resultado del panel en redes.
 *
 * La IA ve la imagen (o la portada/foto del producto si es video) y usa lo que se sabe
 * del producto: el nombre, la descripcion con la que se creo y, si se eligio con Camila,
 * los datos de su ficha tecnica ya leidos (camila_usos + camila_fichas). No inventa
 * precios, promociones, telefonos ni links.
 */
const { pool } = require('./db');

const API_KEY = process.env.OPENAI_API_KEY || '';
const URL_OPENAI = 'https://api.openai.com/v1/responses';
const MODELO = process.env.CAPTIONS_MODELO || 'gpt-4.1-mini';

class ErrorDeCaption extends Error {
  constructor(mensaje, { status = 502, detalle = null } = {}) { super(mensaje); this.status = status; this.detalle = detalle; }
}

const TONOS = {
  cercano: 'Cercano y amigable, como le habla un vendedor de confianza a un cliente de siempre.',
  profesional: 'Profesional y técnico pero claro, para contratistas, electricistas y empresas.',
  promocion: 'Promocional con urgencia suave ("ven por el tuyo", "disponible ya"), sin inventar descuentos, precios ni fechas.',
};

const INSTRUCCIONES = `Eres el community manager de JH Electro Alambres, ferretería y distribuidora de material eléctrico, plomería, iluminación y herramientas en República Dominicana (sucursales en La Vega, Santo Domingo, Pontón y Bávaro). Escribes el texto de una publicación para redes sociales a partir de la foto o video que se va a publicar y de los datos del producto.

Reglas del caption (contenido):
- Español dominicano neutro, tuteo. Frases cortas.
- Usa datos concretos (potencia, medidas, amperaje, marca…) SOLO si vienen en los datos del producto. Nunca inventes datos, precios, descuentos, fechas, teléfonos, direcciones ni links.
- La llamada a la acción no lleva datos inventados: "Escríbenos por WhatsApp", "Visítanos en cualquiera de nuestras sucursales", "Pregunta por el tuyo".
- Sin hashtags dentro del caption (van aparte).
- Respeta el largo máximo que se indica.

Formato del caption (muy importante: tiene que leerse de un vistazo en el celular, nunca un párrafo largo):
- Bloques de 1 o 2 líneas como máximo, separados por una línea en blanco (\n\n).
- Orden: 1) un gancho de una sola línea con un emoji; 2) el beneficio o uso en 1 o 2 líneas; 3) si hay datos concretos o usos claros, de 2 a 4 viñetas cortas, una por línea (\n), cada una empezando con un emoji relacionado (⚡ 💡 🔌 ✅ 🛠️ 💧 🏠 🏗️…); 4) la llamada a la acción sola en su línea, empezando con 👉, 📍 o 💬.
- Entre 3 y 6 emojis en total, relacionados con el producto o el uso; nunca dos o más seguidos, nunca en medio de una frase, nunca emojis genéricos de relleno.
- Para TikTok o X: solo el gancho, una línea de beneficio y la llamada a la acción, cada uno en su línea, con 2 o 3 emojis.

Hashtags (van aparte, en "hashtags"): de 12 a 15 sugerencias, de la más a la menos relevante, cada una con su "tipo":
- "marca": #JHElectroAlambres siempre primero.
- "producto": el producto y su categoría (ej. #PanelLED, #Breaker, #MaterialElectrico).
- "uso": el proyecto o uso (ej. #Remodelacion, #Construccion, #IluminacionLED).
- "local": #RepublicaDominicana, #RD y la ciudad que aplique (#SantoDomingo, #LaVega, #PuntaCana).
- "sector": #Ferreteria, #Electricistas, etc.
Formato de cada hashtag: empieza con #, sin espacios, sin tildes ni ñ, en PascalCase. Solo hashtags reales y usados, nada rebuscado.`;

const ESQUEMA = {
  type: 'json_schema', name: 'publicacion', strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['caption', 'hashtags'],
    properties: {
      caption: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tag', 'tipo'], properties: {
        tag: { type: 'string' }, tipo: { type: 'string', enum: ['marca', 'producto', 'uso', 'local', 'sector'] },
      } } },
    },
  },
};

const limpiarTag = (t) => {
  const s = String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w#]/g, '');
  const sin = s.replace(/^#+/, '');
  return sin.length >= 2 && sin.length <= 40 ? `#${sin}` : null;
};

/** Lo que se sabe del producto de una generacion (nombre, descripcion, ficha si vino de Camila). */
async function contexto(g) {
  const e = g.entrada || {};
  const mediaId = e.producto?.media_id || e.args?.product_media_id || null;
  let uso = null; let ficha = null;
  if (mediaId) {
    uso = (await pool.query('SELECT codigo, descripcion FROM camila_usos WHERE media_id = $1 ORDER BY id DESC LIMIT 1', [mediaId]).catch(() => ({ rows: [] }))).rows[0] || null;
    if (uso) ficha = (await pool.query('SELECT datos FROM camila_fichas WHERE codigo = $1', [uso.codigo]).catch(() => ({ rows: [] }))).rows[0]?.datos || null;
  }
  return {
    producto: uso?.descripcion || e.producto?.nombre || null,
    codigo: uso?.codigo || null,
    plantilla: g.preset_nombre || null,
    descripcion: String(e.args?.prompt || e.params?.prompt || '').slice(0, 1500) || null,
    ficha: ficha && !ficha.sinDatos ? { producto: ficha.producto, datos: ficha.datos, visibles: ficha.visibles } : null,
  };
}

/** El cuerpo de la llamada (exportado para las pruebas). */
function pedido({ imagenUrl, ctx, redes, tono, indicaciones, largo }) {
  const lineas = [
    `Redes donde se publica: ${redes.length ? redes.join(', ') : 'Instagram y Facebook'}.`,
    `Tono: ${TONOS[tono] || TONOS.cercano}`,
    `Largo máximo del caption: ${largo} caracteres.`,
    redes.some((r) => /tiktok|^x$/i.test(r)) ? 'Como va a TikTok o X: máximo 2 frases cortas más la llamada a la acción.' : '',
    ctx.producto ? `Producto: ${ctx.producto}${ctx.codigo ? ` (código ${ctx.codigo})` : ''}.` : 'Producto: identifícalo por la imagen, sin inventar marca ni modelo.',
    ctx.ficha ? `Datos de la ficha técnica: ${JSON.stringify(ctx.ficha)}` : 'No hay ficha técnica: no des datos técnicos que no se vean en la imagen.',
    ctx.descripcion ? `Así se describió la escena al crear la imagen o video (en inglés, solo como contexto): ${ctx.descripcion}` : '',
    indicaciones ? `Indicaciones del equipo (mandan sobre lo demás, salvo las reglas de no inventar): ${indicaciones}` : '',
  ].filter(Boolean);
  return {
    model: MODELO, instructions: INSTRUCCIONES, store: false, temperature: 0.7, max_output_tokens: 1200,
    input: [{ role: 'user', content: [
      ...(imagenUrl ? [{ type: 'input_image', image_url: imagenUrl, detail: 'low' }] : []),
      { type: 'input_text', text: lineas.join('\n') },
    ] }],
    text: { format: ESQUEMA },
  };
}

function leer(r, largo) {
  const txt = (r?.output || []).flatMap((o) => o.content || []).filter((b) => b.type === 'output_text').map((b) => b.text || '').join('');
  let d;
  try { d = JSON.parse(txt); } catch { throw new ErrorDeCaption('La IA devolvió el texto con un formato inesperado. Intenta de nuevo.', { detalle: txt.slice(0, 300) }); }
  const vistos = new Set();
  const hashtags = [];
  for (const h of d.hashtags || []) {
    const tag = limpiarTag(h.tag);
    if (!tag || vistos.has(tag.toLowerCase())) continue;
    vistos.add(tag.toLowerCase());
    hashtags.push({ tag, tipo: h.tipo });
  }
  const marca = hashtags.findIndex((h) => h.tag.toLowerCase() === '#jhelectroalambres');
  if (marca > 0) hashtags.unshift(...hashtags.splice(marca, 1));
  if (marca === -1) hashtags.unshift({ tag: '#JHElectroAlambres', tipo: 'marca' });
  // Respeta los saltos de linea del formato, sin espacios sueltos ni mas de una linea en blanco seguida.
  const caption = String(d.caption || '').replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { caption: caption.slice(0, largo), hashtags: hashtags.slice(0, 15) };
}

async function generar({ generacion, indice = 0, redes = [], tono = 'cercano', indicaciones = '', largo = 1200 }, { fetch: pedir = globalThis.fetch } = {}) {
  if (!API_KEY) throw new ErrorDeCaption('El generador de captions no está configurado.', { status: 503 });
  const ok = (generacion.resultados || []).filter((r) => r.url);
  const r = ok[Math.min(indice, ok.length - 1)];
  const esImagen = r && !/\.(mp4|mov|webm)($|\?)/i.test(r.url);
  const imagenUrl = (esImagen && (r.miniatura || r.url)) || generacion.portada?.url || generacion.entrada?.producto?.url || null;
  const ctx = await contexto(generacion);
  let resp;
  try {
    resp = await pedir(URL_OPENAI, {
      method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pedido({ imagenUrl: /^https:\/\//.test(imagenUrl || '') ? imagenUrl : null, ctx, redes, tono, indicaciones: String(indicaciones || '').slice(0, 500), largo })),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new ErrorDeCaption('La IA tardó demasiado. Intenta de nuevo.', { status: 503, detalle: e.message });
  }
  if (!resp.ok) throw new ErrorDeCaption('La IA no pudo escribir el texto. Intenta de nuevo en un momento.', { detalle: `HTTP ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 300)}` });
  const j = await resp.json();
  const out = leer(j, largo);
  console.log(`[captions] gen ${generacion.id} ${j.model || MODELO} ${j.usage?.input_tokens || 0}/${j.usage?.output_tokens || 0} tok · ficha ${ctx.ficha ? 'si' : 'no'}`);
  return { ...out, usoFicha: !!ctx.ficha, producto: ctx.producto, uso: { modelo: j.model || MODELO, entrada: j.usage?.input_tokens || 0, salida: j.usage?.output_tokens || 0 } };
}

module.exports = { generar, pedido, leer, contexto, limpiarTag, ErrorDeCaption, TONOS, INSTRUCCIONES };
