// Precio para JH (USD) de N creditos: creditos x precio por credito (costo + ganancia).
export function precioDe(precios, _tipo, creditos) {
  if (!precios?.precioCredito || creditos == null) return null;
  const precio = Number(creditos) * precios.precioCredito;
  const costo = precios.usdPorCredito != null ? Number(creditos) * precios.usdPorCredito : null;
  return { precio, costo, margen: precios.margenPct ?? null };
}
export const usd = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const cred = (n) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 });
// "1 crédito" / "35 créditos".
export const creditos = (n) => `${cred(n)} ${Number(n) === 1 ? 'crédito' : 'créditos'}`;
// La clausula de idioma que agrega el servidor a cada creacion no se muestra (server/lib/idioma.js).
export const sinClausula = (p) => String(p || '').replace(/\s*LANGUAGE: Spanish \(Dominican Republic\)[\s\S]*$/, '').trim();
// Montos chicos (ayudas de IA, centavos): con hasta 4 decimales para que no se vean como $0.00.
export const usdFino = (n) => (Math.abs(Number(n)) > 0 && Math.abs(Number(n)) < 0.1
  ? (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  : usd(n));
