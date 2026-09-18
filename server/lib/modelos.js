/**
 * Generacion libre: catalogo de modelos de video e imagen del generador (se lee
 * con models_explore, cache 1 h) normalizado para el formulario del panel, y
 * armado de los params de generate_video / generate_image.
 */
const hf = require('./higgsfield');

// Utilidades y modelos que piden cosas que el formulario no maneja (videos de
// entrada, productos/estilos de otro flujo, sprites, upscalers...).
const FUERA = /upscale|background|outpaint|topaz|deflicker|remover|sam_3|clipify|sync_so|autosprite|preset|multiplier|^ms_image$|^marketing_studio_video$|hf_mult_|video_edit|kling_video_edit|soul_cast|nano_banana_2_shots/;
// Orden de aparicion: primero los mas usados; el resto va despues, por nombre.
const DESTACADOS = [
  'cinematic_studio_3_0', 'seedance_2_5', 'seedance_2_0', 'kling3_0', 'veo3_1', 'wan3_0', 'seedance_2_0_mini', 'minimax_h3', 'kling3_0_turbo', 'veo3_1_lite',
  'gpt_image_2_5', 'nano_banana_pro', 'cinematic_studio_2_5', 'nano_banana_2', 'seedream_v5_pro', 'marketing_studio_image', 'soul_2', 'flux_2', 'recraft_v4_1',
];
// Descripciones en espanol de los principales (el resto no muestra descripcion:
// la del proveedor viene en ingles y a veces lo nombra).
const DESCRIPCIONES = {
  cinematic_studio_3_0: 'El más avanzado: calidad de cine, hasta 4K y 15 s.',
  seedance_2_5: 'Uso general, hasta 30 s y 1080p, con audio; acepta imagen de referencia.',
  seedance_2_0: 'Consistente con la imagen de referencia; ideal para producto. Hasta 4K.',
  seedance_2_0_mini: 'Versión rápida y económica de Seedance 2.0.',
  kling3_0: 'Movimiento cinematográfico con audio sincronizado.',
  kling3_0_turbo: 'Rápido y económico.',
  veo3_1: 'Ultra realista, calidad de cine.',
  veo3_1_lite: 'Rápido y económico.',
  wan3_0: 'Hasta 30 s con audio; primer y último cuadro.',
  minimax_h3: 'Video 2K con cuadros clave o referencias.',
  gpt_image_2_5: 'Imagen de uso general: fotorealismo, texto y edición con referencia.',
  nano_banana_pro: 'Máxima calidad, buen texto y diagramas, hasta 4K.',
  nano_banana_2: 'Rápido y de alta calidad, hasta 4K.',
  cinematic_studio_2_5: 'Fotos de estilo cine, hasta 4K.',
  seedream_v5_pro: 'Edición por instrucciones, hasta 2K.',
  marketing_studio_image: 'Imágenes de anuncio para producto.',
  soul_2: 'Personas y estilo editorial realista.',
  flux_2: 'Muy fiel al prompt.',
  recraft_v4_1: 'Ilustración, logos, íconos y mockups de producto.',
  z_image: 'Muy rápido y económico.',
};
const sinMarca = (t) => String(t || '').replace(/higgsfield\s*/gi, '').trim();

