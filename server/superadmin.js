/**
 * Pestaña Super Admin (solo profiles.role = super_admin):
 *  - ajustes: costo por credito (automatico o manual), % de ganancia, tope diario.
 *  - billetera: recargas manuales de creditos de JH.
 *  - usuarios: dar/quitar acceso a Marketing (usuario / admin) a cualquier usuario de los paneles.
 *  - consumo: generaciones, creditos, costo, precio y ganancia por usuario y mes.
 */
const express = require('express');
const { pool } = require('./lib/db');
const auth = require('./lib/auth');
const ajustes = require('./lib/config');
const hf = require('./lib/higgsfield');
const zernio = require('./lib/zernio');
const billetera = require('./lib/billetera');
const costo = require('./lib/costo');
const hfOauth = require('./lib/hf-oauth');
const catalogo = require('./lib/catalogo');
const clasificar = require('./lib/clasificar');
const promptAuto = require('./lib/prompt-auto');
const hfCli = require('./lib/hf-cli');
const pagos = require('./lib/pagos');
const saldoExterno = require('./lib/saldo-externo');

const router = express.Router();
router.use('/superadmin', auth.requireRol('super_admin'));

const ruta = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error(`[${req.method} ${req.originalUrl}]`, e.message);
    res.status(e.status || 500).json({ error: e.publico ? e.message : 'No se pudo completar. Intenta de nuevo.' });
  }
};
const errPublico = (msg, status = 400) => Object.assign(new Error(msg), { publico: true, status });

router.get('/superadmin/ajustes', ruta(async (req, res) => {
  const [a, saldo, gen, cat, wh, cli] = await Promise.all([
    ajustes.leer(),
    hf.llamar('balance', {}).catch(() => null),
    hf.estadoConexion().catch(() => ({ conectado: false })),
    catalogo.resumen().catch(() => null),
    pool.query(`SELECT valor FROM config WHERE clave = 'zernio_webhook_id'`).then((r) => r.rows[0]?.valor || null).catch(() => null),
    hfCli.estado().catch(() => null),
  ]);
  res.json({
    ajustes: a,
    saldo: saldo ? { creditos: saldo.credits, plan: saldo.subscription_plan_type } : null,
    conexiones: {
      generador: !!gen.conectado, generadorCuenta: gen.cuenta || null, generadorError: gen.error || null,
      redes: zernio.configurado(), webhookListo: zernio.webhookListo(), webhookId: wh,
      promptAuto: promptAuto.configurado(),
      saldoExterno: saldoExterno.configurado(),
      cli: cli && { instalada: cli.instalada, cargada: cli.cargada, ok: cli.cargada && !cli.ultimoError, cuenta: cli.cuenta,
        ultimoUso: cli.ultimoUso, error: cli.ultimoError, desconectada: cli.desconectada },
    },
    catalogo: cat ? { ...cat, clasificadorListo: clasificar.configurado() } : null,
  });
}));

router.put('/superadmin/ajustes', ruta(async (req, res) => {
  try {
    let a = await ajustes.guardar(req.body || {}, req.user.email);
    if (req.body?.costo_auto && Number(req.body.costo_auto) === 1) {
      try { await costo.actualizarCosto(req.user.email); a = await ajustes.leer(); } catch (e) { console.error('[costo]', e.message); }
    }
    res.json({ ajustes: a });
  } catch (e) {
    throw errPublico(e.message);
  }
}));

// Reconectar el generador: devuelve la URL para iniciar sesion con la cuenta de la empresa.
router.post('/superadmin/generador/conectar', ruta(async (req, res) => {
  const base = process.env.PANEL_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: await hfOauth.iniciar({ base, por: req.user.email }) });
}));

// Sesion de la CLI (Cinema Studio 4.0 y otros que el MCP no tiene).
router.post('/superadmin/cli/verificar', ruta(async (req, res) => {
  try { res.json({ ok: true, ...(await hfCli.cuenta()) }); } catch (e) {
    throw errPublico(e.desconectado ? 'La sesión venció o no está cargada: cárgala de nuevo.' : 'No respondió: ' + e.message.slice(0, 200), 502);
  }
}));
router.post('/superadmin/cli/sesion', ruta(async (req, res) => {
  try { await hfCli.guardarSesion(String(req.body?.paquete || ''), { por: req.user.email }); } catch (e) { throw errPublico(e.message); }
  let c;
  try { c = await hfCli.cuenta(); } catch (e) { throw errPublico('Se guardó, pero no funciona: ' + e.message.slice(0, 200), 502); }
  console.log(`[cli] ${req.user.email} cargo la sesion de la CLI (${c.email})`);
  res.json({ ok: true, ...c });
}));

