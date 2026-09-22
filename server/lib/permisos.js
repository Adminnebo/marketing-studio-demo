/**
 * Permisos puntuales dentro de Marketing (ademas del rol usuario/admin/super_admin).
 * - puede_publicar (tabla accesos): solo quien lo tiene publica o programa en redes.
 *   Los super admin siempre pueden (salvo en "Ver como", que muestra el panel de otro rol).
 */
const { pool } = require('./db');

const MIGRACIONES = [
  `ALTER TABLE accesos ADD COLUMN IF NOT EXISTS puede_publicar BOOLEAN NOT NULL DEFAULT false`,
];
let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

// Rutas que publican o programan en redes.
const requirePublicar = (req, res, next) => (req.user?.puedePublicar ? next()
  : res.status(403).json({ error: 'Tu usuario no tiene permiso para publicar en redes. Pídeselo a un super admin.' }));

module.exports = { migrar, requirePublicar };
