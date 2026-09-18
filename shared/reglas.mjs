// Reglas de Marketing Studio v2, portadas del widget oficial de Higgsfield
// (ui://higgsfield/marketing-studio-v2.html). Las usa el navegador para armar
// el formulario y el servidor para validar antes de gastar creditos.

export const TIPOS = {
  product_shots: 'Foto de producto',
  product_shots_people: 'Foto de producto con modelo',
  '2d_motion': 'Animación de producto',
  hypermotion: 'Animación de producto',
  mixed_media: 'Animación de producto',
  saas_motion: 'Animación de producto',
  ugc: 'Video UGC',
  poster: 'Póster',
  ads: 'Anuncio',
  marketplace: 'Marketplace',
  libre_video: 'Video desde cero',
  libre_imagen: 'Foto desde cero',
};

export const CATEGORIAS_ES = {
  all: 'Todas', ugc: 'UGC', 'product-shot': 'Fotos de producto', motion: 'Animación',
  ads: 'Anuncios', posters: 'Pósters', marketplace: 'Marketplace',
};

export const TIPOS_VIDEO = new Set(['ugc', '2d_motion', 'hypermotion', 'mixed_media', 'saas_motion']);

const slug = (s) => (s || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
const CON_PERSONA = new Set(['people', 'with-model', 'closeup', 'close-up', 'fullbody', 'full-body', 'editorial', 'ugc']);

function requeridos(req) {
  const lista = Array.isArray(req) ? req
    : req && typeof req === 'object'
      ? Object.entries(req).flatMap(([k, v]) => (v === true || (v && typeof v === 'object' && v.required === true) ? [k] : []))
      : [];
  return new Set(lista.filter((x) => typeof x === 'string').map((x) => x.toLowerCase().replaceAll('-', '_')));
}

function atributosDe(set) {
  return new Set([...set].flatMap((e) => (e.includes('avatar') || e.includes('character') ? ['avatar']
    : e.includes('product') || e.includes('image') || e.includes('reference') ? ['product'] : [])));
}

const coincideTipo = (formato, tipo) => formato.type === tipo || (tipo === 'ugc' && formato.type === 'ugc_v2');

// Formato del preset dentro de la categoria elegida (o el primero que traiga).
export function formatoDe(preset, categorias, categoriaSlug) {
  const cat = categorias.find((c) => c.slug === categoriaSlug);
  const validos = new Set((cat?.formats || []).filter((f) => coincideTipo(f, preset.type)).map((f) => f.slug));
  const formatSlug = (preset.format_slugs || []).find((s) => validos.has(s)) ?? (preset.format_slugs || [])[0];
  if (!formatSlug) return { formatSlug: undefined, formato: undefined };
  const orden = [...categorias.filter((c) => c.slug === categoriaSlug), ...categorias];
  for (const c of orden) {
    const f = (c.formats || []).find((x) => x.slug === formatSlug && coincideTipo(x, preset.type));
    if (f) return { formatSlug, formato: f };
  }
  return { formatSlug, formato: undefined };
}

// Que pide el formulario para este preset (misma logica que el widget: Ry()).
export function entradasDe(preset, { formatSlug, formato } = {}) {
  const req = requeridos(preset.required_inputs ?? formato?.fixed_params?.required_inputs);
  const r = (attrs, obligatorios, extra = {}) => ({
    producto: attrs.has('product'), productoObligatorio: obligatorios.has('product'),
    avatar: attrs.has('avatar'), avatarObligatorio: obligatorios.has('avatar'),
    promptObligatorio: extra.promptObligatorio ?? false,
    aceptaUrl: extra.aceptaUrl ?? false, urlObligatoria: extra.urlObligatoria ?? false,
  });
  const conPersona = [formatSlug, formato?.name, preset.name, preset.group_name].map(slug).some((s) => CON_PERSONA.has(s));
  if (preset.type === 'ugc' || preset.type === 'product_shots_people' || (preset.type === 'product_shots' && conPersona)) {
    return r(new Set(['product', 'avatar']), new Set(['product']));
  }
  if (preset.type === 'ads' || preset.type === 'marketplace') return r(new Set(['product']), new Set(['product']));
  const deReq = atributosDe(req);
  const hayReq = req.size > 0;
  const attrs = new Set(hayReq ? deReq : ['product']);
  if (preset.type === 'saas_motion') attrs.add('product');
  const conProducto = ['product_shots', 'product_shots_people', '2d_motion', 'hypermotion', 'mixed_media'].includes(preset.type);
  const obligatorios = hayReq ? new Set(deReq) : new Set(conProducto ? ['product'] : []);
  if (preset.type === 'saas_motion') obligatorios.add('product');
  return r(attrs, obligatorios, {
    promptObligatorio: req.has('prompt'),
    aceptaUrl: preset.type === 'saas_motion',
    urlObligatoria: preset.type === 'saas_motion' && (req.has('brand_url') || req.has('website_url')),
  });
}

// Errores de validacion en espanol (vacio = listo para enviar).
export function faltantes(e, { producto, avatar, prompt, url }) {
  const out = [];
  if (e.productoObligatorio && !producto) out.push('Sube la foto de tu producto.');
  if (e.avatarObligatorio && !avatar) out.push('Elige la persona que aparece.');
  if (e.promptObligatorio && !(prompt || '').trim()) out.push('Escribe lo que quieres.');
  if (e.aceptaUrl && e.urlObligatoria && !(url || '').trim()) out.push('Esta plantilla necesita la URL de la marca.');
  if (e.aceptaUrl && (url || '').trim() && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(url.trim())) out.push('La URL de la marca debe empezar con https://');
  return out;
}

// Creditos estimados (qy() del widget). Para video usa la duracion de la portada.
export function creditosDe(tipo, costos, duracionSeg) {
  if (!costos) return null;
  const flujo = tipo === 'ugc' ? 'ugc_v2' : tipo;
  const elegir = (xs) => xs.find((x) => x.scenario === 'selected_style') ?? xs.find((x) => x.scenario === 'general_or_v2_style') ?? xs[0];
  const img = (costos.image || []).filter((x) => x.flow === flujo);
  if (img.length) return elegir(img)?.credits ?? null;
  let vid = (costos.video || []).filter((x) => x.flow === flujo);
  if (flujo === 'ugc_v2') {
    const hd = vid.filter((x) => x.selector?.resolution === '720p');
    if (hd.length) vid = hd;
  }
  const s = elegir(vid);
  if (!s) return null;
  if (s.credits_per_second <= 0) return s.fixed_credits;
  if (!Number.isFinite(duracionSeg) || duracionSeg <= 0) return null;
  return Math.round(s.fixed_credits + s.credits_per_second * Math.round(duracionSeg));
}
