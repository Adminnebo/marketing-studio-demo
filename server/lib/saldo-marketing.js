/**
 * Saldo propio del departamento de Marketing (USD), separado del saldo general de JH.
 *
 * - Se recarga con solicitudes: cualquiera con acceso pide un monto; quien tiene el
 *   permiso "aprobar recargas" (o un super admin) la aprueba y en ese momento el monto
 *   se descuenta UNA vez del saldo general de JH en la plataforma de pagos (Sword,
 *   lib/pagos.js) y entra aca.
 * - De aca sale todo lo que gasta Marketing: cada creacion, cada ayuda de IA
 *   (descripcion automatica, ficha tecnica, captions) y cada busqueda con Camila, a
 *   costo real + el mismo margen de las creaciones. Ya no se descuenta del saldo
 *   general por cada creacion (no se cobra dos veces).
 * - El equipo de Marketing solo ve este saldo; el general lo ven los aprobadores.
 *
 * - Lo que gastan los super admins (y el sistema, p. ej. clasificar plantillas) tambien se registra
 *   aca, marcado a_jh: NO cuenta para el saldo de Marketing y se descuenta del saldo general de JH
 *   por lotes (enviarAJh, desde el worker), porque la plataforma descuenta en centavos.
 *
 * Movimientos (saldo = suma de usd, sin los a_jh): recarga (+), consumo (-), ia (-), reembolso (+), ajuste (±).
 * `ref` hace idempotente cada movimiento (una sola vez por generacion, solicitud o ejecucion).
 */
