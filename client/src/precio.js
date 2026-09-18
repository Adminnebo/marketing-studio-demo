// Precio al cliente (USD) de N creditos con los ajustes del super_admin (me.precios).
export function precioDe(precios, tipo, creditos) {
  if (!precios || creditos == null) return null;
  const margen = precios.margenPorTipo?.[tipo] ?? precios.margenPct;
  const costo = Number(creditos) * precios.usdPorCredito;
  return { costo, precio: costo * (1 + margen / 100), margen };
}
export const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
