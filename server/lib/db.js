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
  // Billetera de creditos de JH: saldo = suma de movimientos (+ recarga/reembolso/ajuste, - consumo).
  `CREATE TABLE IF NOT EXISTS billetera (
     id BIGSERIAL PRIMARY KEY,
     tipo TEXT NOT NULL CHECK (tipo IN ('recarga', 'consumo', 'reembolso', 'ajuste')),
     creditos NUMERIC NOT NULL,
     usd NUMERIC,
     generacion_id BIGINT REFERENCES generaciones(id),
     nota TEXT,
     por TEXT NOT NULL,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Un solo cobro y un solo reembolso por generacion.
  `CREATE UNIQUE INDEX IF NOT EXISTS billetera_gen_tipo_idx ON billetera (generacion_id, tipo) WHERE generacion_id IS NOT NULL`,
  // Reconexion del generador desde el panel (OAuth code + PKCE): un estado por intento, de un solo uso.
  `CREATE TABLE IF NOT EXISTS oauth_estados (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     client_id TEXT NOT NULL,
     redirect TEXT NOT NULL,
     por TEXT NOT NULL,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Clasificacion automatica de plantillas nuevas (la base viene de shared/clasificacion.json).
  `CREATE TABLE IF NOT EXISTS plantillas_clasif (
     id TEXT PRIMARY KEY,
     p TEXT NOT NULL,
     e JSONB NOT NULL,
     per BOOLEAN NOT NULL,
     jh INT NOT NULL,
     nombre TEXT,
     fuente TEXT NOT NULL,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Eventos de webhook de Zernio ya procesados (llegan al menos una vez: se deduplica por id).
  `CREATE TABLE IF NOT EXISTS zernio_eventos (
     id TEXT PRIMARY KEY,
     evento TEXT NOT NULL,
     recibido TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Sesion de la CLI del generador (modelos que el MCP no tiene). Rota como hf_token.
  `CREATE TABLE IF NOT EXISTS hf_cli_sesion (
     id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
     archivos JSONB NOT NULL,
     cuenta TEXT,
     cargada_por TEXT,
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
     ultimo_uso TIMESTAMPTZ,
     ultimo_error TEXT
   )`,
  // Plataforma central de pagos (lib/pagos.js). Recargas desde el saldo general del cliente
  // (se registran antes de pedirlas: si no hay respuesta, el worker repite la misma referencia).
  `CREATE TABLE IF NOT EXISTS recargas_central (
     referencia TEXT PRIMARY KEY,
     monto_usd NUMERIC NOT NULL,
     creditos NUMERIC NOT NULL,
     precio_credito NUMERIC NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aplicada', 'rechazada')),
     por TEXT NOT NULL,
     usuario JSONB,
     recarga_id TEXT,
     motivo TEXT,
     respuesta TEXT,
     intentos INT NOT NULL DEFAULT 0,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Una recarga desde el saldo general entra UNA sola vez a la billetera (defensa extra a la idempotencia).
  `ALTER TABLE billetera ADD COLUMN IF NOT EXISTS referencia TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS billetera_referencia_idx ON billetera (referencia) WHERE referencia IS NOT NULL`,
  // Consumos informados a la plataforma (uno por generacion cobrada), con reintentos.
  `CREATE TABLE IF NOT EXISTS pagos_eventos (
     id BIGSERIAL PRIMARY KEY,
     generacion_id BIGINT NOT NULL REFERENCES generaciones(id),
     referencia TEXT NOT NULL,
     tipo TEXT NOT NULL CHECK (tipo IN ('consumo')),
     cuerpo JSONB NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente',
     intentos INT NOT NULL DEFAULT 0,
     proximo TIMESTAMPTZ NOT NULL DEFAULT now(),
     ultimo_error TEXT,
     respuesta TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     hecho TIMESTAMPTZ,
     UNIQUE (generacion_id, tipo)
   )`,
  // Saldo externo (lib/saldo-externo.js): la generacion se cobra contra el saldo de la plataforma de
  // pagos; gasto_informado marca cuando ya se descontó alla con el endpoint de gasto.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS cobro_externo BOOLEAN NOT NULL DEFAULT false`,
  // Pagada con el saldo de Marketing (lib/saldo-marketing.js): esa plata ya salio del saldo general al aprobar la recarga.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS cobro_interno BOOLEAN NOT NULL DEFAULT false`,
  // Borrada de la galeria: deja de verse en Mis creaciones, pero el gasto y su historial se conservan.
  // Marca de agua (lib/marca.js): pendiente | hecha | sin_logo | error, y el detalle de lo aplicado.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS marca_estado TEXT`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS marca JSONB`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS eliminada TIMESTAMPTZ`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS eliminada_por TEXT`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS gasto_informado TIMESTAMPTZ`,
  // Reintento automatico tras un rechazo del filtro de contenido (lib/reintento.js): la creacion nueva.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS reintento_id BIGINT`,
  // Pagada con el wallet de Marketing de la plataforma central (lib/wallet.js). Las creaciones
  // viejas no lo tienen, asi que nunca se les cobra de nuevo al cambiar de modelo de saldo.
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS cobro_wallet BOOLEAN NOT NULL DEFAULT false`,
  // Plantillas propias: los disenos que JH ya publico, convertidos en receta reutilizable
  // (lib/plantillas-propias.js). Compartidas: las crea cualquiera y las usa todo el equipo.
  `CREATE TABLE IF NOT EXISTS plantillas_propias (
     id BIGSERIAL PRIMARY KEY,
     nombre TEXT NOT NULL,
     para TEXT NOT NULL DEFAULT 'video',
     receta TEXT NOT NULL,
     aspecto TEXT NOT NULL DEFAULT '9:16',
     duracion INT,
     con_audio BOOLEAN NOT NULL DEFAULT false,
     portada JSONB,
     origen JSONB,
     creado_por TEXT NOT NULL,
     usos INT NOT NULL DEFAULT 0,
     eliminada BOOLEAN NOT NULL DEFAULT false,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Zonas de texto del diseño: al usar la plantilla se le piden esos textos al usuario
  // (sin esto la pieza salia con huecos vacios, como una hoja en blanco).
  `ALTER TABLE plantillas_propias ADD COLUMN IF NOT EXISTS zonas TEXT`,
  `ALTER TABLE plantillas_propias ADD COLUMN IF NOT EXISTS con_texto BOOLEAN NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS publicaciones_zernio_idx ON publicaciones (zernio_post_id)`,
  // Cola de debitos al wallet de Marketing de la plataforma central (lib/wallet.js).
  // referencia UNIQUE: ni un reintento nuestro ni un doble evento pueden cobrar dos veces.
  `CREATE TABLE IF NOT EXISTS wallet_debitos (
     id BIGSERIAL PRIMARY KEY,
     referencia TEXT NOT NULL UNIQUE,
     usd NUMERIC NOT NULL CHECK (usd > 0),
     descripcion TEXT NOT NULL,
     generacion_id BIGINT REFERENCES generaciones(id),
     movimiento_id BIGINT,
     por TEXT,
     estado TEXT NOT NULL DEFAULT 'pendiente',
     intentos INT NOT NULL DEFAULT 0,
     proximo TIMESTAMPTZ NOT NULL DEFAULT now(),
     duplicada BOOLEAN NOT NULL DEFAULT false,
     ultimo_error TEXT,
     respuesta TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     hecho TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS wallet_debitos_estado_idx ON wallet_debitos (estado, proximo)`,
  `CREATE INDEX IF NOT EXISTS wallet_debitos_gen_idx ON wallet_debitos (generacion_id)`,
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
