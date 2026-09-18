/**
 * Clasificacion automatica de plantillas nuevas: la IA mira la portada y
 * devuelve lo mismo que tiene shared/clasificacion.json (producto del ejemplo,
 * estilos, si hay persona y el encaje con JH de 0 a 10), con los mismos
 * criterios con los que se clasificaron las 986 originales. Lo corre el worker.
 */
const { pool } = require('./db');

const API_KEY = process.env.OPENAI_API_KEY || '';
const MODELO = process.env.MODELO_CLASIFICAR || 'gpt-4.1';
const PRODUCTOS = ['electrico_industrial', 'iluminacion', 'agua_piscina', 'tecnologia', 'herramientas', 'hogar', 'belleza', 'bebidas_alimentos', 'moda', 'salud', 'otros'];
const ESTILOS = ['estudio', 'lifestyle', 'exterior', 'industrial', 'tecnico', 'minimalista', 'colorido', 'oscuro_lujo', 'agua_efectos', 'editorial'];

const INSTRUCCIONES = `You classify a marketing ad TEMPLATE (its example cover image) so a hardware distributor can find the ones that suit its products.

The client (JH Electro Alambres, Dominican Republic) sells: electrical material (wire/cable reels, breakers, outlets, switches, electrical boxes, conduit), industrial controls (contactors, capacitors, timers, motor protection), LED lighting (bulbs, panels, reflectors, lamps, LED strips), hardware/tools (drills, bits, screws, tape), pool & spa (pumps, pool lights, chemicals, filters), plumbing (PVC pipe, valves, faucets, water pumps, heaters), security cameras, fittings. Their product photos are rigid technical objects shot on white background.

Return:
- "p": the product type the template's example product is / best fits. Use "otros" for abstract, text-only, app/SaaS/UI, or unclear.
- "e": 1 to 3 style tags: estudio (clean studio / plain or colored seamless background), lifestyle (real home/everyday setting), exterior (outdoor, nature, street), industrial (workshop, construction site, factory, technical environment), tecnico (callouts, labels, exploded/spec/infographic look), minimalista, colorido (bold/pop/vibrant), oscuro_lujo (dark, premium, dramatic lighting), agua_efectos (splash, liquid, ice, water), editorial (magazine/fashion editorial, poster/typographic).
- "per": true if a person (or body part like hands holding the product) is prominent.
- "jh": integer 0-10, how well this template would work if the example product were replaced by a JH product (a breaker, a cable reel, an LED bulb/panel, a pool pump, a PVC valve, a drill). High (8-10): neutral/technical/studio/industrial/dramatic-object compositions where any rigid object fits, tech callouts, product hero shots on clean backgrounds, construction/workshop/home-installation scenes, water scenes for pumps/pool items, light scenes for lamps. Medium (4-7): generic lifestyle/hand-held shots that could work but feel consumer-y. Low (0-3): templates built around food/drink consumption, applying cosmetics to skin/face, wearing clothes/jewelry, pouring liquids into mouth, very feminine beauty or fashion framing, food styling.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    p: { type: 'string', enum: PRODUCTOS },
    e: { type: 'array', items: { type: 'string', enum: ESTILOS }, minItems: 1, maxItems: 3 },
    per: { type: 'boolean' },
    jh: { type: 'integer', minimum: 0, maximum: 10 },
  },
  required: ['p', 'e', 'per', 'jh'],
  additionalProperties: false,
};

const configurado = () => !!API_KEY;

// La portada como imagen (de un video, su poster).
function imagenDe(p) {
  const c = p.cover_image || {};
  const u = c.type === 'video' || /\.mp4($|\?)/i.test(c.url || '') ? c.poster_url : c.url;
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
}

async function clasificarUna(p, { fetch: pedir = globalThis.fetch } = {}) {
  const img = imagenDe(p);
  if (!img) throw new Error('sin imagen de portada');
  const r = await pedir('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELO, instructions: INSTRUCCIONES, max_output_tokens: 300,
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: img, detail: 'low' }, { type: 'input_text', text: `Template name: "${p.name}". Type: ${p.type}. Classify it.` }] }],
      text: { format: { type: 'json_schema', name: 'clasificacion', strict: true, schema: ESQUEMA } },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('OpenAI HTTP ' + r.status);
  const j = await r.json();
  const texto = (j.output || []).flatMap((i) => i.content || []).filter((b) => b.type === 'output_text').map((b) => b.text).join('');
  const d = JSON.parse(texto);
  if (!PRODUCTOS.includes(d.p) || !Array.isArray(d.e) || !d.e.every((x) => ESTILOS.includes(x))) throw new Error('clasificacion invalida');
  return { p: d.p, e: [...new Set(d.e)].slice(0, 3), per: !!d.per, jh: Math.max(0, Math.min(10, Math.round(d.jh))) };
}

// Clasifica hasta `max` plantillas del catalogo que no tengan clasificacion. Devuelve cuantas.
async function clasificarNuevas(items, { max = 25, fetch } = {}) {
  if (!API_KEY) return { hechas: 0, pendientes: 0, sinClave: true };
  const nuevas = items.filter((p) => !p._clasif);
  let hechas = 0;
  for (const p of nuevas.slice(0, max)) {
    try {
      const c = await clasificarUna(p, { fetch });
      await pool.query(
        `INSERT INTO plantillas_clasif (id, p, e, per, jh, nombre, fuente) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [p.id, c.p, JSON.stringify(c.e), c.per, c.jh, p.name || null, MODELO]
      );
      hechas++;
    } catch (e) {
      console.log(`[clasificar] ${p.id} (${p.name}): ${e.message}`);
    }
  }
  return { hechas, pendientes: Math.max(0, nuevas.length - hechas) };
}

module.exports = { clasificarNuevas, clasificarUna, imagenDe, configurado, INSTRUCCIONES };
