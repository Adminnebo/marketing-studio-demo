// Saldo de Marketing contra Postgres real (TEST_DATABASE_URL); se salta si no esta.
const test = require('node:test');
const assert = require('node:assert/strict');
const costosIa = require('../server/lib/costos-ia');

test('costos de IA por modelo y tokens', () => {
  assert.equal(costosIa.costoUsd('gpt-4.1-mini-2025-04-14', 1e6, 1e6), 2.0);
  assert.equal(costosIa.costoUsd('gpt-4.1', 5014, 288), 0.012332);
  assert.equal(costosIa.costoUsd('modelo-raro', 1e6, 0), 2.0); // desconocido: el mas caro
});

if (!process.env.TEST_DATABASE_URL) {
  test('saldo de Marketing (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  const sm = require('../server/lib/saldo-marketing');
  const ajustes = require('../server/lib/config');
  const gen = () => pool.query(`INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada) VALUES ('yo@x','p','ads','{}') RETURNING id`).then((r) => r.rows[0].id);
  const cobrar = async (id, usd, por = 'yo@x') => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await sm.bloquear(c); await sm.cobrarGeneracion(c, { generacionId: id, usd, por, concepto: 'Prueba' }); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  const ajustados = [];

  test.before(async () => {
    await migrar(); await sm.migrar();
    await pool.query('TRUNCATE saldo_marketing, solicitudes_recarga, pagos_eventos, billetera, publicaciones, generaciones RESTART IDENTITY CASCADE');
    await ajustes.guardar({ margen_pct: 20 }).catch(() => pool.query(`INSERT INTO config (clave, valor) VALUES ('margen_pct', '20') ON CONFLICT (clave) DO UPDATE SET valor = '20'`));
    sm._probar({ activo: true, resumen: async () => ({ saldoUsd: 100, disponibleUsd: 100, pendienteUsd: 0 }), ajustar: async (a) => { ajustados.push(a); return { success: true, id: 'aj-' + ajustados.length }; } });
  });
  test.after(async () => { sm._probar(); await pool.end(); });

  test('solicitud aprobada: se descuenta una vez del saldo general y entra al de Marketing', async () => {
    const s = await sm.solicitar({ montoUsd: 25, motivo: 'Campaña de octubre', por: 'yo@x' });
    assert.equal(s.estado, 'pendiente');
    assert.equal(await sm.pendientes(), 1);
    assert.deepEqual(await sm.aprobar(s.id, { por: 'jefe@x' }), { estado: 'aprobada' });
    assert.equal(ajustados.length, 1);
    assert.equal(ajustados[0].amount, 25);
    assert.match(ajustados[0].note, /solicitud mkt-rec-1 · pedida por yo@x · aprobada por jefe@x/);
    assert.equal(await sm.saldo(), 25);
    await assert.rejects(sm.aprobar(s.id, { por: 'jefe@x' }), /ya se resolvió/); // no se aprueba dos veces
    assert.equal(ajustados.length, 1);
  });

  test('montos fuera de rango y saldo general insuficiente', async () => {
    await assert.rejects(sm.solicitar({ montoUsd: 0.5, por: 'yo@x' }), /entre \$1 y \$5,000/);
    const s = await sm.solicitar({ montoUsd: 500, por: 'yo@x' });
    await assert.rejects(sm.aprobar(s.id, { por: 'jefe@x' }), /no alcanza/);
    await sm.rechazar(s.id, { por: 'jefe@x', nota: 'Muy alto' });
  });

  test('si la plataforma no recibio el pedido sigue pendiente; si es incierto queda en revision', async () => {
    const s1 = await sm.solicitar({ montoUsd: 10, por: 'yo@x' });
    sm._probar({ activo: true, resumen: async () => ({ disponibleUsd: 100 }), ajustar: async () => { throw Object.assign(new Error('ECONNREFUSED'), { seguro: true }); } });
    await assert.rejects(sm.aprobar(s1.id, { por: 'jefe@x' }), /no se descontó nada/);
    assert.equal((await pool.query('SELECT estado FROM solicitudes_recarga WHERE id = $1', [s1.id])).rows[0].estado, 'pendiente');
    sm._probar({ activo: true, resumen: async () => ({ disponibleUsd: 100 }), ajustar: async () => { throw new Error('HTTP 504'); } });
    assert.equal((await sm.aprobar(s1.id, { por: 'jefe@x' })).estado, 'revisar');
    assert.equal(await sm.saldo(), 25); // no se acredito
    assert.deepEqual(await sm.resolverRevision(s1.id, { por: 'jefe@x', aplicada: true }), { estado: 'aprobada' });
    assert.equal(await sm.saldo(), 35);
  });

  test('creacion: cobra, se lleva la IA previa del usuario y se devuelve una sola vez', async () => {
    const ia = await sm.cobrarIa({ por: 'yo@x', clase: 'descripcion', modelo: 'gpt-4.1', entrada: 5000, salida: 300 }); // 0.0124 * 1.2
    assert.equal(ia, 0.0149);
    assert.equal(await sm.cobrarIa({ por: 'yo@x', clase: 'ficha', costoUsd: 0.002, ref: 'ficha:15' }), 0.0024);
    assert.equal(await sm.cobrarIa({ por: 'yo@x', clase: 'ficha', costoUsd: 0.002, ref: 'ficha:15' }), 0); // una sola vez
    const g = await gen();
    await cobrar(g, 5);
    const { rows: [t] } = await pool.query(`SELECT COALESCE(-SUM(usd), 0) AS ia FROM saldo_marketing WHERE generacion_id = $1 AND tipo = 'ia'`, [g]);
    assert.equal(Number(t.ia), 0.0173); // el total de la creacion incluye la IA
    assert.equal(await sm.saldo(), 29.9827);
    assert.equal(await sm.reembolsar(g), 5);
    assert.equal(await sm.reembolsar(g), 0);
    assert.equal(await sm.saldo(), 34.9827);
    const m = await sm.movimientos();
    assert.deepEqual(m.slice(0, 2).map((x) => x.tipo), ['reembolso', 'consumo']);
  });

  test('cobros simultaneos no gastan la misma plata', async () => {
    const [a, b] = [await gen(), await gen()];
    const c1 = await pool.connect(); const c2 = await pool.connect();
    await c1.query('BEGIN'); await sm.bloquear(c1);
    await c2.query('BEGIN');
    const p2 = sm.bloquear(c2).then(() => sm.saldo(c2));
    await sm.cobrarGeneracion(c1, { generacionId: a, usd: 30, por: 'yo@x' });
    await c1.query('COMMIT'); c1.release();
    assert.equal(await p2, 4.9827); // el segundo ve el saldo ya descontado
    await c2.query('ROLLBACK'); c2.release();
  });

  test('super admin no gasta del saldo; sin saldo no se usa la IA', async () => {
    assert.equal(await sm.puedeGastarIa({ rolReal: 'super_admin' }), true);
    assert.equal(sm.exento({ rolReal: 'super_admin' }), true);
    await pool.query(`INSERT INTO saldo_marketing (tipo, usd, por) VALUES ('ajuste', -10, 'prueba')`);
    assert.equal(await sm.puedeGastarIa({ rolReal: 'usuario' }), false);
  });

  test('lo pagado con el saldo de Marketing no se vuelve a informar a la plataforma de pagos', async () => {
    const pagos = require('../server/lib/pagos');
    const g = await gen();
    await pool.query(`UPDATE generaciones SET estado = 'completado', precio_usd = 3, cobro_interno = true WHERE id = $1`, [g]);
    const h = await pagos.historialSinInformar();
    assert.ok(!h.items.some((x) => x.id === Number(g)));
  });
}
