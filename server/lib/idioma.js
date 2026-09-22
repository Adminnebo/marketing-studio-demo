/**
 * Todo lo que se crea para JH sale en español: se agrega esta clausula al final del prompt
 * de cada creacion (plantillas y desde cero). Las marcas y codigos impresos en el producto
 * se respetan tal cual (no se traducen).
 */
const CLAUSULA = 'LANGUAGE: Spanish (Dominican Republic). Any text that appears (headlines, captions, signs, labels, packaging copy, on-screen titles, subtitles) must be written in correct Spanish. Brand names and model codes printed on the product stay exactly as they are. Any spoken dialogue, narration or voice-over must be in Spanish with a neutral Latin American accent.';

function conEspanol(prompt) {
  const p = String(prompt || '').trim();
  if (p.includes('LANGUAGE: Spanish')) return p; // ya la tiene ('Usar de nuevo')
  return p ? `${p}\n\n${CLAUSULA}` : CLAUSULA;
}

module.exports = { conEspanol, CLAUSULA };
