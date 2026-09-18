/**
 * Billetera de creditos de JH dentro del panel. El saldo es la suma de los
 * movimientos. Cada generacion de un usuario (no super_admin) descuenta sus
 * creditos al encolarse; si falla, el worker los devuelve (una sola vez).
 */
const { pool } = require('./db');

async function saldo(cliente = pool) {
  const { rows: [r] } = await cliente.query('SELECT COALESCE(SUM(creditos), 0) AS s FROM billetera');
  return Number(r.s);
}

// Cobra una generacion dentro de una transaccion ya abierta. Bloquea la tabla
// para que dos generaciones simultaneas no gasten el mismo saldo.
async function cobrar(cliente, { generacionId, creditos, usd, por }) {
  await cliente.query('LOCK TABLE billetera IN SHARE ROW EXCLUSIVE MODE');
  const s = await saldo(cliente);
  if (s < creditos) {
    const e = new Error(`Saldo insuficiente: tienes ${Math.floor(s * 10) / 10} créditos y esta generación usa ${creditos}.`);
    e.saldo = true;
    throw e;
  }
  await cliente.query(
    `INSERT INTO billetera (tipo, creditos, usd, generacion_id, por, nota) VALUES ('consumo', $1, $2, $3, $4, 'Generación')`,
    [-creditos, usd, generacionId, por]
  );
}

// Devuelve lo cobrado por una generacion fallida (idempotente).
async function reembolsar(generacionId) {
  const r = await pool.query(
    `INSERT INTO billetera (tipo, creditos, usd, generacion_id, por, nota)
     SELECT 'reembolso', -creditos, -usd, generacion_id, 'sistema', 'Generación fallida'
     FROM billetera WHERE generacion_id = $1 AND tipo = 'consumo'
     ON CONFLICT DO NOTHING RETURNING creditos`,
    [generacionId]
  );
  return r.rowCount ? Number(r.rows[0].creditos) : 0;
}

async function recargaManual({ creditos, usd, nota, por }) {
  const { rows: [m] } = await pool.query(
    `INSERT INTO billetera (tipo, creditos, usd, nota, por) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [creditos >= 0 ? 'recarga' : 'ajuste', creditos, usd ?? null, nota || null, por]
  );
  return m;
}

async function movimientos(limite = 50) {
  const { rows } = await pool.query(
    `SELECT b.id, b.tipo, b.creditos, b.usd, b.nota, b.por, b.creado, b.generacion_id, g.preset_nombre
     FROM billetera b LEFT JOIN generaciones g ON g.id = b.generacion_id ORDER BY b.id DESC LIMIT $1`, [limite]
  );
  return rows;
}

module.exports = { saldo, cobrar, reembolsar, recargaManual, movimientos };
