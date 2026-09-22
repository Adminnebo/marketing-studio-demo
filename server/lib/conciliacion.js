/**
 * Conciliacion: compara lo que el panel registro contra lo que de verdad se gasto afuera.
 *
 * 1) Camila: cada respuesta de Camila (camila_mensajes.n8n_ejecucion) tiene que tener su cobro
 *    (saldo_marketing ref 'camila:<ejecucion>', que manda el flujo de costos de n8n). Si a los 30 min
 *    no llego, se cobra un costo ESTIMADO (promedio de las ultimas busquedas reales) con esa misma ref:
 *    si el costo real llega despues, no se cobra dos veces.
 * 2) Higgsfield: los movimientos de creditos de la cuenta (herramienta 'transactions' del MCP: nombre,
 *    creditos, tipo y hora, sin id de trabajo) se emparejan por hora con las creaciones del panel.
 *    Resultado: creditos estimados vs reales, creaciones sin gasto en Higgsfield y gasto de la cuenta
 *    que no salio del panel. Solo informa (no cobra): el emparejamiento es por hora, no por id.
 */
const { pool } = require('./db');
const saldoMarketing = require('./saldo-marketing');

const MIGRACIONES = [
  `CREATE TABLE IF NOT EXISTS conciliaciones (
     id BIGSERIAL PRIMARY KEY,
     tipo TEXT NOT NULL,
     datos JSONB NOT NULL,
     creado TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS conciliaciones_tipo_idx ON conciliaciones (tipo, id DESC)`,
];
let _migrado = null;
function migrar() {
  _migrado ||= (async () => { for (const sql of MIGRACIONES) await pool.query(sql); })();
  return _migrado;
}

// Antes de esta hora las busquedas se cobraban aparte en Sword: no se concilian (no se cobra dos veces).
const CORTE_CAMILA = () => process.env.CONCILIAR_CAMILA_DESDE || '2026-09-22T15:05:00Z';
const COSTO_CAMILA_DEFECTO = 0.005;

async function costoCamilaEstimado() {
  const { rows: [r] } = await pool.query(
    `SELECT AVG((datos->>'costo_usd')::numeric) AS p, COUNT(*)::int AS n FROM (
       SELECT datos FROM saldo_marketing WHERE datos->>'clase' = 'camila' AND concepto NOT LIKE '%estimado%' ORDER BY id DESC LIMIT 50) x`
  );
  return r.n >= 3 ? Math.round(Number(r.p) * 1e6) / 1e6 : COSTO_CAMILA_DEFECTO;
}

async function conciliarCamila({ graciaMin = 30, esSuperAdmin = async () => false } = {}) {
  await migrar();
  const { rows } = await pool.query(
    `SELECT m.id, m.n8n_ejecucion, c.email FROM camila_mensajes m JOIN camila_conversaciones c ON c.id = m.conversacion_id
     WHERE m.rol = 'camila' AND m.n8n_ejecucion IS NOT NULL AND m.creado > $1::timestamptz AND m.creado < now() - ($2 || ' minutes')::interval
       AND NOT EXISTS (SELECT 1 FROM saldo_marketing s WHERE s.ref = 'camila:' || m.n8n_ejecucion)
     ORDER BY m.id LIMIT 200`, [CORTE_CAMILA(), String(graciaMin)]
  );
  if (!rows.length) return { faltantes: 0, cobrados: 0, usd: 0 };
  const costo = await costoCamilaEstimado();
  let cobrados = 0; let usd = 0;
  for (const m of rows) {
    const c = await saldoMarketing.cobrarIa({ por: m.email, clase: 'camila', costoUsd: costo, ref: `camila:${m.n8n_ejecucion}`,
      detalle: 'estimado (no llegó el costo de n8n)', aJh: await esSuperAdmin(m.email) });
    if (c > 0) { cobrados++; usd += c; }
  }
  const r = { faltantes: rows.length, cobrados, usd: Math.round(usd * 1e4) / 1e4, costoEstimado: costo, ejecuciones: rows.map((m) => m.n8n_ejecucion).slice(0, 50) };
  await pool.query(`INSERT INTO conciliaciones (tipo, datos) VALUES ('camila', $1)`, [JSON.stringify(r)]);
  return r;
}

