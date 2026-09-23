/**
 * Resumen de gasto de un periodo, para cobrarlo a mano en la cuenta principal.
 *
 * Nace de un caso concreto: entre el 2026-09-22 (cuando el costo empezo a manejarse del lado de
 * Marketing, con saldo propio y recargas por solicitud) y el 2026-09-23 (cuando el gasto paso a
 * debitarse del wallet en la plataforma central), hubo consumo que hay que cobrar a mano.
 *
 * La pregunta que responde: de lo que gasto Marketing en este periodo, cuanto YA se cobro a la
 * cuenta principal y cuanto falta. Las piezas:
 *
 *  - Gasto del equipo: filas 'consumo' (creaciones) e 'ia' del registro de Marketing, netas de
 *    'reembolso'. Se pagaron con las recargas aprobadas, y cada recarga aprobada SI se descontó
 *    del saldo general en su momento. Lo que se gasto por encima de lo recargado es lo que falta.
 *  - Saldo puesto a mano ('ajuste', "fijar saldo"): entro al saldo de Marketing sin salir de
 *    ningun lado, asi que todo lo que cubrio esta sin cobrar.
 *  - Gasto de super admins y del sistema: sus creaciones se informan al saldo general por la cola
 *    de pagos (gasto_informado) y su IA va por lotes (lotes_jh). Lo enviado esta cobrado; el resto no.
 *  - Lo que ya debito el wallet nuevo (wallet_debitos en 'hecho') no se vuelve a cobrar nunca.
 *
 * Todo lo que devuelve es de solo lectura: este modulo no mueve plata.
 */
const { pool } = require('./db');

