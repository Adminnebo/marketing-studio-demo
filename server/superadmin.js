/**
 * Pestaña Super Admin (solo profiles.role = super_admin):
 *  - ajustes: costo por credito, % de ganancia (global y por tipo), tope diario, mostrar precio.
 *  - usuarios: dar/quitar acceso a Marketing (usuario / admin) a cualquier usuario de los paneles.
 *  - consumo: generaciones, creditos, costo, precio y ganancia por usuario y mes.
 */
const express = require('express');
const { pool } = require('./lib/db');
const auth = require('./lib/auth');
const ajustes = require('./lib/config');
const hf = require('./lib/higgsfield');
const zernio = require('./lib/zernio');

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
  const [a, saldo, gen] = await Promise.all([
    ajustes.leer(),
    hf.llamar('balance', {}).catch(() => null),
    hf.estadoConexion().catch(() => ({ conectado: false })),
  ]);
  res.json({
    ajustes: a,
    saldo: saldo ? { creditos: saldo.credits, plan: saldo.subscription_plan_type } : null,
    conexiones: { generador: !!gen.conectado, redes: zernio.configurado() },
  });
}));

router.put('/superadmin/ajustes', ruta(async (req, res) => {
  try {
    res.json({ ajustes: await ajustes.guardar(req.body || {}, req.user.email) });
  } catch (e) {
    throw errPublico(e.message);
  }
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
