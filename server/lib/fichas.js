/**
 * Datos de la ficha tecnica de un producto de JH para la descripcion de una foto o video.
 *
 * La ficha es el PDF del bucket de fichas (archivo = codigo, lib/jh-catalogo.js). La IA la lee
 * directo desde su URL publica y devuelve solo lo que sirve para que el resultado sea fiel al
 * producto (identidad, lo que se ve y los 2-3 datos que vale la pena destacar). Cada ficha se
 * lee una sola vez: el resultado queda en la tabla camila_fichas.
 */
const { pool } = require('./db');
const catalogo = require('./jh-catalogo');

const API_KEY = process.env.OPENAI_API_KEY || '';
const URL_OPENAI = 'https://api.openai.com/v1/responses';
const MODELO = process.env.FICHAS_MODELO || 'gpt-4.1-mini';
const TIEMPO_MAX_MS = 90000;

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS camila_fichas (
     codigo TEXT PRIMARY KEY,
     archivo TEXT NOT NULL,
     datos JSONB NOT NULL,
     modelo TEXT,
     tokens_entrada INT,
     tokens_salida INT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];
let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

class ErrorDeFicha extends Error {
  constructor(mensaje, { status = 502, detalle = null } = {}) { super(mensaje); this.status = status; this.detalle = detalle; }
}

const INSTRUCCIONES = `Lees la ficha técnica (PDF) de un producto de JH Electro Alambres (material eléctrico, plomería, iluminación, ferretería). El equipo de marketing va a crear una foto o un video con IA a partir de la foto del producto, y necesita los datos de la ficha que ayudan a que el resultado sea fiel.

Extrae SOLO lo que está escrito en la ficha. Nunca inventes ni completes con conocimiento general. Si algo no aparece, no lo pongas.

Qué sirve (en este orden de prioridad):
1. Identidad: qué producto es, marca, modelo o referencia.
2. Lo que se ve: medidas, forma, colores, material, acabado, número de polos, entradas o conexiones, piezas incluidas, textos o marcas impresas en el producto.
3. Datos para destacar: los 2 o 3 que un cliente valoraría (amperaje, voltaje, potencia en W, lúmenes, temperatura de color en K, grado IP, certificaciones como UL, duración, capacidad).
4. Uso típico en una frase, si la ficha lo dice (dónde se instala o para qué sirve).

Qué NO sirve: tablas largas de normas, instrucciones de instalación paso a paso, advertencias legales, garantías, datos del fabricante (dirección, teléfono), códigos internos de empaque.

Devuelve:
- "producto": nombre corto del producto como lo diría un vendedor (ej. "Breaker de 1 polo 20 A ABB THQP120").
- "datos": de 3 a 10 pares { "dato", "valor" }, en español, con unidades (ej. { "dato": "Corriente", "valor": "20 A" }).
- "visibles": de 0 a 5 rasgos que se VEN en el producto y conviene respetar (ej. "palanca negra", "etiqueta blanca con el modelo impreso").
- "texto": de 2 a 4 frases en español para añadir a la descripción: describe físicamente el producto y menciona los datos para destacar. Sin adjetivos de relleno ni precios.
- "sin_datos": true solo si el PDF no es una ficha técnica o no trae nada útil.`;

const ESQUEMA = {
  type: 'json_schema', name: 'ficha_tecnica', strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['producto', 'datos', 'visibles', 'texto', 'sin_datos'],
    properties: {
      producto: { type: 'string' },
      datos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['dato', 'valor'], properties: { dato: { type: 'string' }, valor: { type: 'string' } } } },
      visibles: { type: 'array', items: { type: 'string' } },
      texto: { type: 'string' },
      sin_datos: { type: 'boolean' },
    },
  },
};

/** El cuerpo de la llamada (exportado para las pruebas). */
function pedido(urlFicha) {
  return {
    model: MODELO, instructions: INSTRUCCIONES, store: false, temperature: 0.1, max_output_tokens: 1500,
    input: [{ role: 'user', content: [
      { type: 'input_file', file_url: urlFicha },
      { type: 'input_text', text: 'Extrae los datos de esta ficha técnica.' },
    ] }],
    text: { format: ESQUEMA },
  };
}

function leer(r) {
  const txt = (r?.output || []).flatMap((o) => o.content || []).filter((b) => b.type === 'output_text').map((b) => b.text || '').join('');
  let d;
  try { d = JSON.parse(txt); } catch { throw new ErrorDeFicha('No se pudo leer la ficha. Intenta de nuevo.', { detalle: txt.slice(0, 300) }); }
  const limpio = (s, n) => String(s || '').trim().slice(0, n);
  return {
    producto: limpio(d.producto, 160),
    datos: (d.datos || []).map((x) => ({ dato: limpio(x.dato, 60), valor: limpio(x.valor, 120) })).filter((x) => x.dato && x.valor).slice(0, 10),
    visibles: (d.visibles || []).map((x) => limpio(x, 120)).filter(Boolean).slice(0, 5),
    texto: limpio(d.texto, 900),
    sinDatos: !!d.sin_datos,
  };
}

/**
 * Datos de la ficha de un codigo. Devuelve { sinFicha: true } si el producto no tiene ficha;
 * si no, { producto, datos, visibles, texto, sinDatos, guardada }.
 */
async function extraer(codigo, { fetch: pedir = globalThis.fetch } = {}) {
  await migrar();
  const { rows: [g] } = await pool.query('SELECT datos FROM camila_fichas WHERE codigo = $1', [codigo]);
  if (g) return { ...g.datos, guardada: true };
  const { ficha } = await catalogo.archivosDe(codigo, { relistar: true });
  if (!ficha) return { sinFicha: true };
  if (!API_KEY) throw new ErrorDeFicha('La lectura de fichas no está configurada. Avísale al administrador.', { status: 503 });
  let r;
  try {
    r = await pedir(URL_OPENAI, {
      method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pedido(ficha)), signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
  } catch (e) {
    throw new ErrorDeFicha('La lectura de la ficha tardó demasiado. Intenta de nuevo.', { status: 503, detalle: e.message });
  }
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 300);
    throw new ErrorDeFicha(r.status === 400 ? 'No se pudo abrir el PDF de la ficha.' : 'La IA no pudo leer la ficha. Intenta de nuevo en un momento.', { status: 502, detalle: `HTTP ${r.status} ${detalle}` });
  }
  const j = await r.json();
  let datos;
  try { datos = leer(j); } catch (e) { e.uso = { modelo: j.model || MODELO, entrada: j.usage?.input_tokens || 0, salida: j.usage?.output_tokens || 0 }; throw e; }
  await pool.query(
    `INSERT INTO camila_fichas (codigo, archivo, datos, modelo, tokens_entrada, tokens_salida) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (codigo) DO NOTHING`,
    [codigo, ficha, JSON.stringify(datos), j.model || MODELO, j.usage?.input_tokens || null, j.usage?.output_tokens || null]
  );
  console.log(`[fichas] ${codigo} ${j.model || MODELO} ${j.usage?.input_tokens || 0}/${j.usage?.output_tokens || 0} tok · ${datos.datos.length} datos`);
  return { ...datos, guardada: false, uso: { modelo: j.model || MODELO, entrada: j.usage?.input_tokens || 0, salida: j.usage?.output_tokens || 0 } };
}

module.exports = { extraer, migrar, pedido, leer, ErrorDeFicha, INSTRUCCIONES };
