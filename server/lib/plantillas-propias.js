/**
 * Plantillas propias: los disenos que JH ya publico en su Instagram, convertidos en
 * plantillas reutilizables.
 *
 * El usuario sube una imagen de un diseno suyo y la IA saca de ahi una RECETA: como esta
 * armado (estructura, encuadre, fondo, luz, paleta, zonas de texto, ritmo si va a ser video),
 * SIN describir el producto del ejemplo ni copiar sus marcas ni sus textos, porque la
 * plantilla se va a usar con otros productos del catalogo.
 *
 * Esa receta se guarda y despues entra como "indicaciones" del generador de prompts, que ya
 * sabe seguir un pedido al pie de la letra (modo guiado de lib/prompt-auto.js) sobre la foto
 * del producto nuevo. Es decir: la plantilla propia no es un preset del proveedor —no existe
 * del lado de Higgsfield— sino una receta nuestra que se crea por la via libre.
 */
const { pool } = require('./db');
const promptAuto = require('./prompt-auto');

const MAX_NOMBRE = 80;
const MAX_RECETA = 1500;
const ASPECTOS = new Set(['9:16', '16:9', '1:1', '4:5', '3:4', '4:3', '21:9', '2:3', '3:2', '5:4']);
const DURACION_MIN = 3;
const DURACION_MAX = 30;

const ESQUEMA = {
  type: 'object',
  properties: {
    nombre: { type: 'string', description: 'Nombre corto para la plantilla, en español, 2 a 5 palabras, por lo que es el diseño y no por el producto del ejemplo.' },
    receta: { type: 'string', description: 'La receta en español, como un pedido: cómo está armado el diseño y qué habría que repetir. Sin nombrar el producto del ejemplo.' },
    aspecto: { type: 'string', description: 'Formato del ejemplo: uno de 9:16, 16:9, 1:1, 4:5, 3:4, 4:3, 2:3, 3:2, 5:4, 21:9.' },
    con_texto: { type: 'boolean', description: 'true si el diseño lleva textos (titular, nombre del producto, llamada). Entonces al usar la plantilla se le piden esos textos al usuario.' },
    zonas: { type: 'string', description: 'Si lleva texto: qué va en cada zona y con qué estilo (posición, tamaño, peso, color), sin copiar las palabras del ejemplo. Vacío si no lleva texto.' },
    duracion_s: { type: ['integer', 'null'], description: 'Solo si la plantilla es para video: segundos que le quedan bien (3 a 30). Si es para foto, null.' },
    avisos: { type: 'array', items: { type: 'string' }, description: 'Lo que no se pudo sacar del ejemplo o el usuario debería revisar, en español. Vacía si no hay.' },
  },
  required: ['nombre', 'receta', 'aspecto', 'duracion_s', 'con_texto', 'zonas', 'avisos'],
  additionalProperties: false,
};