const { pool } = require('./db');
const ajustes = require('./config');
const pagos = require('./pagos');
const saldoExterno = require('./saldo-externo');
const costosIa = require('./costos-ia');

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS saldo_marketing (
     id BIGSERIAL PRIMARY KEY,
     tipo TEXT NOT NULL CHECK (tipo IN ('recarga', 'consumo', 'ia', 'reembolso', 'ajuste')),
     usd NUMERIC NOT NULL,
     generacion_id BIGINT REFERENCES generaciones(id),
     concepto TEXT,
     ref TEXT,
     por TEXT NOT NULL,
     datos JSONB,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS saldo_marketing_ref_idx ON saldo_marketing (ref) WHERE ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS saldo_marketing_gen_idx ON saldo_marketing (generacion_id)`,
  `CREATE TABLE IF NOT EXISTS solicitudes_recarga (
     id BIGSERIAL PRIMARY KEY,
     monto_usd NUMERIC NOT NULL CHECK (monto_usd > 0),
     motivo TEXT,
     pedido_por TEXT NOT NULL,
     estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'revisar')),
     resuelto_por TEXT,
     resuelto TIMESTAMPTZ,
     nota TEXT,
     respuesta TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE accesos ADD COLUMN IF NOT EXISTS aprobar_recargas BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE generaciones ADD COLUMN IF NOT EXISTS cobro_interno BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE saldo_marketing ADD COLUMN IF NOT EXISTS a_jh BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE saldo_marketing ADD COLUMN IF NOT EXISTS lote_id BIGINT`,
  `CREATE TABLE IF NOT EXISTS lotes_jh (
     id BIGSERIAL PRIMARY KEY,
     usd NUMERIC NOT NULL,
     estado TEXT NOT NULL DEFAULT 'enviando' CHECK (estado IN ('enviando', 'enviado', 'revisar')),
     nota TEXT,
     error TEXT,
     creado TIMESTAMPTZ NOT NULL DEFAULT now(),
     enviado TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS saldo_marketing_jh_idx ON saldo_marketing (lote_id) WHERE a_jh`,
];
let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

class SaldoMarketingError extends Error {
  constructor(msg, { status = 400, datos = null } = {}) { super(msg); this.status = status; this.datos = datos; }
}

// Activo cuando hay saldo general de JH y se puede descontar de el (produccion).
let _forzar = null; // pruebas
const activo = () => (_forzar != null ? _forzar : saldoExterno.configurado() && pagos.configurado());
function _probar({ activo: a = null, ajustar = null, resumen = null } = {}) { _forzar = a; _ajustar = ajustar; _resumen = resumen; }
let _ajustar = null; let _resumen = null;
const ajustar = (args) => (_ajustar ? _ajustar(args) : pagos.ajustar(args));
const resumenGeneral = () => (_resumen ? _resumen() : saldoExterno.resumen());

const r4 = (n) => Math.round(Number(n) * 10000) / 10000;

async function saldo(cli = pool) {
  const { rows: [r] } = await cli.query('SELECT COALESCE(SUM(usd), 0) AS s FROM saldo_marketing WHERE NOT a_jh');
  return r4(r.s);
}

// Un solo cobro a la vez (dentro de una transaccion): dos creaciones simultaneas no gastan la misma plata.
const bloquear = (cli) => cli.query('SELECT pg_advisory_xact_lock(4712)');

/**
 * Cobra una creacion dentro de la transaccion `cli` (ya bloqueada con bloquear()).
 * Tambien le asigna las ayudas de IA de ese usuario que todavia no tenian creacion
 * (la descripcion o la ficha que uso para crearla): asi el total de la creacion las incluye.
 */
async function cobrarGeneracion(cli, { generacionId, usd, por, concepto }) {
  await cli.query(
    `INSERT INTO saldo_marketing (tipo, usd, generacion_id, concepto, ref, por) VALUES ('consumo', $1, $2, $3, $4, $5)`,
    [-r4(usd), generacionId, concepto || null, `gen:${generacionId}:consumo`, por]
  );
  await cli.query(
    `UPDATE saldo_marketing SET generacion_id = $1
     WHERE tipo = 'ia' AND NOT a_jh AND generacion_id IS NULL AND por = $2 AND creado > now() - interval '6 hours'
       AND COALESCE(datos->>'clase', '') <> 'caption'`,
    [generacionId, por]
  );
}

/** Devuelve lo cobrado por una creacion que no salio (una sola vez). Devuelve el monto o 0. */
async function reembolsar(generacionId) {
  const { rows: [c] } = await pool.query(`SELECT usd, por FROM saldo_marketing WHERE ref = $1`, [`gen:${generacionId}:consumo`]);
  if (!c) return 0;
  const r = await pool.query(
    `INSERT INTO saldo_marketing (tipo, usd, generacion_id, concepto, ref, por) VALUES ('reembolso', $1, $2, 'Creación que no salió', $3, $4)
     ON CONFLICT DO NOTHING`,
    [-Number(c.usd), generacionId, `gen:${generacionId}:reembolso`, c.por]
  );
  return r.rowCount ? r4(-Number(c.usd)) : 0;
}

const CLASES_IA = { descripcion: 'Descripción automática', ficha: 'Lectura de ficha técnica', caption: 'Caption y hashtags', camila: 'Búsqueda con Camila', clasificar: 'Clasificación de plantillas', correccion: 'Corrección del prompt rechazado', plantilla: 'Plantilla propia desde un diseño' };

/**
 * Cobra una ayuda de IA: costo real (USD) + el margen de las creaciones. Idempotente por `ref`.
 * `costoUsd` directo, o `modelo` + tokens para calcularlo. Devuelve lo cobrado (USD) o 0.
 * `aJh`: super admin o sistema -> se registra igual pero va al saldo general de JH (enviarAJh).
 */
async function cobrarIa({ por, clase, costoUsd = null, modelo = null, entrada = 0, salida = 0, generacionId = null, ref = null, detalle = null, aJh = false }) {
  if (!activo()) return 0;
  const costo = costoUsd != null ? Number(costoUsd) : costosIa.costoUsd(modelo, entrada, salida);
  if (!(costo > 0)) return 0;
  const a = await ajustes.leer();
  const cobro = r4(costo * (1 + (Number(a.margen_pct) || 0) / 100));
  if (!(cobro > 0)) return 0;
  const r = await pool.query(
    `INSERT INTO saldo_marketing (tipo, usd, generacion_id, concepto, ref, por, datos, a_jh) VALUES ('ia', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [-cobro, aJh ? null : generacionId, detalle ? `${CLASES_IA[clase] || clase} · ${detalle}` : CLASES_IA[clase] || clase, ref, por,
      JSON.stringify({ clase, costo_usd: costo, modelo, entrada, salida, ...(aJh && generacionId ? { generacion: generacionId } : {}) }), !!aJh]
  );
  return r.rowCount ? cobro : 0;
}

// Antes de una ayuda de IA: sin saldo de Marketing no se usa (los super admin no gastan del saldo).
async function puedeGastarIa(user) {
  if (!activo() || user?.rolReal === 'super_admin') return true;
  return (await saldo()) > 0;
}
const exento = (user) => user?.rolReal === 'super_admin';

