/**
 * Costo en USD de las ayudas de IA del panel (descripcion automatica, ficha tecnica,
 * captions) a partir de los tokens que devuelve OpenAI. Precio por millon de tokens.
 */
const PRECIOS = {
  'gpt-4.1-nano': { entrada: 0.10, salida: 0.40 },
  'gpt-4.1-mini': { entrada: 0.40, salida: 1.60 },
  'gpt-4.1': { entrada: 2.00, salida: 8.00 },
};

// "gpt-4.1-mini-2025-04-14" -> el precio del nombre mas largo que coincida.
function precioDe(modelo) {
  const m = String(modelo || '').toLowerCase();
  const clave = Object.keys(PRECIOS).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k));
  return clave ? PRECIOS[clave] : PRECIOS['gpt-4.1']; // desconocido: el mas caro de la lista (conservador)
}

function costoUsd(modelo, entrada = 0, salida = 0) {
  const p = precioDe(modelo);
  return Math.round(((Number(entrada) || 0) / 1e6 * p.entrada + (Number(salida) || 0) / 1e6 * p.salida) * 1e6) / 1e6;
}

module.exports = { costoUsd, precioDe, PRECIOS };