// Nombres limpios y parejos ("Marca Modelo Version"), familia para agrupar en el selector
// y alias que el catalogo repite con otro id (se ocultan para no mostrar dos veces lo mismo).
const NOMBRES = {
  cinematic_studio_3_0: ['Cinema Studio 3.0', 'Cinema Studio'], cinematic_studio_video_v2: ['Cinema Studio 2.0', 'Cinema Studio'],
  cinematic_studio_video: ['Cinema Studio 1.0', 'Cinema Studio'],
  seedance_2_5: ['Seedance 2.5', 'Seedance'], seedance_2_0: ['Seedance 2.0', 'Seedance'], seedance_2_0_mini: ['Seedance 2.0 Mini', 'Seedance'],
  seedance1_5: ['Seedance 1.5 Pro', 'Seedance'],
  kling3_0: ['Kling 3.0', 'Kling'], kling3_0_turbo: ['Kling 3.0 Turbo', 'Kling'], kling2_6: ['Kling 2.6', 'Kling'],
  veo3_1: ['Veo 3.1', 'Veo (Google)'], veo3_1_lite: ['Veo 3.1 Lite', 'Veo (Google)'], veo3: ['Veo 3', 'Veo (Google)'],
  wan3_0_prime: ['Wan 3.0 Prime', 'Wan'], wan3_0: ['Wan 3.0', 'Wan'], wan2_7: ['Wan 2.7', 'Wan'], wan2_6: ['Wan 2.6', 'Wan'],
  minimax_h3_max: ['MiniMax H3 Max', 'MiniMax'], minimax_h3: ['MiniMax H3', 'MiniMax'], minimax_hailuo: ['MiniMax Hailuo', 'MiniMax'],
  gemini_omni_flash_1_1: ['Gemini Omni Flash 1.1', 'Gemini (Google)'], gemini_omni: ['Gemini Omni Flash 1.0', 'Gemini (Google)'],
  grok_video_v15: ['Grok Video 1.5', 'Grok (xAI)'], grok_video: ['Grok Video 1.0', 'Grok (xAI)'],
  flux_3_video: ['FLUX 3 Video', 'FLUX'], happy_horse_video: ['Happy Horse', 'Otros'],
  gpt_image_2_5: ['GPT Image 2.5', 'GPT Image (OpenAI)'], gpt_image_2: ['GPT Image 2.0', 'GPT Image (OpenAI)'], openai_hazel: ['OpenAI Hazel', 'GPT Image (OpenAI)'],
  nano_banana_pro: ['Nano Banana Pro', 'Nano Banana (Google)'], nano_banana_2: ['Nano Banana 2', 'Nano Banana (Google)'],
  nano_banana_2_lite: ['Nano Banana 2 Lite', 'Nano Banana (Google)'], nano_banana: ['Nano Banana', 'Nano Banana (Google)'],
  cinematic_studio_2_5: ['Cinema Studio Image 2.5', 'Cinema Studio'], marketing_studio_image: ['Marketing Studio Image', 'Marketing Studio'],
  seedream_v5_pro: ['Seedream 5.0 Pro', 'Seedream'], seedream_v5_lite: ['Seedream 5.0 Lite', 'Seedream'], seedream_v4_5: ['Seedream 4.5', 'Seedream'],
  soul_2: ['Soul 2.0', 'Soul'], soul_cinematic: ['Soul Cinema', 'Soul'], soul_location: ['Soul Location (escenarios)', 'Soul'],
  flux_2: ['FLUX.2', 'FLUX'], flux_kontext: ['FLUX Kontext', 'FLUX'], recraft_v4_1: ['Recraft 4.1', 'Otros'],
  grok_image_2_0: ['Grok Image 2.0', 'Grok (xAI)'], grok_image: ['Grok Image 1.0', 'Grok (xAI)'],
  kling_omni_image: ['Kling O1 Image', 'Kling'], z_image: ['Z Image', 'Otros'], image_auto: ['Automático (elige el mejor)', 'Automático'],
};
const ALIAS = new Set(['soul_v2']); // mismo modelo que soul_2

// Parametros que se muestran (el resto se deja con el valor por defecto del modelo).
const PARAMS = {
  resolution: 'Resolución', quality: 'Calidad', mode: 'Modo', variant: 'Variante',
  generate_audio: 'Audio', sound: 'Audio', slow_motion: 'Cámara lenta', speedramp: 'Velocidad',
  bitrate_mode: 'Bitrate', enable_thinking: 'Razonamiento', thinking: 'Razonamiento', model_type: 'Tipo',
  background: 'Fondo', remove_bg: 'Quitar fondo',
};
// Modos que decide el panel segun haya imagen o no (no se muestran).
const MODOS_AUTO = ['t2v', 'omni_reference', 'text-to-video', 'image-to-video', 'reference-to-video'];
const ROLES_IMAGEN = ['start_image', 'image', 'image_references'];

function normalizar(m) {
  const roles = (m.medias || []).flatMap((x) => x.roles || []);
  const rolImagen = ROLES_IMAGEN.find((r) => roles.includes(r)) || null;
  const pideImagen = (m.medias || []).some((x) => x.required);
  const params = [];
  let modoAuto = false;
  let duracion = m.durations ? { opciones: m.durations } : m.duration_range ? { min: m.duration_range.min, max: m.duration_range.max } : null;
  for (const p of m.parameters || []) {
    if (p.name === 'duration') {
      duracion = p.options ? { opciones: p.options, def: p.default } : { min: Math.max(1, p.min ?? 1), max: p.max, def: p.default };
      continue;
    }
    if (p.name === 'mode' && (p.options || []).some((o) => MODOS_AUTO.includes(o))) { modoAuto = true; continue; }
    if (!PARAMS[p.name]) continue;
    if (p.type === 'bool') params.push({ nombre: p.name, etiqueta: PARAMS[p.name], tipo: 'bool', def: p.default ?? false });
    else if (p.options?.length) params.push({ nombre: p.name, etiqueta: PARAMS[p.name], tipo: 'opciones', opciones: p.options, def: p.default ?? p.options[0] });
  }
  return {
    id: m.id, nombre: NOMBRES[m.id]?.[0] || sinMarca(m.name) || m.id,
    familia: NOMBRES[m.id]?.[1] || sinMarca(m.provider_name) || 'Otros',
    proveedor: /higgsfield/i.test(m.provider_name || '') ? '' : m.provider_name || '',
    descripcion: DESCRIPCIONES[m.id] || '',
    tipo: m.output_type === 'video' ? 'video' : 'imagen',
    aspectos: (m.aspect_ratios || []).filter((a) => a !== 'auto'),
    duracion, params, rolImagen, aceptaImagen: !!rolImagen, pideImagen, modoAuto,
  };
}