async function movimientos(limite = 60, { conJh = false } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.tipo, s.usd, s.generacion_id, s.concepto, s.por, s.creado, g.preset_nombre, s.datos->>'clase' AS clase,
            s.a_jh, l.estado AS lote_estado
     FROM saldo_marketing s LEFT JOIN generaciones g ON g.id = s.generacion_id LEFT JOIN lotes_jh l ON l.id = s.lote_id
     ${conJh ? '' : 'WHERE NOT s.a_jh'} ORDER BY s.id DESC LIMIT $1`, [limite]
  );
  return rows.map((m) => ({ ...m, usd: r4(m.usd) }));
}

// Lo gastado en el mes (hora de Santo Domingo), para el resumen.
async function gastoDelMes() {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(-SUM(usd) FILTER (WHERE tipo IN ('consumo', 'ia', 'reembolso') AND NOT a_jh), 0) AS gasto,
            COALESCE(-SUM(usd) FILTER (WHERE tipo = 'ia' AND NOT a_jh), 0) AS ia,
            COALESCE(-SUM(usd) FILTER (WHERE a_jh), 0) AS jh
     FROM saldo_marketing
     WHERE date_trunc('month', creado AT TIME ZONE 'America/Santo_Domingo') = date_trunc('month', now() AT TIME ZONE 'America/Santo_Domingo')`
  );
  return { gastoUsd: r4(r.gasto), iaUsd: r4(r.ia), jhUsd: r4(r.jh) };
}

// ── Solicitudes de recarga ──
const COLS_SOL = 'id, monto_usd, motivo, pedido_por, estado, resuelto_por, resuelto, nota, creado';
const limpiarSol = (s) => s && ({ ...s, monto_usd: r4(s.monto_usd) });

async function solicitar({ montoUsd, motivo, por }) {
  const monto = r4(montoUsd);
  if (!(monto >= 1) || monto > 5000) throw new SaldoMarketingError('El monto debe estar entre $1 y $5,000.');
  const { rows: [n] } = await pool.query(`SELECT COUNT(*)::int AS n FROM solicitudes_recarga WHERE pedido_por = $1 AND estado = 'pendiente'`, [por]);
  if (n.n >= 3) throw new SaldoMarketingError('Ya tienes 3 solicitudes pendientes. Espera a que las revisen.');
  const { rows: [s] } = await pool.query(
    `INSERT INTO solicitudes_recarga (monto_usd, motivo, pedido_por) VALUES ($1, $2, $3) RETURNING ${COLS_SOL}`,
    [monto, String(motivo || '').trim().slice(0, 300) || null, por]
  );
  return limpiarSol(s);
}

async function solicitudes({ por = null, abiertas = false, limite = 30 } = {}) {
  const cond = []; const vals = [];
  if (por) { vals.push(por); cond.push(`pedido_por = $${vals.length}`); }
  if (abiertas) cond.push(`estado IN ('pendiente', 'revisar')`);
  vals.push(limite);
  const { rows } = await pool.query(
    `SELECT ${COLS_SOL} FROM solicitudes_recarga ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${vals.length}`, vals
  );
  return rows.map(limpiarSol);
}

const pendientes = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM solicitudes_recarga WHERE estado IN ('pendiente', 'revisar')`)).rows[0].n;

async function acreditar(cli, s, por) {
  await cli.query(
    `INSERT INTO saldo_marketing (tipo, usd, concepto, ref, por) VALUES ('recarga', $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [r4(s.monto_usd), `Recarga aprobada · solicitud #${s.id} de ${s.pedido_por}`, `rec:${s.id}`, por]
  );
}

/**
 * Aprueba: descuenta el monto del saldo general de JH (una vez) y lo acredita aca.
 * - Si la plataforma no recibio el pedido (seguro), la solicitud sigue pendiente.
 * - Si no se sabe si se aplico (corte a mitad), queda en 'revisar' para confirmarlo a mano.
 */