const INSTRUCCIONES = `Mirás un diseño ya publicado por JH Electro Alambres —un distribuidor de material eléctrico, iluminación, ferretería, plomería y piscinas— y sacás de ahí una RECETA reutilizable, para que el panel pueda hacer piezas nuevas con el mismo estilo pero con OTROS productos del catálogo.

Lo más importante: describís cómo está armada la pieza, no qué producto sale en ella. La receta se va a aplicar a un breaker, a un rollo de cable, a una bomba o a un bombillo, así que nada de la receta puede depender del producto del ejemplo.

# Qué va en la receta

- La estructura: qué se ve primero, dónde está el producto en el cuadro, qué lo acompaña, cómo se cierra. Si es para video, en qué momentos se divide y qué pasa en cada uno.
- El encuadre y la cámara: plano, ángulo, distancia, si hay movimiento y cuál.
- La escena: dónde pasa (estudio, obra, casa, taller, mostrador), la superficie y el fondo.
- La luz: dura o suave, de dónde viene, el clima que genera.
- La paleta: los colores del fondo y de los acentos, descritos por nombre ("azul profundo", "amarillo señalética"). Si hay un color muy marcado, decilo.
- El texto: si el diseño lleva texto, decí en qué zonas va y de qué tamaño y peso, sin copiar las palabras del ejemplo.
- El ritmo y el tono: elegante, técnico, enérgico, limpio.

# Si el diseño lleva texto

Muchos diseños son piezas de anuncio: titular, nombre del producto, una frase corta, una llamada a la acción. Eso es la mitad de lo que hace bueno el diseño, así que NO se tira: se describe.

- Poné con_texto en true y en "zonas" describí cada bloque de texto: dónde va, de qué tamaño y peso, en qué color, y qué clase de mensaje lleva ("titular grande en dos líneas, negro con una línea en verde, arriba a la izquierda"; "nombre del producto, mediano y centrado, debajo del titular"; "llamada a la acción corta abajo").
- No copies las palabras del ejemplo: las palabras las escribe el usuario cuando use la plantilla. Vos describís el molde, no el contenido.
- NUNCA pidas dejar áreas vacías ni "espacio en blanco reservado". Un diseño con huecos vacíos sale como una hoja en blanco. La pieza se ve terminada: los bloques de texto llevan el texto que dé el usuario y los adornos gráficos se dibujan.

# Qué NO va en la receta

- El producto del ejemplo: no lo nombres, no lo describas, no digas cuántas piezas tiene. La receta habla de "el producto" en general.
- Marcas ajenas, logos de otras empresas y nombres comerciales del ejemplo: no se describen ni se reproducen (son de sus dueños y el filtro del generador los rechaza).
- Códigos QR, sellos de garantía y datos de contacto del ejemplo: no se dibujan, porque saldrían inventados e ilegibles. Si el ejemplo los tiene, decilo en un aviso.
- El logo de JH tampoco se dibuja: el panel lo estampa después sobre la pieza terminada. En la receta solo dejá la esquina de abajo despejada de texto para que quepa, sin pedir un rectángulo vacío grande.
- Personas reales o reconocibles, ni estilos atribuidos a un artista, estudio o marca.
- Precios, teléfonos y números concretos del ejemplo.

# Cómo se escribe

- En español, como un pedido de 60 a 140 palabras, en frases cortas y concretas.
- Hablá de "el producto", no de un producto en particular: "el producto entra en el centro del cuadro", "la cámara se acerca al producto".
- Nada de listas con guiones ni títulos: es un párrafo o dos, como lo diría una persona pidiendo el video.
- Si la pieza es para video y el ejemplo es una imagen, describí el movimiento mínimo que tendría sentido ("un acercamiento lento").
- El producto ocupa su lugar de siempre en el cuadro y los adornos gráficos (bandas, diagonales, círculos de color) se dibujan: la pieza tiene que verse llena y terminada.

# Nombre

Corto, en español, por lo que es el diseño y no por el producto: "Ficha técnica sobre azul", "Producto en mostrador", "Antes y después de obra".

# Avisos

En español, cortos, uno por duda: algo del diseño que no se pudo interpretar, texto que no se leía, si el ejemplo tiene un collage de varios productos, si el formato no se puede saber con certeza, y si el ejemplo trae marcas ajenas, QR, sellos o datos de contacto que no se van a reproducir. Lista vacía si no hay.`;

const limpio = (t, max) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** El cuerpo de la llamada: la imagen del diseño y para qué se va a usar la plantilla. */
function pedido({ imagenUrl, para = 'video', nombre = '' }) {
  if (typeof imagenUrl !== 'string' || !/^https:\/\//.test(imagenUrl)) {
    throw new promptAuto.ErrorDePrompt('Falta la imagen del diseño.', { status: 400 });
  }
  const esVideo = para === 'video';
  const pistas = limpio(nombre, MAX_NOMBRE);
  return {
    model: promptAuto.MODELO_PROMPT,
    instructions: INSTRUCCIONES,
    max_output_tokens: 4000,
    input: [{ role: 'user', content: [
      { type: 'input_image', image_url: imagenUrl, detail: 'high' },
      { type: 'input_text', text: [
        esVideo
          ? 'La plantilla es para hacer VIDEOS: la receta describe los momentos y el movimiento, y en duracion_s va la duración que le queda bien.'
          : 'La plantilla es para hacer FOTOS: la receta describe el cuadro fijo, y duracion_s va en null.',
        pistas ? `El usuario le puso este nombre o nota: "${pistas}". Tenelo en cuenta para el nombre.` : 'El usuario no puso nombre: proponelo vos.',
        'Sacá la receta de este diseño.',
      ].join('\n') }],
    }],
    text: { format: { type: 'json_schema', name: 'receta_de_plantilla', strict: true, schema: ESQUEMA } },
  };
}