// ── Saldo de JH en la plataforma de pagos y gastos informados ──
router.get('/superadmin/pagos', ruta(async (req, res) => {
  const [{ rows: cola }, { rows: errores }, { rows: [mes] }] = await Promise.all([
    pool.query(`SELECT estado, COUNT(*)::int AS n FROM pagos_eventos GROUP BY estado`),
    pool.query(`SELECT e.id, e.generacion_id, e.referencia, e.intentos, e.ultimo_error, e.creado, g.preset_nombre, g.precio_usd
                FROM pagos_eventos e JOIN generaciones g ON g.id = e.generacion_id WHERE e.estado = 'error' ORDER BY e.id DESC LIMIT 30`),
    pool.query(`SELECT COALESCE(SUM(precio_usd), 0) AS usd, COUNT(*)::int AS n FROM generaciones
                WHERE cobro_externo AND estado <> 'fallido' AND creado > now() - interval '30 days'`),
  ]);
  let saldo = null; let errorSaldo = null;
  if (saldoExterno.configurado()) {
    try { saldo = await saldoExterno.resumen(); } catch (e) { errorSaldo = e.message.slice(0, 200); }
  }
  res.json({
    saldo: { configurado: saldoExterno.configurado(), ...(saldo || {}), error: errorSaldo },
    gasto: { configurado: pagos.configurado(), cola: Object.fromEntries(cola.map((r) => [r.estado, r.n])), errores },
    ultimos30: { gastadoUsd: Number(mes.usd), creaciones: mes.n },
  });
}));

router.post('/superadmin/pagos/probar', ruta(async (req, res) => {
  if (!saldoExterno.configurado()) throw errPublico('Faltan SALDO_CLIENT_ID y SALDO_API_KEY (en panel y worker).');
  try { res.json({ ok: true, ...(await saldoExterno.leer({ fresco: true })) }); } catch (e) {
    throw errPublico(`La plataforma de pagos no respondió bien: ${e.message.slice(0, 200)}`, 502);
  }
}));

router.post('/superadmin/pagos/eventos/:id/hecho', ruta(async (req, res) => {
  if (!(await pagos.marcarHecho(Number(req.params.id) || 0, req.user.email))) throw errPublico('Ese envío no está en error.');
  console.log(`[pagos] ${req.user.email} marco como descontado el evento ${req.params.id}`);
  res.json({ ok: true });
}));

router.post('/superadmin/pagos/eventos/:id/reintentar', ruta(async (req, res) => {
  if (!(await pagos.reintentar(Number(req.params.id) || 0))) throw errPublico('Ese envío no está en error.');
  console.log(`[pagos] ${req.user.email} reintenta el gasto ${req.params.id}`);
  res.json({ ok: true });
}));

// Clasificar ya las plantillas nuevas (en segundo plano; el worker tambien lo hace cada 12 h).
let clasificando = false;
router.post('/superadmin/plantillas/clasificar', ruta(async (req, res) => {
  if (!clasificar.configurado()) throw errPublico('Falta la clave de la IA para clasificar.');
  if (clasificando) return res.json({ ok: true, enCurso: true });
  clasificando = true;
  catalogo.olvidar();
  catalogo.todas().then((items) => clasificar.clasificarNuevas(items, { max: 60 }))
    .then((r) => { console.log(`[clasificar] ${req.user.email}: ${r.hechas} nuevas clasificadas, quedan ${r.pendientes}`); catalogo.olvidar(); })
    .catch((e) => console.error('[clasificar]', e.message))
    .finally(() => { clasificando = false; });
  res.json({ ok: true, iniciado: true });
}));

// Webhook de Zernio: registrar/actualizar y mandar un evento de prueba.
router.post('/superadmin/zernio/webhook', ruta(async (req, res) => {
  const base = process.env.PANEL_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const r = await zernio.asegurarWebhook(base);
    if (!r.ok) throw errPublico(r.motivo === 'sin_api_key' ? 'Falta la clave de Zernio.' : 'Falta ZERNIO_WEBHOOK_SECRET.');
    let prueba = null;
    try { prueba = await zernio.probarWebhook(); } catch (e) { prueba = { error: e.message }; }
    res.json({ ok: true, ...r, prueba });
  } catch (e) {
    if (e.publico) throw e;
    throw errPublico('Zernio no respondió bien: ' + e.message.slice(0, 120), 502);
  }
}));

// Leer ya los precios del proveedor (sin esperar al worker).
router.post('/superadmin/costo/actualizar', ruta(async (req, res) => {
  const r = await costo.actualizarCosto(req.user.email);
  res.json({ ok: true, ...r, ajustes: await ajustes.leer() });
}));