async function aprobar(id, { por, nota = null }) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [s] } = await cli.query(`SELECT * FROM solicitudes_recarga WHERE id = $1 FOR UPDATE`, [id]);
    if (!s) throw new SaldoMarketingError('Esa solicitud no existe.', { status: 404 });
    if (s.estado !== 'pendiente') throw new SaldoMarketingError('Esa solicitud ya se resolvió.', { status: 409 });
    let general = null;
    try { general = await resumenGeneral(); } catch { throw new SaldoMarketingError('No se pudo leer el saldo general de JH. Intenta de nuevo.', { status: 503 }); }
    if (general.disponibleUsd != null && general.disponibleUsd < Number(s.monto_usd)) {
      throw new SaldoMarketingError(`El saldo general de JH no alcanza: tiene ${general.disponibleUsd.toFixed(2)} USD disponibles.`, { status: 402 });
    }
    const nota_ = `Recarga del saldo de Marketing · solicitud mkt-rec-${s.id} · pedida por ${s.pedido_por} · aprobada por ${por}`;
    try {
      const r = await ajustar({ amount: r4(s.monto_usd), note: nota_ });
      await acreditar(cli, s, por);
      await cli.query(`UPDATE solicitudes_recarga SET estado = 'aprobada', resuelto_por = $2, resuelto = now(), nota = $3, respuesta = $4 WHERE id = $1`,
        [s.id, por, nota, JSON.stringify(r).slice(0, 1000)]);
      await cli.query('COMMIT');
      saldoExterno.olvidar();
      console.log(`[saldo-mkt] ${por} aprobo la solicitud #${s.id} (${s.monto_usd} USD de ${s.pedido_por})`);
      return { estado: 'aprobada' };
    } catch (e) {
      if (e instanceof SaldoMarketingError) throw e;
      if (e.seguro) throw new SaldoMarketingError('La plataforma de pagos no respondió; no se descontó nada. Intenta de nuevo.', { status: 503 });
      // No se sabe si se aplico: no se acredita; queda para confirmarlo en la plataforma.
      await cli.query(`UPDATE solicitudes_recarga SET estado = 'revisar', resuelto_por = $2, resuelto = now(), nota = $3, respuesta = $4 WHERE id = $1`,
        [s.id, por, nota, String(e.message).slice(0, 1000)]);
      await cli.query('COMMIT');
      console.error(`[saldo-mkt] solicitud #${s.id}: resultado incierto en la plataforma (${e.message})`);
      return { estado: 'revisar', error: 'La plataforma de pagos no confirmó el descuento. Revisa en la plataforma si se aplicó y márcalo.' };
    }
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
}

async function rechazar(id, { por, nota = null }) {
  const { rows: [s] } = await pool.query(
    `UPDATE solicitudes_recarga SET estado = 'rechazada', resuelto_por = $2, resuelto = now(), nota = $3
     WHERE id = $1 AND estado = 'pendiente' RETURNING ${COLS_SOL}`, [id, por, String(nota || '').slice(0, 300) || null]
  );
  if (!s) throw new SaldoMarketingError('Esa solicitud ya se resolvió o no existe.', { status: 409 });
  return limpiarSol(s);
}

// Para las que quedaron en 'revisar': confirmar a mano si el descuento se aplico en la plataforma.
async function resolverRevision(id, { por, aplicada }) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const { rows: [s] } = await cli.query(`SELECT * FROM solicitudes_recarga WHERE id = $1 AND estado = 'revisar' FOR UPDATE`, [id]);
    if (!s) throw new SaldoMarketingError('Esa solicitud no está en revisión.', { status: 409 });
    if (aplicada) await acreditar(cli, s, por);
    await cli.query(`UPDATE solicitudes_recarga SET estado = $2, resuelto_por = $3, resuelto = now() WHERE id = $1`, [id, aplicada ? 'aprobada' : 'rechazada', por]);
    await cli.query('COMMIT');
    return { estado: aplicada ? 'aprobada' : 'rechazada' };
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
}

/**
 * Fija el saldo de Marketing en un monto (super admin): registra un 'ajuste' por la diferencia.
 * Solo mueve el registro interno; NO toca el saldo general de JH en la plataforma de pagos.
 */
async function fijarSaldo({ objetivoUsd, motivo, por }) {
  const objetivo = r4(objetivoUsd);
  if (!Number.isFinite(objetivo) || objetivo < 0 || objetivo > 10000) throw new SaldoMarketingError('El saldo debe estar entre $0 y $10,000.', { status: 400 });
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await bloquear(cli);
    const antes = await saldo(cli);
    const dif = r4(objetivo - antes);
    if (dif !== 0) {
      await cli.query(
        `INSERT INTO saldo_marketing (tipo, usd, concepto, por, datos) VALUES ('ajuste', $1, $2, $3, $4)`,
        [dif, (String(motivo || '').trim() || 'Saldo fijado a mano (sin tocar el saldo general)').slice(0, 200), por, JSON.stringify({ antes, objetivo })]
      );
    }
    await cli.query('COMMIT');
    return { antes, saldoUsd: objetivo, ajusteUsd: dif };
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
}