const r4 = (n) => Math.round(Number(n || 0) * 10000) / 10000;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Resumen del periodo [desde, hasta). Devuelve montos en USD. */
async function resumen({ desde, hasta } = {}) {
  const d = desde ? new Date(desde) : new Date(Date.now() - 30 * 864e5);
  const h = hasta ? new Date(hasta) : new Date();
  if (Number.isNaN(+d) || Number.isNaN(+h) || h <= d) throw Object.assign(new Error('Rango de fechas inválido.'), { status: 400 });
  const p = [d, h];

  // Registro de Marketing: lo que gasto el equipo y con que se financio.
  const { rows: [m] } = await pool.query(
    `SELECT
       COALESCE(-SUM(usd) FILTER (WHERE tipo = 'consumo' AND NOT a_jh), 0) AS creaciones,
       COUNT(*) FILTER (WHERE tipo = 'consumo' AND NOT a_jh)               AS n_creaciones,
       COALESCE(-SUM(usd) FILTER (WHERE tipo = 'ia' AND NOT a_jh), 0)      AS ia,
       COUNT(*) FILTER (WHERE tipo = 'ia' AND NOT a_jh)                    AS n_ia,
       COALESCE(SUM(usd) FILTER (WHERE tipo = 'reembolso'), 0)             AS devuelto,
       COALESCE(SUM(usd) FILTER (WHERE tipo = 'recarga'), 0)               AS recargas,
       COUNT(*) FILTER (WHERE tipo = 'recarga')                            AS n_recargas,
       COALESCE(SUM(usd) FILTER (WHERE tipo = 'ajuste'), 0)                AS ajustes,
       COUNT(*) FILTER (WHERE tipo = 'ajuste')                             AS n_ajustes
     FROM saldo_marketing WHERE creado >= $1 AND creado < $2`, p
  );
  // 'reembolso' se guarda con el signo del consumo devuelto (negativo del negativo): se normaliza aca.
  const devuelto = Math.abs(r4(m.devuelto));
  const equipo = {
    creaciones: r4(m.creaciones), nCreaciones: Number(m.n_creaciones),
    ia: r4(m.ia), nIa: Number(m.n_ia), devuelto,
    total: r4(Number(m.creaciones) + Number(m.ia) - devuelto),
    recargas: r4(m.recargas), nRecargas: Number(m.n_recargas),
    ajustes: r4(m.ajustes), nAjustes: Number(m.n_ajustes),
  };

  // IA de super admins y del sistema: va al saldo general por lotes.
  const { rows: [j] } = await pool.query(
    `SELECT COALESCE(-SUM(s.usd), 0) AS total, COUNT(*) AS n,
            COALESCE(-SUM(s.usd) FILTER (WHERE l.estado = 'enviado'), 0) AS enviado,
            COALESCE(-SUM(s.usd) FILTER (WHERE l.estado IS DISTINCT FROM 'enviado'), 0) AS pendiente
     FROM saldo_marketing s LEFT JOIN lotes_jh l ON l.id = s.lote_id
     WHERE s.a_jh AND s.creado >= $1 AND s.creado < $2`, p
  );
  const superIa = { total: r4(j.total), n: Number(j.n), enviado: r4(j.enviado), pendiente: r4(j.pendiente) };

  // Creaciones que NO se cobraron al saldo de Marketing (las de super admins): se informan aparte.
  const { rows: [g] } = await pool.query(
    `SELECT COALESCE(SUM(precio_usd), 0) AS total, COUNT(*) AS n,
            COALESCE(SUM(precio_usd) FILTER (WHERE gasto_informado IS NOT NULL), 0) AS informado,
            COUNT(*) FILTER (WHERE gasto_informado IS NOT NULL) AS n_informado,
            COALESCE(SUM(precio_usd) FILTER (WHERE gasto_informado IS NULL), 0) AS sin_informar,
            COUNT(*) FILTER (WHERE gasto_informado IS NULL) AS n_sin_informar
     FROM generaciones
     WHERE estado = 'completado' AND precio_usd > 0 AND NOT cobro_interno
       AND terminado >= $1 AND terminado < $2`, p
  );
  const superGen = {
    total: r4(g.total), n: Number(g.n),
    informado: r4(g.informado), nInformado: Number(g.n_informado),
    sinInformar: r4(g.sin_informar), nSinInformar: Number(g.n_sin_informar),
  };

  // Lo que ya debito el wallet nuevo: no se cobra otra vez.
  const { rows: [w] } = await pool.query(
    `SELECT COALESCE(SUM(usd) FILTER (WHERE estado = 'hecho'), 0) AS hecho,
            COUNT(*) FILTER (WHERE estado = 'hecho') AS n_hecho,
            COALESCE(SUM(usd) FILTER (WHERE estado <> 'hecho'), 0) AS en_cola,
            COUNT(*) FILTER (WHERE estado <> 'hecho') AS n_en_cola
     FROM wallet_debitos WHERE creado >= $1 AND creado < $2`, p
  );
  const walletMkt = { hecho: r4(w.hecho), nHecho: Number(w.n_hecho), enCola: r4(w.en_cola), nEnCola: Number(w.n_en_cola) };

  // Quien gasto (para repartir el cargo si hace falta).
  const { rows: porUsuario } = await pool.query(
    `SELECT por, COALESCE(-SUM(usd) FILTER (WHERE tipo IN ('consumo', 'ia')), 0) AS gasto,
            COALESCE(-SUM(usd) FILTER (WHERE tipo = 'ia'), 0) AS ia,
            COUNT(*) FILTER (WHERE tipo = 'consumo') AS creaciones
     FROM saldo_marketing WHERE NOT a_jh AND tipo IN ('consumo', 'ia') AND creado >= $1 AND creado < $2
     GROUP BY por ORDER BY gasto DESC`, p
  );
  const { rows: porDia } = await pool.query(
    `SELECT to_char(creado AT TIME ZONE 'America/Santo_Domingo', 'YYYY-MM-DD') AS dia,
            COALESCE(-SUM(usd) FILTER (WHERE tipo IN ('consumo', 'ia', 'reembolso') AND NOT a_jh), 0) AS gasto
     FROM saldo_marketing WHERE creado >= $1 AND creado < $2
     GROUP BY dia ORDER BY dia`, p
  );

  // Lo que falta cobrar a la cuenta principal.
  const cubierto = r4(equipo.recargas);                     // las recargas SI salieron del saldo general
  const equipoPendiente = r4(Math.max(0, equipo.total - cubierto));
  const sobra = r4(Math.max(0, cubierto - equipo.total));   // recargado y todavia sin gastar
  const porCobrar = r4(equipoPendiente + superIa.pendiente + superGen.sinInformar);

  return {
    periodo: { desde: d.toISOString(), hasta: h.toISOString() },
    equipo, superIa, superGen, wallet: walletMkt,
    porUsuario: porUsuario.map((x) => ({ por: x.por, gasto: r4(x.gasto), ia: r4(x.ia), creaciones: Number(x.creaciones) })),
    porDia: porDia.map((x) => ({ dia: x.dia, gasto: r4(x.gasto) })),
    cargo: {
      cubiertoPorRecargas: cubierto,
      saldoPuestoAMano: equipo.ajustes,
      equipoPendiente,
      superIaPendiente: superIa.pendiente,
      superGenSinInformar: superGen.sinInformar,
      porCobrar,
      porCobrarRedondeado: r2(porCobrar),
      sobraRecargado: sobra,
    },
  };
}