// Recarga (o ajuste negativo) manual de la billetera de JH, p. ej. tras una transferencia.
router.post('/superadmin/recargas', ruta(async (req, res) => {
  const creditos = Number(req.body?.creditos);
  if (!Number.isFinite(creditos) || creditos === 0 || Math.abs(creditos) > 1e6) throw errPublico('Cantidad de créditos inválida.');
  // Sin monto: lo que vale con el precio por credito actual (costo + ganancia).
  const pc = ajustes.precioCredito(await ajustes.leer());
  const usd = req.body?.usd === '' || req.body?.usd == null
    ? (creditos > 0 && pc != null ? Math.round(creditos * pc * 100) / 100 : null) : Number(req.body.usd);
  if (usd != null && (!Number.isFinite(usd) || usd < 0)) throw errPublico('Monto en USD inválido.');
  const m = await billetera.recargaManual({ creditos, usd, nota: String(req.body?.nota || '').slice(0, 300), por: req.user.email });
  console.log(`[billetera] ${req.user.email} ${creditos > 0 ? 'recargo' : 'ajusto'} ${creditos} creditos (usd ${usd})`);
  res.status(201).json({ ok: true, movimiento: m, saldo: await billetera.saldo() });
}));

router.get('/superadmin/usuarios', ruta(async (req, res) => {
  const [perfiles, { rows }] = await Promise.all([auth.perfiles(), pool.query('SELECT user_id, rol, otorgado_por, actualizado FROM accesos')]);
  const acc = new Map(rows.map((r) => [r.user_id, r]));
  res.json({
    usuarios: perfiles.map((p) => ({
      id: p.id, email: p.email, nombre: p.full_name || null, rolPaneles: p.role || 'agent',
      acceso: p.role === 'super_admin' ? 'super_admin' : acc.get(p.id)?.rol || null,
      otorgadoPor: acc.get(p.id)?.otorgado_por || null, actualizado: acc.get(p.id)?.actualizado || null,
    })),
  });
}));

router.put('/superadmin/usuarios/:id', ruta(async (req, res) => {
  const acceso = req.body?.acceso ?? null;
  if (acceso !== null && !['usuario', 'admin'].includes(acceso)) throw errPublico('Acceso inválido.');
  const p = (await auth.perfiles()).find((x) => x.id === req.params.id);
  if (!p) throw errPublico('Ese usuario no existe.', 404);
  if (p.role === 'super_admin') throw errPublico('Los super admin siempre tienen acceso.');
  if (acceso === null) {
    await pool.query('DELETE FROM accesos WHERE user_id = $1', [p.id]);
  } else {
    await pool.query(
      `INSERT INTO accesos (user_id, email, rol, otorgado_por) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET rol = EXCLUDED.rol, email = EXCLUDED.email, otorgado_por = EXCLUDED.otorgado_por, actualizado = now()`,
      [p.id, p.email, acceso, req.user.email]
    );
  }
  console.log(`[accesos] ${req.user.email} -> ${p.email}: ${acceso || 'sin acceso'}`);
  res.json({ ok: true, acceso });
}));

// Consumo del mes (YYYY-MM, hora de Santo Domingo). Solo cuenta lo completado;
// lo que fallo no se cobra. Filas viejas sin foto de costo usan los ajustes actuales.
router.get('/superadmin/consumo', ruta(async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : null;
  const a = await ajustes.leer();
  const { rows } = await pool.query(
    `SELECT creado_por, preset_tipo, estado, creditos_estimados, costo_usd, precio_usd
     FROM generaciones
     WHERE to_char(creado AT TIME ZONE 'America/Santo_Domingo', 'YYYY-MM') = COALESCE($1, to_char(now() AT TIME ZONE 'America/Santo_Domingo', 'YYYY-MM'))`,
    [mes]
  );
  const vacio = () => ({ generaciones: 0, fallidas: 0, enCurso: 0, creditos: 0, costo: 0, precio: 0 });
  const porUsuario = new Map();
  const porTipo = new Map();
  const total = vacio();
  let sinCosto = 0;
  for (const g of rows) {
    const bolsas = [total, porUsuario.get(g.creado_por) || porUsuario.set(g.creado_por, vacio()).get(g.creado_por),
      porTipo.get(g.preset_tipo) || porTipo.set(g.preset_tipo, vacio()).get(g.preset_tipo)];
    if (g.estado === 'fallido') { bolsas.forEach((b) => b.fallidas++); continue; }
    if (g.estado !== 'completado') { bolsas.forEach((b) => b.enCurso++); continue; }
    const cr = Number(g.creditos_estimados) || 0;
    let { costo_usd: costo, precio_usd: precio } = g;
    if (costo == null) {
      const p = ajustes.precioDe(a, g.preset_tipo, cr);
      costo = p.costo; precio = p.precio;
      if (costo == null) sinCosto++;
    }
    for (const b of bolsas) {
      b.generaciones++; b.creditos += cr; b.costo += Number(costo) || 0; b.precio += Number(precio) || 0;
    }
  }
  const conGanancia = (o) => ({ ...o, ganancia: o.precio - o.costo });
  res.json({
    mes: mes || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit' }).format(new Date()),
    total: conGanancia(total),
    porUsuario: [...porUsuario].map(([email, o]) => ({ email, ...conGanancia(o) })).sort((x, y) => y.creditos - x.creditos),
    porTipo: [...porTipo].map(([tipo, o]) => ({ tipo, ...conGanancia(o) })).sort((x, y) => y.creditos - x.creditos),
    sinCosto,
  });
}));

module.exports = { router };
