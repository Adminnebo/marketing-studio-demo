// Personalizacion avanzada de plantillas: colores, luz, fondo, estilo y textos.
//
// El generador de plantillas no tiene parametros para esto (su unico control libre es el
// texto de instrucciones), asi que cada opcion se traduce a una indicacion clara que se suma
// a esas instrucciones. Probado: la paleta pedida por texto se respeta (fondo y acentos) sin
// tocar los colores del producto. El formato (aspect_ratio) NO se respeta en plantillas, por
// eso no se ofrece.
//
// Lo usan el panel (para mostrar lo que se va a agregar) y el servidor (que arma el texto
// final a partir de valores validados, nunca de texto libre del navegador).

export const PALETAS = {
  obra: { nombre: 'Azul y amarillo', uso: 'Obra, construcción', colores: ['#0B2A5B', '#F2B705'] },
  potente: { nombre: 'Rojo y negro', uso: 'Potencia, herramientas', colores: ['#C8102E', '#111111'] },
  premium: { nombre: 'Negro y dorado', uso: 'Premium, lujo', colores: ['#121212', '#C9A227'] },
  agua: { nombre: 'Azul agua y blanco', uso: 'Piscina, plomería', colores: ['#1E8FD0', '#EAF6FC'] },
  fresco: { nombre: 'Verde y blanco', uso: 'Ahorro, ecológico', colores: ['#1B7F4B', '#F4F4F0'] },
  energia: { nombre: 'Naranja y gris', uso: 'Energía, taller', colores: ['#F26B1D', '#3A3F44'] },
  claro: { nombre: 'Blanco y gris claro', uso: 'Limpio, catálogo', colores: ['#FFFFFF', '#D9DCE1'] },
};

export const LUCES = {
  calida: { nombre: 'Cálida', texto: 'luz cálida y acogedora, tonos dorados suaves' },
  brillante: { nombre: 'Brillante de estudio', texto: 'luz de estudio brillante y pareja, sombras suaves y limpias' },
  dramatica: { nombre: 'Dramática', texto: 'luz dramática de contraste, un haz lateral fuerte sobre fondo más oscuro' },
  natural: { nombre: 'Natural de día', texto: 'luz natural de día, como junto a una ventana' },
  neon: { nombre: 'Neón', texto: 'luces de neón de color como acentos en el fondo, el producto bien iluminado' },
};

export const FONDOS = {
  liso: { nombre: 'Estudio liso', texto: 'un fondo de estudio liso, sin objetos' },
  obra: { nombre: 'Obra', texto: 'una obra en construcción desenfocada al fondo' },
  hogar: { nombre: 'Hogar moderno', texto: 'el interior de un hogar moderno desenfocado al fondo' },
  taller: { nombre: 'Taller', texto: 'un taller de trabajo ordenado, desenfocado al fondo' },
  exterior: { nombre: 'Exterior', texto: 'un exterior con luz de día desenfocado al fondo' },
  tienda: { nombre: 'Ferretería', texto: 'el mostrador de una ferretería, desenfocado al fondo' },
};

export const ESTILOS = {
  minimalista: { nombre: 'Minimalista', texto: 'estilo minimalista: pocos elementos y mucho espacio vacío' },
  llamativo: { nombre: 'Llamativo', texto: 'estilo llamativo y enérgico, colores intensos' },
  premium: { nombre: 'Premium', texto: 'estilo premium y elegante, acabados de lujo' },
  tecnico: { nombre: 'Técnico', texto: 'estilo técnico y profesional, limpio y preciso' },
};

// Tipos de plantilla que llevan texto en la imagen (se pueden reemplazar sus textos).
export const TIPOS_CON_TEXTO = new Set(['poster', 'ads', 'marketplace']);
export const MAX_TEXTO = 80;

const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null);
const limpio = (v) => String(v || '').replace(/[\r\n"“”]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXTO);

// Deja solo valores conocidos (lo que manda el navegador puede venir con cualquier cosa).
export function validar(p = {}, tipo = '') {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  if (p.paleta && PALETAS[p.paleta]) out.paleta = p.paleta;
  else if (p.paleta === 'propia') {
    const principal = hex(p.colores?.[0]); const acento = hex(p.colores?.[1]);
    if (principal) out.paleta = 'propia', out.colores = acento ? [principal, acento] : [principal];
  }
  if (p.luz && LUCES[p.luz]) out.luz = p.luz;
  if (p.fondo && FONDOS[p.fondo]) out.fondo = p.fondo;
  if (p.estilo && ESTILOS[p.estilo]) out.estilo = p.estilo;
  if (TIPOS_CON_TEXTO.has(tipo)) {
    for (const k of ['titulo', 'subtitulo', 'llamada']) { const t = limpio(p[k]); if (t) out[k] = t; }
  }
  return out;
}

export const cuantas = (p) => Object.keys(p || {}).filter((k) => k !== 'colores').length;

// El texto que se suma a las instrucciones de la plantilla (en español, como las pruebas).
export function textoDe(pBruto, tipo = '') {
  const p = validar(pBruto, tipo);
  if (!cuantas(p)) return '';
  const lineas = ['PERSONALIZACIÓN (manda sobre la plantilla en estos puntos; el resto se mantiene igual):'];
  if (p.paleta) {
    const [a, b] = p.paleta === 'propia' ? p.colores : PALETAS[p.paleta].colores;
    lineas.push(b
      ? `- Paleta de colores de la escena: color principal ${a} para el fondo y el ambiente, y ${b} para acentos y detalles.`
      : `- Color principal de la escena: ${a} para el fondo y el ambiente.`);
  }
  if (p.fondo) lineas.push(`- Fondo: ${FONDOS[p.fondo].texto}.`);
  if (p.luz) lineas.push(`- Iluminación: ${LUCES[p.luz].texto}.`);
  if (p.estilo) lineas.push(`- ${ESTILOS[p.estilo].texto.charAt(0).toUpperCase()}${ESTILOS[p.estilo].texto.slice(1)}.`);
  if (p.titulo) lineas.push(`- Titular del diseño, exactamente: "${p.titulo}".`);
  if (p.subtitulo) lineas.push(`- Texto secundario, exactamente: "${p.subtitulo}".`);
  if (p.llamada) lineas.push(`- Llamada a la acción, exactamente: "${p.llamada}".`);
  if (p.titulo || p.subtitulo || p.llamada) lineas.push('- No agregues otros textos, precios ni teléfonos.');
  lineas.push('- El producto no cambia: mismos colores, piezas, forma y marcas impresas que en la foto.');
  return lineas.join('\n');
}