/** El mismo resumen en texto, para pegarlo donde haga falta. */
function texto(r) {
  const $ = (n) => `$${Number(n).toFixed(2)}`;
  const f = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const l = [
    `RESUMEN DE GASTO DE MARKETING`,
    `Del ${f(r.periodo.desde)} al ${f(r.periodo.hasta)}`,
    '',
    `Gasto del equipo: ${$(r.equipo.total)}`,
    `  ${r.equipo.nCreaciones} creación(es): ${$(r.equipo.creaciones)}`,
    `  ${r.equipo.nIa} ayuda(s) de IA: ${$(r.equipo.ia)}`,
    r.equipo.devuelto > 0 ? `  devuelto por creaciones que no salieron: -${$(r.equipo.devuelto)}` : null,
    '',
    `Ya cobrado a la cuenta principal:`,
    `  ${r.equipo.nRecargas} recarga(s) aprobada(s): ${$(r.cargo.cubiertoPorRecargas)}`,
    `  IA de super admins ya enviada: ${$(r.superIa.enviado)}`,
    `  creaciones de super admins informadas (${r.superGen.nInformado}): ${$(r.superGen.informado)}`,
    r.wallet.hecho > 0 ? `  ya debitado del wallet nuevo (${r.wallet.nHecho}): ${$(r.wallet.hecho)}` : null,
    '',
    `POR COBRAR A MANO: ${$(r.cargo.porCobrarRedondeado)}`,
    `  gasto del equipo sin cubrir: ${$(r.cargo.equipoPendiente)}`,
    `  IA de super admins y sistema sin enviar: ${$(r.cargo.superIaPendiente)}`,
    `  creaciones de super admins sin informar (${r.superGen.nSinInformar}): ${$(r.cargo.superGenSinInformar)}`,
    r.cargo.saldoPuestoAMano ? `  (ojo: ${$(r.cargo.saldoPuestoAMano)} de saldo se puso a mano, sin salir del saldo general)` : null,
    r.cargo.sobraRecargado > 0 ? `  (quedan ${$(r.cargo.sobraRecargado)} recargados sin gastar)` : null,
    '',
    `Por usuario:`,
    ...r.porUsuario.map((u) => `  ${u.por}: ${$(u.gasto)} (${u.creaciones} creación/es, ${$(u.ia)} de IA)`),
  ];
  return l.filter((x) => x !== null).join('\n');
}

module.exports = { resumen, texto };
