/**
 * Catalogo completo de plantillas con la clasificacion para JH: se baja entero
 * del generador (paginas de 100, cache 30 min), se le pega shared/clasificacion.json
 * y se sirve filtrado y ordenado (primero lo que mejor encaja con los productos
 * de JH). Plantillas nuevas sin clasificar quedan con encaje medio y al final
 * de su nivel.
 */
const fs = require('fs');
const path = require('path');
const hf = require('./higgsfield');

const filtrosP = import('../../shared/filtros.mjs');

const CLASIF = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'clasificacion.json'), 'utf8')); } catch { return {}; }
})();

// Tipo de plantilla -> categoria del catalogo (igual que las pestañas del generador).
const CATEGORIA_DE_TIPO = {
  ugc: 'ugc', ugc_v2: 'ugc', product_shots: 'product-shot', product_shots_people: 'product-shot',
  '2d_motion': 'motion', hypermotion: 'motion', mixed_media: 'motion', saas_motion: 'motion',
  ads: 'ads', poster: 'posters', marketplace: 'marketplace',
};
const VIDEO = new Set(['ugc', 'ugc_v2', '2d_motion', 'hypermotion', 'mixed_media', 'saas_motion']);
const CON_PERSONA = new Set(['ugc', 'ugc_v2', 'product_shots_people']);

function orientacion(c) {
  const w = Number(c?.width), h = Number(c?.height);
  if (!w || !h) return null;
  return h / w > 1.15 ? 'vertical' : w / h > 1.15 ? 'horizontal' : 'cuadrada';
}

function enriquecer(p, i) {
  const c = CLASIF[p.id];
  return {
    ...p,
    _i: i,
    _cat: CATEGORIA_DE_TIPO[p.type] || 'otros',
    _medio: VIDEO.has(p.type) ? 'video' : 'foto',
    _orient: orientacion(p.cover_image),
    _prod: c?.p || 'otros',
    _estilos: c?.e || [],
    _persona: c ? !!c.per : CON_PERSONA.has(p.type),
    _jh: c ? Number(c.jh) : 5,
    _clasif: !!c,
    _sirve: [],
  };
}

let _cache = null;
async function todas() {
  if (_cache && _cache.exp > Date.now()) return _cache.items;
  const items = [];
  const vistos = new Set();
  let cursor = null;
  for (let pag = 0; pag < 40; pag++) {
    const d = await hf.llamar('marketing_studio_v2_presets', { category: 'all', size: 100, ...(cursor ? { cursor } : {}) });
    const p = d.presets || {};
    for (const x of p.items || []) if (!vistos.has(x.id)) { vistos.add(x.id); items.push(enriquecer(x, items.length)); }
    cursor = p.cursor ?? null;
    if (!cursor) break;
  }
  const { sirvePara } = await filtrosP;
  for (const x of items) x._sirve = sirvePara(x._estilos, x._jh);
  _cache = { items, exp: Date.now() + 30 * 60e3 };
  return items;
}

const lista = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Filtros: categoria, formato, sirve (familias JH), producto(s), estilo(s) (todas deben estar), persona si|no,
// medio foto|video, orientacion, q (texto), orden jh|original.
function filtrar(items, f) {
  const productos = new Set(lista(f.producto));
  const sirve = lista(f.sirve);
  const estilos = lista(f.estilo);
  const q = String(f.q || '').trim().toLowerCase();
  return items.filter((p) => (!f.categoria || f.categoria === 'all' || p._cat === f.categoria)
    && (!f.formato || (p.format_slugs || []).includes(f.formato))
    && (!productos.size || productos.has(p._prod))
    && (!sirve.length || sirve.some((k) => p._sirve.includes(k)))
    && estilos.every((e) => p._estilos.includes(e))
    && (!f.persona || (f.persona === 'si') === p._persona)
    && (!f.medio || p._medio === f.medio)
    && (!f.orientacion || p._orient === f.orientacion)
    && (!q || (p.name || '').toLowerCase().includes(q)));
}

function ordenar(items, orden) {
  if (orden === 'original') return [...items].sort((a, b) => a._i - b._i);
  // Recomendadas para JH primero; a igual encaje, las clasificadas antes que las nuevas y luego el orden original.
  return [...items].sort((a, b) => b._jh - a._jh || Number(b._clasif) - Number(a._clasif) || a._i - b._i);
}

// Conteos por producto y estilo con el resto de filtros aplicados (para los chips).
function facetas(items, f) {
  const base = filtrar(items, { ...f, producto: '', estilo: '', sirve: '' });
  const prod = {}; const est = {}; const sir = {};
  for (const p of base) {
    prod[p._prod] = (prod[p._prod] || 0) + 1;
    for (const e of p._estilos) est[e] = (est[e] || 0) + 1;
    for (const k of p._sirve) sir[k] = (sir[k] || 0) + 1;
  }
  return { producto: prod, estilo: est, sirve: sir };
}

// Lo que se manda al navegador (sin los campos internos con guion bajo, salvo los utiles).
const publica = (p) => ({
  id: p.id, type: p.type, name: p.name, cover_image: p.cover_image, format_slugs: p.format_slugs,
  ...(p.group_name ? { group_name: p.group_name } : {}),
  ...(p.required_inputs !== undefined ? { required_inputs: p.required_inputs } : {}),
  jh: p._jh, producto: p._prod, estilos: p._estilos, persona: p._persona, sirve: p._sirve,
});

async function pagina(f, { desde = 0, tam = 30 } = {}) {
  const items = await todas();
  const filtradas = ordenar(filtrar(items, f), f.orden);
  const trozo = filtradas.slice(desde, desde + tam);
  return {
    total: filtradas.length,
    cursor: desde + tam < filtradas.length ? desde + tam : null,
    items: trozo.map(publica),
    facetas: desde === 0 ? facetas(items, f) : undefined,
  };
}

module.exports = { todas, pagina, filtrar, ordenar, facetas, enriquecer, CATEGORIA_DE_TIPO };
