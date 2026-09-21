/**
 * Fotos y fichas tecnicas de los productos de JH (Supabase Storage, los mismos
 * buckets que usan la Camila de WhatsApp y Jarvis). Cada archivo se llama como el
 * Codigo del producto: 305400.png, 305400.pdf. No hay tabla que los una, asi que
 * se arma un indice con los nombres de los archivos (listarlos pide la service key).
 *
 * La busqueda de productos la hace la Camila paralela de n8n (lib/camila.js);
 * aqui solo se resuelve la URL de la foto y la ficha de cada codigo.
 */
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKETS = {
  imagen: process.env.CAMILA_BUCKET_IMAGENES || 'Lucas_imagenes',
  ficha: process.env.CAMILA_BUCKET_FICHAS || 'Lucas_fichas_tecnicas',
};
const VIGENCIA_INDICE = 6 * 3600e3; // los archivos cambian poco; listar ~25.000 nombres tarda unos segundos
const ESPERA_TRAS_FALLO = 10 * 60e3; // un codigo sin foto puede ser una recien subida: se relista, pero no seguido
const POR_PAGINA = 1000;

// Para las pruebas: reemplaza el listado de los buckets.
let _listar = null;
function _simular({ listar } = {}) { _listar = listar || null; _estado.indices = null; _estado.cuando = 0; }

// ── Fotos y fichas (Supabase Storage) ──
const _estado = { cuando: 0, indices: null, publicos: {}, relistado: 0, listando: null };

// En el bucket hay copias sueltas ("0774 - copia.png", "11815 (2).png"): todas son el mismo codigo.
function normalizarNombre(nombre) {
  let t = String(nombre || '').split('/').pop().trim();
  if (/\.[A-Za-z]{3,4}$/.test(t)) t = t.replace(/\.[^.]+$/, '');
  t = t.replace(/(\s*-?\s*(copia|copy)(\s*\(\d+\))?)+$/i, '').replace(/\s*\(\d+\)$/, '');
  return t.trim().toUpperCase();
}
const esOriginal = (nombre) => String(nombre).split('/').pop().replace(/\.[^.]+$/, '').toUpperCase() === normalizarNombre(nombre);

function armarIndice(nombres) {
  const indice = new Map();
  for (const n of [...nombres].sort()) {
    const cod = normalizarNombre(n);
    if (!cod) continue;
    const actual = indice.get(cod);
    if (!actual || (esOriginal(n) && !esOriginal(actual))) indice.set(cod, n);
  }
  return indice;
}

async function listarBucket(bucket, prefijo = '') {
  if (_listar) return _listar(bucket, prefijo);
  const nombres = [];
  for (let desde = 0; ; desde += POR_PAGINA) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: prefijo, limit: POR_PAGINA, offset: desde, sortBy: { column: 'name', order: 'asc' } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`listar ${bucket}: HTTP ${r.status}`);
    const lote = await r.json();
    for (const it of lote) {
      const ruta = `${prefijo}${it.name}`;
      if (it.id == null) nombres.push(...await listarBucket(bucket, `${ruta}/`)); // carpeta
      else nombres.push(ruta);
    }
    if (lote.length < POR_PAGINA) return nombres;
  }
}

async function refrescarIndices() {
  _estado.listando ||= (async () => {
    try {
      const indices = {};
      for (const [tipo, b] of Object.entries(BUCKETS)) indices[tipo] = armarIndice(await listarBucket(b));
      Object.assign(_estado, { indices, cuando: Date.now() });
      console.log(`[jh-catalogo] fotos ${indices.imagen.size} · fichas ${indices.ficha.size}`);
    } finally { _estado.listando = null; }
  })();
  return _estado.listando;
}

async function indices() {
  if (!_estado.indices) await refrescarIndices();
  else if (Date.now() - _estado.cuando > VIGENCIA_INDICE) refrescarIndices().catch((e) => console.error('[jh-catalogo] indice', e.message));
  return _estado.indices;
}

const urlPublica = (tipo, archivo) => `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(BUCKETS[tipo])}/${archivo.split('/').map(encodeURIComponent).join('/')}`;

/** { imagen: url|null, ficha: url|null } de un codigo. Los buckets son publicos. */
async function archivosDe(codigo, { relistar = false } = {}) {
  let ix = await indices();
  const cod = normalizarNombre(codigo);
  if (relistar && !ix.imagen.has(cod) && Date.now() - _estado.relistado > ESPERA_TRAS_FALLO) {
    _estado.relistado = Date.now();
    await refrescarIndices();
    ix = _estado.indices;
  }
  const img = ix.imagen.get(cod);
  const fic = ix.ficha.get(cod);
  return { imagen: img ? urlPublica('imagen', img) : null, ficha: fic ? urlPublica('ficha', fic) : null };
}

/** Arma el indice en segundo plano al arrancar (asi la primera respuesta no espera el listado). */
function calentar() {
  if (_listar || !SUPABASE_URL || !SERVICE_KEY) return;
  indices().catch((e) => console.error('[jh-catalogo] indice', e.message));
}

module.exports = { calentar, archivosDe, armarIndice, normalizarNombre, _simular, BUCKETS };
