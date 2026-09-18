// Filtros detallados del catalogo de plantillas y como se muestran. La
// clasificacion de cada plantilla (producto, estilo, persona, encaje con JH)
// vive en shared/clasificacion.json; la genera el analisis visual de portadas.

export const PRODUCTOS = {
  electrico_industrial: 'Eléctrico e industrial',
  iluminacion: 'Iluminación',
  agua_piscina: 'Agua, plomería y piscina',
  herramientas: 'Herramientas y ferretería',
  tecnologia: 'Tecnología',
  hogar: 'Hogar',
  belleza: 'Belleza',
  bebidas_alimentos: 'Alimentos y bebidas',
  moda: 'Moda y accesorios',
  salud: 'Salud',
  otros: 'Otros',
};

export const ESTILOS = {
  estudio: 'Estudio',
  tecnico: 'Técnico (callouts)',
  industrial: 'Industrial / obra',
  minimalista: 'Minimalista',
  oscuro_lujo: 'Oscuro / premium',
  lifestyle: 'Lifestyle',
  exterior: 'Exterior',
  agua_efectos: 'Agua y efectos',
  colorido: 'Colorido',
  editorial: 'Editorial',
};

export const ORIENTACIONES = { vertical: 'Vertical', horizontal: 'Horizontal', cuadrada: 'Cuadrada' };

// Umbral para marcar una plantilla como recomendada para JH.
export const RECOMENDADA = 8;

// "Sirve para": familias de JH -> que composiciones les quedan bien (por estilo) y
// encaje minimo. El producto del ejemplo casi nunca es de ferreteria (el catalogo
// del generador es de consumo), asi que se decide por la composicion.
export const SIRVE_PARA = {
  electrico: { label: 'Eléctrico e industrial', estilos: ['tecnico', 'industrial', 'estudio', 'minimalista', 'oscuro_lujo'], min: 6 },
  iluminacion: { label: 'Iluminación', estilos: ['oscuro_lujo', 'estudio', 'minimalista', 'lifestyle'], min: 6 },
  agua: { label: 'Agua, plomería y piscina', estilos: ['agua_efectos', 'exterior'], min: 5 },
  herramientas: { label: 'Herramientas y ferretería', estilos: ['industrial', 'tecnico', 'exterior', 'estudio'], min: 6 },
};
export const sirvePara = (estilos, jh) => Object.entries(SIRVE_PARA)
  .filter(([, r]) => jh >= r.min && (estilos || []).some((e) => r.estilos.includes(e))).map(([k]) => k);
