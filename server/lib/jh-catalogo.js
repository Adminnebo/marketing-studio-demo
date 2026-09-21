/**
 * Catalogo de productos de JH para Camila: la misma tabla que usan la Camila de
 * WhatsApp y Jarvis (dbo.List_ProductosIA, SQL Server de JH, solo lectura) y las
 * fotos y fichas tecnicas de Supabase Storage (cada archivo se llama como el
 * Codigo: 305400.png, 305400.pdf).
 *
 * A diferencia de la Camila de WhatsApp, aqui la IA NO escribe SQL: solo da las
 * palabras clave y la consulta se arma con parametros (misma plantilla: un bloque
 * Descripcion/DescripcionAlterna/Marca por palabra, unidos con AND).
 *
 * JH_CATALOGO = JSON { host, puerto, instancia, base, usuario, password }
 * (el mismo formato de la fuente "Base JH" de Jarvis).
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
const MAX_FILAS = 40;

function config() {
  const crudo = (process.env.JH_CATALOGO || '').trim();
  if (!crudo) return null;
  try {
    // Mismo formato que JARVIS_FUENTES (a veces llega con comillas de mas alrededor).
    const c = JSON.parse(crudo.replace(/^"(.*)",?$/s, '$1'));
    return c && c.host && c.usuario && c.base ? c : null;
  } catch { return null; }
}

// Para las pruebas: reemplaza la consulta a SQL Server y el listado de los buckets.
let _consulta = null;
let _listar = null;
function _simular({ consulta, listar } = {}) { _consulta = consulta || null; _listar = listar || null; _estado.indices = null; _estado.cuando = 0; }

const configurado = () => !!(_consulta || config());

// ── SQL Server ──
let _pool = null;
async function pool() {
  if (_pool) return _pool;
  const sql = require('mssql');
  const c = config();
  if (!c) throw new Error('JH_CATALOGO no está configurado');
  const p = new sql.ConnectionPool({
    server: c.host,
    ...(c.puerto ? { port: Number(c.puerto) } : {}),
    database: c.base, user: c.usuario, password: c.password || '',
    pool: { max: 4, min: 0, idleTimeoutMillis: 60000 },
    connectionTimeout: 15000, requestTimeout: 20000,
    options: {
      ...(c.instancia && !c.puerto ? { instanceName: c.instancia } : {}),
      encrypt: false, trustServerCertificate: true, readOnlyIntent: true,
    },
  });
  p.on('error', (e) => { console.error('[jh-catalogo] pool', e.message); _pool = null; });
  _pool = p.connect().then(() => p).catch((e) => { _pool = null; throw e; });
  return _pool;
}

async function consultar(texto, params) {
  if (_consulta) return _consulta(texto, params);
  const sql = require('mssql');
  const p = await pool();
  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, sql.NVarChar(200), v);
  return (await req.query(texto)).recordset;
}

// LIKE sin comodines del usuario: %, _ y [ van literales.
const escaparLike = (s) => s.replace(/[[%_]/g, (c) => `[${c}]`);

/** Normaliza una palabra clave: minusculas, sin tildes, sin espacios de mas. */
function limpiar(p) {
  return String(p || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Arma la consulta (exportada para las pruebas). */
function armar({ palabras = [], codigo = '', amplio = false }) {
  const cols = `TOP ${MAX_FILAS} RTRIM(Codigo) AS Codigo, RTRIM(Referencia) AS Referencia, RTRIM(Descripcion) AS Descripcion,
    RTRIM(Marca) AS Marca, P1, RTRIM(Und) AS Und, Inventario, PrioridadOfrecer`;
  const cod = String(codigo || '').trim().slice(0, 30);
  if (cod) {
    return { texto: `SELECT ${cols} FROM dbo.List_ProductosIA WHERE RTRIM(Codigo) = @cod OR RTRIM(Referencia) = @cod`, params: { cod } };
  }
  const todas = [...new Set(palabras.map(limpiar).filter(Boolean))];
  // Una letra suelta ("square","d") filtra casi nada y ensucia: se descarta si hay otras palabras.
  const ks = (todas.length > 1 ? todas.filter((k) => k.length > 1) : todas).slice(0, 6);
  if (!ks.length) return null;
  const params = {};
  const bloques = ks.map((k, i) => {
    params[`k${i}`] = `%${escaparLike(k)}%`;
    const c = ['Descripcion', 'DescripcionAlterna', 'Marca', ...(amplio ? ['UsoComun'] : [])];
    return `(${c.map((x) => `${x} LIKE @k${i}`).join(' OR ')})`;
  });
  const texto = `SELECT ${cols} FROM dbo.List_ProductosIA WHERE ${bloques.join(' AND ')}
    ORDER BY CASE WHEN PrioridadOfrecer IS NULL THEN 999 ELSE PrioridadOfrecer END,
      CASE WHEN Descripcion LIKE @k0 THEN 1 WHEN DescripcionAlterna LIKE @k0 THEN 2 WHEN UsoComun LIKE @k0 THEN 3 ELSE 4 END,
      P1`;
  return { texto, params };
}

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

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function fila(r, ix) {
  const codigo = String(r.Codigo || '').trim();
  const cod = normalizarNombre(codigo);
  const img = ix.imagen.get(cod);
  const fic = ix.ficha.get(cod);
  return {
    codigo, referencia: r.Referencia || null, descripcion: r.Descripcion || '', marca: r.Marca && r.Marca !== 'GENERICA' ? r.Marca : null,
    precio: num(r.P1), unidad: r.Und || null, inventario: num(r.Inventario),
    foto: img ? urlPublica('imagen', img) : null, ficha: fic ? urlPublica('ficha', fic) : null,
  };
}

/**
 * Busca productos. Devuelve { total, productos } con los que tienen foto primero
 * (sin cambiar el orden comercial dentro de cada grupo).
 */
async function buscar({ palabras = [], codigo = '', amplio = false } = {}) {
  const q = armar({ palabras, codigo, amplio });
  if (!q) return { total: 0, productos: [] };
  const [filas, ix] = await Promise.all([consultar(q.texto, q.params), indices()]);
  const vistos = new Set();
  const productos = [];
  for (const r of filas) {
    const p = fila(r, ix);
    if (!p.codigo || vistos.has(p.codigo)) continue;
    vistos.add(p.codigo);
    productos.push(p);
  }
  const conFoto = productos.filter((p) => p.foto);
  return { total: productos.length, productos: [...conFoto, ...productos.filter((p) => !p.foto)] };
}

module.exports = { configurado, buscar, archivosDe, armar, armarIndice, normalizarNombre, limpiar, _simular, BUCKETS };
