/**
 * Costo por credito automatico: lee los paquetes de recarga del generador y toma
 * el MAS CARO por credito (conservador: nunca vendemos por debajo de lo que nos
 * cuesta aunque recarguemos en paquetes chicos). Con costo_auto = 0 solo guarda
 * la lectura y deja el costo que puso el super_admin.
 */
const hf = require('./higgsfield');
const ajustes = require('./config');

async function actualizarCosto(quien = 'sistema') {
  const a = await ajustes.leer();
  const d = await hf.llamar('show_plans_and_credits', { intent: 'topup' });
  const paquetes = (d.topups || []).filter((t) => t.credits > 0 && t.price_cents > 0)
    .map((t) => ({ creditos: t.credits, usd: t.price_cents / 100 }))
    .sort((x, y) => x.creditos - y.creditos);
  if (!paquetes.length) throw new Error('el proveedor no devolvio paquetes de recarga');
  const caro = paquetes.reduce((m, p) => (p.usd / p.creditos > m.usd / m.creditos ? p : m));
  const usd = Math.round((caro.usd / caro.creditos) * 1e6) / 1e6;
  const info = { fuente: `Paquete de ${caro.creditos} créditos a $${caro.usd}`, actualizado: new Date().toISOString(), paquetes };
  const cambios = { costo_info: info };
  if (a.costo_auto === 1 && usd !== a.usd_por_credito) cambios.usd_por_credito = usd;
  await ajustes.guardar(cambios, quien, { internos: true });
  return { antes: a.usd_por_credito, ahora: cambios.usd_por_credito ?? a.usd_por_credito, info };
}

module.exports = { actualizarCosto };