// Movimientos de creditos de Higgsfield desde `desde` (paginado, lo mas nuevo primero).
async function transaccionesDesde(desde, llamar) {
  const out = [];
  let cursor;
  for (let pag = 0; pag < 30; pag++) {
    const d = await llamar('transactions', { size: 100, ...(cursor != null ? { cursor } : {}) });
    const items = d?.items || [];
    for (const t of items) {
      const hora = new Date(t.created_at);
      if (hora < desde) return out;
      out.push({ nombre: t.display_name, creditos: Number(t.credits), tipo: t.action, hora });
    }
    if (d?.next_cursor == null || !items.length) break;
    cursor = d.next_cursor;
  }
  return out;
}

/**
 * Empareja creaciones (enviadas desde `desde`) con gastos de Higgsfield: a cada creacion le toca el gasto
 * libre mas cercano entre 2 min antes y 15 min despues de enviarla (prefiriendo el de creditos iguales).
 */
function emparejar(gens, txs) {
  const gastos = txs.filter((t) => t.tipo === 'spend').map((t) => ({ ...t, usado: false }));
  const pares = []; const sinGasto = [];
  for (const g of [...gens].sort((a, b) => new Date(a.enviado) - new Date(b.enviado))) {
    const t0 = new Date(g.enviado).getTime();
    const est = Number(g.creditos_estimados) || 0;
    let mejor = null; let puntaje = Infinity;
    for (const t of gastos) {
      if (t.usado) continue;
      const dt = t.hora.getTime() - t0;
      if (dt < -2 * 60e3 || dt > 15 * 60e3) continue;
      const p = Math.abs(dt) / 60e3 + (Math.abs(-t.creditos - est) < 0.01 ? 0 : 5);
      if (p < puntaje) { puntaje = p; mejor = t; }
    }
    if (mejor) { mejor.usado = true; pares.push({ g, t: mejor }); } else sinGasto.push(g);
  }
  return { pares, sinGasto, fuera: gastos.filter((t) => !t.usado) };
}

async function conciliarHiggsfield({ horas = 24, llamar } = {}) {
  await migrar();
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - horas * 3600e3);
  const txs = await transaccionesDesde(desde, llamar);
  const { rows: gens } = await pool.query(
    `SELECT id, preset_nombre, creditos_estimados, enviado, estado, creado_por FROM generaciones
     WHERE enviado IS NOT NULL AND enviado >= $1 AND enviado < $2 - interval '15 minutes' ORDER BY enviado`, [desde, hasta]
  );
  const { pares, sinGasto, fuera } = emparejar(gens, txs);
  const suma = (l, f) => Math.round(l.reduce((a, x) => a + f(x), 0) * 100) / 100;
  const diferencias = pares.filter(({ g, t }) => Math.abs(-t.creditos - Number(g.creditos_estimados || 0)) >= 0.01)
    .map(({ g, t }) => ({ id: Number(g.id), nombre: g.preset_nombre, por: g.creado_por, estimado: Number(g.creditos_estimados), real: -t.creditos }));
  const r = {
    desde, hasta,
    higgsfield: { gastado: suma(txs.filter((t) => t.tipo === 'spend'), (t) => -t.creditos), devuelto: suma(txs.filter((t) => t.tipo === 'refund'), (t) => t.creditos), movimientos: txs.length },
    panel: { creaciones: gens.length, estimado: suma(gens, (g) => Number(g.creditos_estimados) || 0) },
    emparejadas: pares.length,
    diferencias,
    diferenciaCreditos: suma(diferencias, (d) => d.real - d.estimado),
    sinGasto: sinGasto.map((g) => ({ id: Number(g.id), nombre: g.preset_nombre, estado: g.estado, estimado: Number(g.creditos_estimados) })),
    fueraDelPanel: { n: fuera.length, creditos: suma(fuera, (t) => -t.creditos), muestras: fuera.slice(0, 15).map((t) => ({ nombre: t.nombre, creditos: -t.creditos, hora: t.hora })) },
  };
  await pool.query(`INSERT INTO conciliaciones (tipo, datos) VALUES ('higgsfield', $1)`, [JSON.stringify(r)]);
  return r;
}

async function ultimas() {
  await migrar();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (tipo) tipo, datos, creado FROM conciliaciones ORDER BY tipo, id DESC`
  );
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(-SUM(usd), 0) AS usd FROM saldo_marketing WHERE datos->>'clase' = 'camila' AND concepto LIKE '%estimado%'`
  );
  return { ...Object.fromEntries(rows.map((r) => [r.tipo, { ...r.datos, corrida: r.creado }])), camilaEstimadasTotal: { n: c.n, usd: Number(c.usd) } };
}

module.exports = { migrar, conciliarCamila, conciliarHiggsfield, emparejar, transaccionesDesde, ultimas, CORTE_CAMILA };