let _cache = null;
async function lista() {
  if (_cache && _cache.exp > Date.now()) return _cache.v;
  const [v, i] = await Promise.all([
    hf.llamar('models_explore', { action: 'list', type: 'video', limit: 100 }),
    hf.llamar('models_explore', { action: 'list', type: 'image', limit: 100 }),
  ]);
  const todos = [...(v.items || []), ...(i.items || [])]
    .filter((m) => m.id && !FUERA.test(m.id) && !ALIAS.has(m.id) && !(m.parameters || []).some((p) => p.required === 'required' && p.name !== 'mode'))
    .map(normalizar)
    .filter((m) => m.aceptaImagen || !(m.pideImagen)); // descarta los que exigen un tipo de entrada que no manejamos
  // Red de seguridad: si el catalogo trae dos modelos con el mismo nombre, se distinguen por su id.
  const vistos = new Map();
  for (const m of todos) {
    const k = m.tipo + '|' + m.nombre.toLowerCase();
    if (vistos.has(k)) m.nombre = `${m.nombre} (${m.id})`;
    vistos.set(k, true);
  }
  // Orden: familias por su mejor modelo (destacados primero) y dentro, por destacado y version.
  const pos = (id) => (DESTACADOS.includes(id) ? DESTACADOS.indexOf(id) : 1000);
  const mejorDe = {};
  for (const m of todos) mejorDe[m.tipo + m.familia] = Math.min(mejorDe[m.tipo + m.familia] ?? 1e9, pos(m.id));
  todos.sort((a, b) => mejorDe[a.tipo + a.familia] - mejorDe[b.tipo + b.familia] || a.familia.localeCompare(b.familia)
    || pos(a.id) - pos(b.id) || b.nombre.localeCompare(a.nombre, 'es', { numeric: true }));
  _cache = { v: todos, exp: Date.now() + 60 * 60e3 };
  return todos;
}

async function obtener(id) { return (await lista()).find((m) => m.id === id) || null; }

// Arma { tool, params } para el generador a partir de lo elegido en el formulario.
// Solo pasa parametros que el modelo declara; la imagen va con el rol del modelo.
function armar(modelo, { prompt, aspecto, duracion, opciones = {}, mediaId }) {
  const params = { model: modelo.id, prompt, use_unlim: false };
  if (aspecto && modelo.aspectos.includes(aspecto)) params.aspect_ratio = aspecto;
  if (modelo.tipo === 'video' && modelo.duracion && Number(duracion)) {
    const d = Math.round(Number(duracion));
    const ok = modelo.duracion.opciones ? modelo.duracion.opciones.includes(d) : d >= modelo.duracion.min && d <= modelo.duracion.max;
    if (ok) params.duration = d;
  }
  for (const p of modelo.params) {
    if (!(p.nombre in opciones)) continue;
    const val = opciones[p.nombre];
    if (p.tipo === 'bool') params[p.nombre] = !!val;
    else if (p.opciones.includes(val)) params[p.nombre] = val;
  }
  if (mediaId && modelo.rolImagen) params.medias = [{ value: mediaId, role: modelo.rolImagen }];
  if (modelo.modoAuto) {
    // seedance 2.5: t2v / omni_reference; gemini omni 1.1: text-to-video / image-to-video
    params.mode = modelo.id.startsWith('gemini_omni') ? (mediaId ? 'image-to-video' : 'text-to-video') : (mediaId ? 'omni_reference' : 't2v');
  }
  return { tool: modelo.tipo === 'video' ? 'generate_video' : 'generate_image', params };
}

// Llama a generate_video / generate_image. El generador a veces no genera ni cotiza:
// devuelve un "notice" pensado para un chat (p. ej. "este prompt se parece al preset X,
// preguntale al usuario"). Aca el usuario ya eligio generar su prompt tal cual, asi
// que se declina la recomendacion (declined_preset_id) y se repite, hasta 3 veces.
async function llamarGenerador(tool, params) {
  let p = { ...params, use_unlim: false };
  for (let i = 0; i < 3; i++) {
    const d = await hf.llamar(tool, { params: p }, { timeoutMs: 120000 });
    const n = d?.notice;
    if (!n) return d;
    // El propio aviso trae como seguir literal: retry_literal_with.declined_preset_id.
    const presetId = n.data?.retry_literal_with?.declined_preset_id || n.data?.preset?.id;
    if (n.type === 'preset_recommendation' && presetId && presetId !== p.declined_preset_id) {
      console.log(`[generador] se declina el preset sugerido ${presetId} (${n.data?.preset?.name || ''})`);
      p = { ...p, declined_preset_id: presetId };
      continue;
    }
    throw new hf.HiggsfieldError(`${tool}: aviso sin resolver ${n.type}: ${String(n.message || '').slice(0, 300)}`);
  }
  throw new hf.HiggsfieldError(`${tool}: el generador insiste con recomendaciones de preset`);
}

async function costo(armado) {
  const d = await llamarGenerador(armado.tool, { ...armado.params, get_cost: true });
  const c = d?.cost?.credits_exact ?? d?.cost?.credits;
  if (c == null) throw new hf.HiggsfieldError('get_cost sin costo: ' + JSON.stringify(d).slice(0, 600));
  return Number(c);
}

module.exports = { lista, obtener, armar, costo, normalizar, llamarGenerador };
