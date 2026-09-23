/**
 * Logos de JH para la marca de agua (lib/marca.js).
 *
 * Se guardan en la base (son PNG chicos): cada logo puede tener version clara y oscura, y el
 * panel elige la que contrasta con la esquina donde va. Uno queda marcado por defecto: ese es el
 * que se le pone solo a cada creacion terminada.
 * Subir y borrar pide el permiso 'subir_logos' (o ser super admin); usarlos puede cualquiera.
 */
const { pool } = require('./db');

const MAX_BYTES = 2 * 1024 * 1024;
const TIPOS = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS logos (
     id BIGSERIAL PRIMARY KEY,
     nombre TEXT NOT NULL,
     claro BYTEA,
     oscuro BYTEA,
     mime TEXT NOT NULL DEFAULT 'image/png',
     por_defecto BOOLEAN NOT NULL DEFAULT false,
     por TEXT NOT NULL,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS logos_defecto_idx ON logos (por_defecto) WHERE por_defecto`,
  `ALTER TABLE accesos ADD COLUMN IF NOT EXISTS subir_logos BOOLEAN NOT NULL DEFAULT false`,
];
let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

class ErrorDeLogo extends Error {
  constructor(mensaje, { status = 400 } = {}) { super(mensaje); this.status = status; }
}

const COLS = `id, nombre, mime, por_defecto, por, creado,
  (claro IS NOT NULL) AS tiene_claro, (oscuro IS NOT NULL) AS tiene_oscuro,
  COALESCE(octet_length(claro), 0) + COALESCE(octet_length(oscuro), 0) AS bytes`;

const limpio = (l) => l && ({ ...l, id: Number(l.id), bytes: Number(l.bytes) });

async function lista() {
  await migrar();
  const { rows } = await pool.query(`SELECT ${COLS} FROM logos ORDER BY por_defecto DESC, id DESC`);
  return rows.map(limpio);
}

async function uno(id) {
  await migrar();
  const { rows: [l] } = await pool.query(`SELECT ${COLS} FROM logos WHERE id = $1`, [id]);
  return limpio(l);
}

/** El archivo de una version ('claro' | 'oscuro') para servirlo o escribirlo en disco. */
async function archivo(id, version = 'claro') {
  await migrar();
  const campo = version === 'oscuro' ? 'oscuro' : 'claro';
  const { rows: [l] } = await pool.query(`SELECT ${campo} AS bytes, mime FROM logos WHERE id = $1`, [id]);
  return l?.bytes ? { bytes: l.bytes, mime: l.mime } : null;
}

/** El logo que se usa solo (el marcado por defecto, o el único que haya). */
async function porDefecto() {
  await migrar();
  const { rows: [l] } = await pool.query(`SELECT ${COLS} FROM logos ORDER BY por_defecto DESC, id LIMIT 1`);
  return limpio(l);
}

/** Las dos versiones en bruto, para lib/marca.js. */
async function versiones(id) {
  await migrar();
  const { rows: [l] } = await pool.query('SELECT claro, oscuro, mime FROM logos WHERE id = $1', [id]);
  if (!l) return null;
  return { claro: l.claro || null, oscuro: l.oscuro || null, mime: l.mime, ext: TIPOS[l.mime] || 'png' };
}

function revisarArchivo(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ErrorDeLogo('Falta el archivo del logo.');
  if (!TIPOS[mime]) throw new ErrorDeLogo('El logo tiene que ser PNG, WEBP o JPG. El PNG con fondo transparente es el que mejor queda.');
  if (bytes.length > MAX_BYTES) throw new ErrorDeLogo('El logo no puede pasar de 2 MB.');
}

/** Crea o actualiza una version del logo. `version` = 'claro' | 'oscuro'. */
async function guardar({ id = null, nombre, version = 'claro', bytes, mime, por }) {
  await migrar();
  revisarArchivo(bytes, mime);
  const campo = version === 'oscuro' ? 'oscuro' : 'claro';
  if (id) {
    const { rows: [l] } = await pool.query(`UPDATE logos SET ${campo} = $2, mime = $3 WHERE id = $1 RETURNING ${COLS}`, [id, bytes, mime]);
    if (!l) throw new ErrorDeLogo('Ese logo ya no está.', { status: 404 });
    return limpio(l);
  }
  const limpioNombre = String(nombre || '').trim().slice(0, 80) || 'Logo';
  const { rows: [n] } = await pool.query('SELECT COUNT(*)::int AS n FROM logos');
  const { rows: [l] } = await pool.query(
    `INSERT INTO logos (nombre, ${campo}, mime, por, por_defecto) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [limpioNombre, bytes, mime, por, n.n === 0]
  );
  return limpio(l);
}

async function renombrar(id, nombre) {
  await migrar();
  const { rows: [l] } = await pool.query(`UPDATE logos SET nombre = $2 WHERE id = $1 RETURNING ${COLS}`, [id, String(nombre || '').trim().slice(0, 80) || 'Logo']);
  if (!l) throw new ErrorDeLogo('Ese logo ya no está.', { status: 404 });
  return limpio(l);
}

async function marcarDefecto(id) {
  await migrar();
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query('UPDATE logos SET por_defecto = false WHERE por_defecto');
    const { rowCount } = await cli.query('UPDATE logos SET por_defecto = true WHERE id = $1', [id]);
    await cli.query('COMMIT');
    if (!rowCount) throw new ErrorDeLogo('Ese logo ya no está.', { status: 404 });
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
  return uno(id);
}

/** Borra una version, o el logo entero si se borran las dos. */
async function borrar(id, { version = null } = {}) {
  await migrar();
  if (version) {
    const campo = version === 'oscuro' ? 'oscuro' : 'claro';
    const { rows: [l] } = await pool.query(`UPDATE logos SET ${campo} = NULL WHERE id = $1 RETURNING ${COLS}`, [id]);
    if (!l) throw new ErrorDeLogo('Ese logo ya no está.', { status: 404 });
    if (l.tiene_claro || l.tiene_oscuro) return limpio(l);
  }
  const { rows: [b] } = await pool.query('DELETE FROM logos WHERE id = $1 RETURNING por_defecto', [id]);
  if (!b) throw new ErrorDeLogo('Ese logo ya no está.', { status: 404 });
  if (b.por_defecto) await pool.query('UPDATE logos SET por_defecto = true WHERE id = (SELECT id FROM logos ORDER BY id LIMIT 1)');
  return null;
}

module.exports = { migrar, lista, uno, archivo, porDefecto, versiones, guardar, renombrar, marcarDefecto, borrar, ErrorDeLogo, TIPOS, MAX_BYTES };