/** Analiza el diseño y devuelve { nombre, receta, aspecto, duracion, avisos, modelo, tokens }. */
async function analizar(datos, opciones = {}) {
  const { datos: d, modelo, entrada, salida } = await promptAuto.llamarDatos(pedido(datos), opciones);
  const receta = limpio(d?.receta, MAX_RECETA);
  if (receta.length < 40) throw new promptAuto.ErrorDePrompt('La IA no pudo sacar una receta de esa imagen. Prueba con otro diseño.');
  const dur = Number(d?.duracion_s);
  return {
    nombre: limpio(d?.nombre, MAX_NOMBRE) || 'Plantilla propia',
    receta,
    conTexto: !!d?.con_texto,
    zonas: limpio(d?.zonas, MAX_RECETA),
    aspecto: ASPECTOS.has(String(d?.aspecto)) ? String(d.aspecto) : '9:16',
    duracion: datos.para === 'foto' || !Number.isFinite(dur) ? null : Math.max(DURACION_MIN, Math.min(DURACION_MAX, Math.round(dur))),
    avisos: Array.isArray(d?.avisos) ? d.avisos.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim().slice(0, 300)) : [],
    modelo,
    tokens: { entrada, salida },
  };
}

// ── Guardadas (compartidas: las crea cualquiera y las usa todo el equipo) ──

const COLS = 'id, nombre, para, receta, zonas, con_texto, aspecto, duracion, con_audio, portada, origen, creado_por, creado, usos';

function valida({ nombre, para, receta, zonas, conTexto, aspecto, duracion, conAudio }) {
  const n = limpio(nombre, MAX_NOMBRE);
  const r = limpio(receta, MAX_RECETA);
  if (!n) throw Object.assign(new Error('Ponle un nombre a la plantilla.'), { status: 400 });
  if (r.length < 40) throw Object.assign(new Error('La receta es muy corta: describe cómo está armado el diseño.'), { status: 400 });
  const p = para === 'foto' ? 'foto' : 'video';
  const d = p === 'foto' ? null : Math.max(DURACION_MIN, Math.min(DURACION_MAX, Math.round(Number(duracion) || 10)));
  return {
    nombre: n, para: p, receta: r, zonas: limpio(zonas, MAX_RECETA), conTexto: !!conTexto,
    aspecto: ASPECTOS.has(String(aspecto)) ? String(aspecto) : '9:16', duracion: d, conAudio: !!conAudio,
  };
}

async function crear(datos, { email, portada = null, origen = null }) {
  const v = valida(datos);
  const { rows: [f] } = await pool.query(
    `INSERT INTO plantillas_propias (nombre, para, receta, zonas, con_texto, aspecto, duracion, con_audio, portada, origen, creado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
    [v.nombre, v.para, v.receta, v.zonas, v.conTexto, v.aspecto, v.duracion, v.conAudio, portada, origen, email]
  );
  return f;
}

const listar = async () => (await pool.query(`SELECT ${COLS} FROM plantillas_propias WHERE NOT eliminada ORDER BY id DESC LIMIT 200`)).rows;
const leer = async (id) => (await pool.query(`SELECT ${COLS} FROM plantillas_propias WHERE id = $1 AND NOT eliminada`, [Number(id) || 0])).rows[0] || null;

async function editar(id, datos) {
  const v = valida(datos);
  const { rows: [f] } = await pool.query(
    `UPDATE plantillas_propias SET nombre = $2, para = $3, receta = $4, aspecto = $5, duracion = $6, con_audio = $7, zonas = $8, con_texto = $9
     WHERE id = $1 AND NOT eliminada RETURNING ${COLS}`,
    [Number(id) || 0, v.nombre, v.para, v.receta, v.aspecto, v.duracion, v.conAudio, v.zonas, v.conTexto]
  );
  return f || null;
}

// Se marca eliminada y no se borra: las creaciones que salieron de ella siguen apuntando aqui.
const borrar = async (id) => (await pool.query('UPDATE plantillas_propias SET eliminada = true WHERE id = $1 AND NOT eliminada', [Number(id) || 0])).rowCount > 0;
const usada = (id) => pool.query('UPDATE plantillas_propias SET usos = usos + 1 WHERE id = $1', [Number(id) || 0]).catch(() => {});

module.exports = { analizar, pedido, crear, listar, leer, editar, borrar, usada, valida, INSTRUCCIONES, ASPECTOS, MAX_NOMBRE, MAX_RECETA };
