// Resumen de gasto para cobrar a mano (lib/resumen-gasto.js). Con plata de verdad en juego,
// lo que importa es que NO cuente dos veces y que separe lo ya cobrado de lo que falta.
const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.TEST_DATABASE_URL) {
  test('resumen de gasto (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const { pool, migrar } = require('../server/lib/db');
  const saldoMarketing = require('../server/lib/saldo-marketing');
  const resumenGasto = require('../server/lib/resumen-gasto');

  const DESDE = '2026-09-22T00:00:00Z';
  const HASTA = '2026-09-24T00:00:00Z';
  const mov = (tipo, usd, extra = {}) => pool.query(
    `INSERT INTO saldo_marketing (tipo, usd, por, ref, a_jh, lote_id, creado) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tipo, usd, extra.por || 'vendedor@jh.com', extra.ref || null, !!extra.aJh, extra.lote || null, extra.creado || '2026-09-22T15:00:00Z']
  );

  test.before(async () => {
    await migrar();
    await saldoMarketing.migrar();
    await pool.query('TRUNCATE wallet_debitos, saldo_marketing, lotes_jh, generaciones RESTART IDENTITY CASCADE');

    // Equipo: dos creaciones y dos ayudas de IA, una creación devuelta.
    await mov('recarga', 20, { por: 'jorge@nebo.com' });
    await mov('consumo', -8);
    await mov('consumo', -5, { ref: 'gen:99:consumo' });
    await mov('reembolso', 5, { ref: 'gen:99:reembolso' });      // esa no salió: se devolvió
    await mov('ia', -0.5);
    await mov('ia', -0.25, { por: 'otra@jh.com' });
    // Saldo puesto a mano (no salió del saldo general).
    await mov('ajuste', 3, { por: 'jorge@nebo.com' });
    // IA de super admins: un lote ya enviado y otra suelta sin enviar.
    const { rows: [l] } = await pool.query(`INSERT INTO lotes_jh (usd, estado, enviado) VALUES (1.5, 'enviado', now()) RETURNING id`);
    await mov('ia', -1.5, { aJh: true, lote: l.id, por: 'jorge@nebo.com' });
    await mov('ia', -0.75, { aJh: true, por: 'jorge@nebo.com' });
    // Creaciones de super admin (no se cobran al saldo de Marketing): una informada y una no.
    await pool.query(
      `INSERT INTO generaciones (creado_por, preset_id, preset_tipo, entrada, estado, precio_usd, terminado, gasto_informado, cobro_interno)
       VALUES ('jorge@nebo.com','veo3','libre_video','{}','completado', 4, '2026-09-22T16:00:00Z', now(), false),
              ('jorge@nebo.com','veo3','libre_video','{}','completado', 2.5, '2026-09-22T17:00:00Z', NULL, false),
              ('vendedor@jh.com','veo3','libre_video','{}','completado', 8, '2026-09-22T15:00:00Z', NULL, true)`
    );
    // Lo que ya debitó el wallet nuevo (no se vuelve a cobrar).
    await pool.query(`INSERT INTO wallet_debitos (referencia, usd, descripcion, estado, hecho) VALUES ('mkt-gen-500', 1.2, 'x', 'hecho', now())`);
    await pool.query(`INSERT INTO wallet_debitos (referencia, usd, descripcion, estado) VALUES ('mkt-ia-501', 0.3, 'y', 'pendiente')`);
  });
  test.after(async () => { await pool.end(); });

  test('separa el gasto del equipo, lo ya cobrado y lo que falta', async () => {
    const r = await resumenGasto.resumen({ desde: DESDE, hasta: HASTA });
    // Equipo: 8 + 5 de creaciones, menos 5 devueltos, más 0.75 de IA.
    assert.equal(r.equipo.creaciones, 13);
    assert.equal(r.equipo.nCreaciones, 2);
    assert.equal(r.equipo.devuelto, 5);
    assert.equal(r.equipo.ia, 0.75);
    assert.equal(r.equipo.total, 8.75, '13 + 0.75 - 5');
    assert.equal(r.equipo.recargas, 20);
    assert.equal(r.equipo.ajustes, 3);
    // El equipo gastó 8.75 y se le recargaron 20: nada pendiente y sobran 11.25.
    assert.equal(r.cargo.equipoPendiente, 0);
    assert.equal(r.cargo.sobraRecargado, 11.25);
    // IA de super admins: 1.5 enviada, 0.75 sin enviar.
    assert.deepEqual([r.superIa.enviado, r.superIa.pendiente], [1.5, 0.75]);
    // Creaciones de super admin: 4 informada, 2.5 sin informar (la del vendedor no cuenta aquí).
    assert.deepEqual([r.superGen.informado, r.superGen.sinInformar], [4, 2.5]);
    assert.equal(r.superGen.n, 2, 'las cobradas al saldo de Marketing no entran en este bloque');
    // Total a cobrar a mano: 0 + 0.75 + 2.5.
    assert.equal(r.cargo.porCobrar, 3.25);
    assert.equal(r.cargo.porCobrarRedondeado, 3.25);
    // Y el wallet nuevo aparte, para no cobrarlo de nuevo.
    assert.deepEqual([r.wallet.hecho, r.wallet.enCola], [1.2, 0.3]);
  });

  test('cuando se gasta más de lo recargado, la diferencia queda por cobrar', async () => {
    await mov('consumo', -30, { creado: '2026-09-23T10:00:00Z' });
    const r = await resumenGasto.resumen({ desde: DESDE, hasta: HASTA });
    assert.equal(r.equipo.total, 38.75);
    assert.equal(r.cargo.equipoPendiente, 18.75, '38.75 gastados menos 20 recargados');
    assert.equal(r.cargo.sobraRecargado, 0);
    assert.equal(r.cargo.porCobrar, 22, '18.75 + 0.75 + 2.5');
  });

  test('por usuario y por día, y el texto para pegar', async () => {
    const r = await resumenGasto.resumen({ desde: DESDE, hasta: HASTA });
    const v = r.porUsuario.find((x) => x.por === 'vendedor@jh.com');
    assert.equal(v.gasto, 43.5, '8 + 5 + 30 de creaciones más 0.5 de IA');
    assert.equal(v.creaciones, 3);
    assert.ok(r.porUsuario.some((x) => x.por === 'otra@jh.com'));
    assert.deepEqual(r.porDia.map((x) => x.dia), ['2026-09-22', '2026-09-23']);
    const t = resumenGasto.texto(r);
    assert.match(t, /RESUMEN DE GASTO DE MARKETING/);
    assert.match(t, /POR COBRAR A MANO: \$22\.00/);
    assert.match(t, /saldo se puso a mano/);
    assert.match(t, /vendedor@jh\.com/);
  });

  test('un rango inválido se rechaza en vez de dar un número raro', async () => {
    await assert.rejects(() => resumenGasto.resumen({ desde: HASTA, hasta: DESDE }), /Rango de fechas inválido/);
    await assert.rejects(() => resumenGasto.resumen({ desde: 'x', hasta: 'y' }), /Rango de fechas inválido/);
  });
}
