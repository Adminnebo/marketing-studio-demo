// Precio para JH (USD) de N creditos: creditos x precio por credito (costo + ganancia).
export function precioDe(precios, _tipo, creditos) {
  if (!precios?.precioCredito || creditos == null) return null;
  const precio = Number(creditos) * precios.precioCredito;
  const costo = precios.usdPorCredito != null ? Number(creditos) * precios.usdPorCredito : null;
  return { precio, costo, margen: precios.margenPct ?? null };
}
export const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cred = (n) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 });
