/**
 * Postgres compartido por el panel y el worker.
 * - hf_token: una sola fila con el token OAuth de Higgsfield (el refresh token
 *   ROTA en cada uso, por eso vive aqui y no en una variable de entorno).
 * - generaciones: cola + historial. El panel inserta 'pendiente'; el worker la
 *   manda a Higgsfield y la sigue hasta 'completado' o 'fallido'.
 */
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway: la URL interna no usa SSL; la publica (proxy) si lo acepta sin verificar.
  ssl: /proxy\.rlwy\.net|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5,
});

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS hf_token (
     id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
     client_id TEXT NOT NULL,
     access_token TEXT,
     refresh_token TEXT NOT NULL,
     expira_en TIMESTAMPTZ,
     cuenta TEXT,
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
     ultimo_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS generaciones (
     id BIGSERIAL PRIMARY KEY,
     creado_por TEXT NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente',
     preset_id TEXT NOT NULL,
     preset_nombre TEXT,
     preset_tipo TEXT NOT NULL,
     portada JSONB,
     entrada JSONB NOT NULL,
     creditos_estimados NUMERIC,
     hf_job_ids TEXT[] NOT NULL DEFAULT '{}',
     resultados JSONB,
     error TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     enviado TIMESTAMPTZ,
     terminado TIMESTAMPTZ,
     revisado TIMESTAMPTZ
   )`,
  // error = mensaje para el usuario (sin nombres del proveedor); error_detalle = tecnico, solo logs/admin.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS error_detalle TEXT`,
  `CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
  // Publicaciones en redes (via Zernio). request_id hace idempotente el create.
  `CREATE TABLE IF NOT EXISTS publicaciones (
     id BIGSERIAL PRIMARY KEY,
     request_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
     generacion_id BIGINT NOT NULL REFERENCES generaciones(id),
     indice INT NOT NULL DEFAULT 0,
     creado_por TEXT NOT NULL,
     texto TEXT NOT NULL DEFAULT '',
     medio JSONB NOT NULL,
     cuentas JSONB NOT NULL,
     opciones JSONB,
     programada_para TIMESTAMPTZ,
     zona TEXT,
     estado TEXT NOT NULL DEFAULT 'enviando',
     zernio_post_id TEXT,
     plataformas JSONB,
     error TEXT,
     error_detalle TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
     revisado TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS publicaciones_estado_idx ON publicaciones (estado)`,
  // Acceso al panel para quien no es super_admin (lo dan los super_admin desde la pestaña Super Admin).
  `CREATE TABLE IF NOT EXISTS accesos (
     user_id UUID PRIMARY KEY,
     email TEXT NOT NULL,
     rol TEXT NOT NULL CHECK (rol IN ('usuario', 'admin')),
     otorgado_por TEXT NOT NULL,
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Foto de costo/precio al crear cada generacion (cambiar el margen no reescribe el pasado).
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS user_id UUID`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS usd_por_credito NUMERIC`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS margen_pct NUMERIC`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS costo_usd NUMERIC`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS precio_usd NUMERIC`,
  `CREATE INDEX IF NOT EXISTS generaciones_estado_idx ON generaciones (estado)`,
  `CREATE INDEX IF NOT EXISTS generaciones_creado_idx ON generaciones (creado DESC)`,
];

let _migrado = null;
function migrar() {
  _migrado ||= (async () => {
    for (const sql of MIGRACIONES) await pool.query(sql);
  })();
  return _migrado;
}

module.exports = { pool, migrar };