/**
 * Worker: descuenta del saldo general de JH lo registrado a_jh (IA de super admins y del sistema)
 * en un solo ajuste por lote. Se manda cuando junta al menos 1 centavo.
 * - Si la plataforma no recibio el pedido, el lote se deshace y se reintenta en la proxima vuelta.
 * - Si no se sabe si se aplico, queda 'revisar' (no se repite solo: no hay cobro doble).
 */
async function enviarAJh() {
  if (!activo()) return null;
  // Un lote que quedo 'enviando' (el proceso se corto a mitad) no se repite solo: pasa a revisar.
  await pool.query(`UPDATE lotes_jh SET estado = 'revisar', error = 'cortado a mitad del envío' WHERE estado = 'enviando' AND creado < now() - interval '5 minutes'`);
  const cli = await pool.connect();
  let lote;
  try {
    await cli.query('BEGIN');
    await cli.query('SELECT pg_advisory_xact_lock(4713)');
    const { rows } = await cli.query(`SELECT id, usd, por, datos->>'clase' AS clase FROM saldo_marketing WHERE a_jh AND lote_id IS NULL ORDER BY id FOR UPDATE`);
    const total = Math.round(-rows.reduce((a, x) => a + Number(x.usd), 0) * 100) / 100;
    if (!rows.length || total < 0.01) { await cli.query('ROLLBACK'); return null; }
    const porClase = {};
    for (const x of rows) porClase[x.clase] = (porClase[x.clase] || 0) - Number(x.usd);
    const quienes = [...new Set(rows.map((x) => x.por))];
    ({ rows: [lote] } = await cli.query(`INSERT INTO lotes_jh (usd) VALUES ($1) RETURNING id`, [total]));
    lote.nota = [`IA de Marketing (super admin / sistema) · ${rows.length} usos`,
      Object.entries(porClase).map(([c, u]) => `${CLASES_IA[c] || c} $${u.toFixed(4)}`).join(', '),
      quienes.slice(0, 5).join(', ') + (quienes.length > 5 ? ` y ${quienes.length - 5} más` : ''),
      `ref mkt-ia-lote-${lote.id}`].join(' · ').slice(0, 500);
    await cli.query(`UPDATE lotes_jh SET nota = $2 WHERE id = $1`, [lote.id, lote.nota]);
    await cli.query(`UPDATE saldo_marketing SET lote_id = $1 WHERE id = ANY($2)`, [lote.id, rows.map((x) => x.id)]);
    await cli.query('COMMIT');
    lote.total = total; lote.n = rows.length;
  } catch (e) { await cli.query('ROLLBACK').catch(() => {}); throw e; } finally { cli.release(); }
  try {
    await ajustar({ amount: lote.total, note: lote.nota });
    await pool.query(`UPDATE lotes_jh SET estado = 'enviado', enviado = now() WHERE id = $1`, [lote.id]);
    saldoExterno.olvidar?.();
    return { lote: lote.id, usd: lote.total, usos: lote.n, estado: 'enviado' };
  } catch (e) {
    if (e.seguro) {
      await pool.query(`UPDATE saldo_marketing SET lote_id = NULL WHERE lote_id = $1`, [lote.id]);
      await pool.query(`DELETE FROM lotes_jh WHERE id = $1`, [lote.id]);
      return { lote: lote.id, usd: lote.total, estado: 'reintentar', error: e.message };
    }
    await pool.query(`UPDATE lotes_jh SET estado = 'revisar', error = $2 WHERE id = $1`, [lote.id, String(e.message).slice(0, 300)]);
    return { lote: lote.id, usd: lote.total, estado: 'revisar', error: e.message };
  }
}

module.exports = {
  migrar, activo, saldo, bloquear, cobrarGeneracion, reembolsar, cobrarIa, puedeGastarIa, exento, movimientos, gastoDelMes,
  solicitar, solicitudes, pendientes, aprobar, rechazar, resolverRevision, fijarSaldo, enviarAJh, SaldoMarketingError, CLASES_IA, _probar,
};
