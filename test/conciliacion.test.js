// Conciliacion de costos: emparejar creaciones con gastos de Higgsfield, y Camila sin costo de n8n.
const test = require('node:test');
const assert = require('node:assert/strict');

const t = (min) => new Date(Date.parse('2026-09-22T14:00:00Z') + min * 60e3);

test('empareja por hora y creditos; separa lo que no salio del panel', () => {
  const { emparejar } = require('../server/lib/conciliacion');
  const gens = [
    { id: 1, enviado: t(0), creditos_estimados: 7.5 },
    { id: 2, enviado: t(1), creditos_estimados: 1.5 },
    { id: 3, enviado: t(60), creditos_estimados: 10 }, // sin gasto cerca
  ];
  const txs = [
    { tipo: 'spend', creditos: -1.5, hora: t(1.2) },
    { tipo: 'spend', creditos: -7.5, hora: t(0.5) },
    { tipo: 'spend', creditos: -35, hora: t(30) }, // fuera del panel
    { tipo: 'refund', creditos: 7.5, hora: t(5) },
  ];
  const r = emparejar(gens, txs);
  assert.deepEqual(r.pares.map((p) => [p.g.id, -p.t.creditos]), [[1, 7.5], [2, 1.5]]);
  assert.deepEqual(r.sinGasto.map((g) => g.id), [3]);
  assert.deepEqual(r.fuera.map((x) => -x.creditos), [35]);
});

test('lee todas las paginas de movimientos hasta la fecha pedida', async () => {
  const { transaccionesDesde } = require('../server/lib/conciliacion');
  const paginas = [
    { items: [{ display_name: 'A', credits: -1, action: 'spend', created_at: t(10).toISOString() }], next_cursor: 1 },
    { items: [{ display_name: 'B', credits: -2, action: 'spend', created_at: t(5).toISOString() }, { display_name: 'C', credits: -3, action: 'spend', created_at: t(-10).toISOString() }], next_cursor: 3 },
  ];
  const llamadas = [];
  const r = await transaccionesDesde(t(0), async (h, a) => { llamadas.push(a); return paginas[llamadas.length - 1]; });
  assert.deepEqual(r.map((x) => x.nombre), ['A', 'B']);
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[1].cursor, 1);
});

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  test('Camila sin costo de n8n: se cobra estimado una vez; si llega el real despues no se duplica', async () => {
    const { pool, migrar } = require('../server/lib/db');
    const camila = require('../server/lib/camila');
    const sm = require('../server/lib/saldo-marketing');
    const conc = require('../server/lib/conciliacion');
    await migrar(); await camila.migrar(); await sm.migrar(); await conc.migrar();
    sm._probar({ activo: true });
    process.env.CONCILIAR_CAMILA_DESDE = '2020-01-01T00:00:00Z';
    await pool.query('TRUNCATE saldo_marketing, camila_usos, camila_mensajes, camila_conversaciones, conciliaciones RESTART IDENTITY CASCADE');
    const { rows: [c] } = await pool.query(`INSERT INTO camila_conversaciones (email, titulo) VALUES ('ana@jh.do', 'x') RETURNING id`);
    const msj = (ej, hace) => pool.query(`INSERT INTO camila_mensajes (conversacion_id, rol, texto, n8n_ejecucion, creado) VALUES ($1, 'camila', 'hola', $2, now() - $3::interval)`, [c.id, ej, hace]);
    await msj('900', '2 hours'); // sin cobro: se estima
    await msj('901', '2 hours'); // con cobro real
    await msj('902', '5 minutes'); // todavia dentro del margen de espera
    await sm.cobrarIa({ por: 'ana@jh.do', clase: 'camila', costoUsd: 0.006, ref: 'camila:901' });
    const r = await conc.conciliarCamila({});
    assert.equal(r.faltantes, 1);
    assert.equal(r.cobrados, 1);
    assert.deepEqual(r.ejecuciones, ['900']);
    assert.equal(await sm.cobrarIa({ por: 'ana@jh.do', clase: 'camila', costoUsd: 0.006, ref: 'camila:900' }), 0); // el real tardio no cobra de nuevo
    assert.equal((await conc.conciliarCamila({})).faltantes, 0);
    // Higgsfield de punta a punta con movimientos simulados
    const { rows: [g] } = await pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, preset_nombre, entrada, estado, creditos_estimados, enviado)
      VALUES ('ana@jh.do', 'p', 'poster', 'Anuncio', '{}', 'completado', 7.5, now() - interval '1 hour') RETURNING id, enviado`);
    const h = await conc.conciliarHiggsfield({ llamar: async () => ({ items: [
      { display_name: 'Marketing Studio Image', credits: -9, action: 'spend', created_at: new Date(new Date(g.enviado).getTime() + 30e3).toISOString() },
      { display_name: 'Otra cosa', credits: -2, action: 'spend', created_at: new Date(Date.now() - 20 * 60e3).toISOString() },
    ], next_cursor: null }) });
    assert.equal(h.emparejadas, 1);
    assert.deepEqual(h.diferencias.map((x) => [x.estimado, x.real]), [[7.5, 9]]);
    assert.equal(h.fueraDelPanel.creditos, 2);
    const u = await conc.ultimas();
    assert.equal(u.higgsfield.emparejadas, 1);
    assert.equal(u.camilaEstimadasTotal.n, 1);
    sm._probar();
    await pool.end();
  });
}
