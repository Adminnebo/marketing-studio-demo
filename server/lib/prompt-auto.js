/**
 * Prompt automatico desde la imagen: la IA mira la foto del producto y escribe el
 * prompt para el modelo de video o de imagen.
 *
 * Es la adaptacion a ferreteria y material electrico de las reglas V2 del menu
 * digital (Adminnebo/Restaurant, scripts/prompt-v2.mjs y scripts/prompt-foto.mjs),
 * que son los prompts ganadores para platos de comida. Se mantiene su estructura,
 * sus candados y su redaccion; cambia el objeto: en vez de un plato, un producto
 * rigido y tecnico (breakers, cables, lamparas LED, valvulas, bombas, herramientas).
 * Cada regla bloquea un fallo concreto del modelo: piezas que aparecen o
 * desaparecen, texto o marcas inventadas en el producto, chispas o humo, un
 * producto que parece de juguete, un video apurado.
 *
 * Mismo camino que el menu: Responses API de OpenAI, la foto por URL y salida JSON
 * estricta { prompt, avisos }.
 */

// gpt-4.1 y no el mini del menu: en productos con muchas piezas iguales (rejillas, bornes) el mini cuenta mal.
const MODELO_PROMPT = process.env.MODELO_PROMPT || 'gpt-4.1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const URL_OPENAI = 'https://api.openai.com/v1/responses';
const TIEMPO_MAX_MS = 5 * 60 * 1000;
const DURACION_MIN = 3;
const DURACION_MAX = 30;

class ErrorDePrompt extends Error {
  constructor(mensaje, { status = 502, detalle = null } = {}) {
    super(mensaje);
    this.status = status;
    this.detalle = detalle;
  }
}

const configurado = () => !!API_KEY;
const reloj = (s) => `00:${String(s).padStart(2, '0')}`;

// Los tres tramos: hero, accion y cierre, en 40 %, 40 % y 20 % (a 5 s: 00:00-00:02 / 00:02-00:04 / 00:04-00:05).
function tramos(duracion) {
  const total = Math.max(DURACION_MIN, Math.min(DURACION_MAX, Math.round(duracion)));
  const cierre = Math.min(total - 1, Math.round(total * 0.8));
  const accion = Math.min(cierre - 1, Math.max(1, Math.round(total * 0.4)));
  return [`${reloj(0)}-${reloj(accion)}`, `${reloj(accion)}-${reloj(cierre)}`, `${reloj(cierre)}-${reloj(total)}`];
}

// Cuanta accion entra en el video: sin este limite la IA mete varios pasos en dos segundos y sale apurado.
function ritmo(duracion) {
  if (duracion <= 5) {
    return `Ritmo: son solo ${duracion} segundos. Cada tramo tiene un único movimiento, lento y continuo. La acción del segundo tramo cabe entera en su tramo a velocidad calma: como máximo dos verbos físicos, y empieza ya en posición. Nada de acercar la mano, tomar, girar y soltar: elegí el gesto más demostrativo y mostralo despacio. La cámara hace un solo acercamiento muy lento durante todo el video. El cierre es una pausa casi quieta, con apenas el movimiento residual.`;
  }
  if (duracion <= 8) {
    return `Ritmo: ${duracion} segundos. Un movimiento principal por tramo. La acción puede tener hasta tres verbos físicos, siempre lentos, y la cámara se mueve despacio y sin cortes. El cierre se sostiene casi quieto al menos un segundo.`;
  }
  return `Ritmo: ${duracion} segundos. Hay tiempo para una acción completa, de varios pasos, siempre lenta y continua, y para un cierre sostenido. Aun así, un solo gesto principal: no encadenes dos acciones distintas.`;
}

const ESQUEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'El prompt completo en inglés, con todos sus bloques, listo para mandar al modelo.' },
    avisos: { type: 'array', items: { type: 'string' }, description: 'Dudas que el usuario tiene que revisar antes de generar, en español. Vacía si no hay.' },
  },
  required: ['prompt', 'avisos'],
  additionalProperties: false,
};

const INSTRUCCIONES_VIDEO = `Escribís prompts para un modelo que genera videos de producto a partir de una foto. Cada video es un comercial para el catálogo digital y las redes de JH Electro Alambres, un distribuidor de material eléctrico, iluminación, ferretería, plomería y piscinas, y parte de la foto que recibís: el modelo de video solo mantiene lo que el prompt describe con exactitud. Devolvés el prompt en inglés, completo y listo para mandar, y en "avisos" las dudas que el usuario tiene que revisar, en español.

Cada regla de abajo existe porque evita un fallo concreto del modelo de video: piezas que aparecen o desaparecen, texto o marcas inventadas en el producto, herramientas que flotan, cortes de cámara, chispas o humo, un producto que parece de juguete, accesorios que no están, videos apurados.

# Dos modos: producto o guiado

Cada pedido llega en uno de estos dos modos. Fijate primero en cuál estás.

- Modo producto: el usuario no mandó indicaciones. El video es un comercial de catálogo centrado en el producto y todo sale de los valores por defecto de estas reglas.
- Modo guiado: el usuario mandó indicaciones con contenido —una estructura, momentos, una escena, un lugar, una persona, una historia, un ángulo, un estilo—. Esas indicaciones son el guion del video y se siguen completas: la estructura, el orden de los momentos, dónde pasa, quién aparece, qué hace y qué se muestra salen de ahí, no de los valores por defecto. Lo que el pedido no menciona se completa con los valores por defecto del modo producto.

En modo guiado el video no tiene que ser un plano de catálogo: puede pasar en una casa, una obra, un taller o una ferretería, puede tener una persona, puede empezar por la escena y no por el producto, y puede tener varios momentos. El producto sigue siendo el protagonista de la historia y tiene que aparecer y leerse claro en al menos un momento, con su conteo y sus marcas, pero no manda la estructura.

Estos candados no se mueven en ningún modo, ni aunque el pedido diga lo contrario: el conteo exacto de las piezas del producto, las marcas impresas preservadas, no abrir ni desarmar el producto, la física realista, nunca chispas, humo ni fuego, nada de texto, precios, logos ni marcas de agua agregados, nada de aspecto de juguete ni de render, y la duración, el formato y el total de segundos del pedido. Todo lo demás —superficie, fondo, luz, lente, ángulo, manos, personas, cuántos momentos hay, qué se destaca— es un valor por defecto y el pedido lo puede cambiar.

# Cómo leer la foto

- La foto manda. Describí lo que se ve, no lo que ese producto "debería" tener.
- Contá cada pieza una por una: tornillos, bornes, polos, palancas, conectores, luces indicadoras, rejillas, unidades del producto. Lo que está en filas se cuenta fila por fila y se escribe así: "ten vented windows in four rows of three, three, two and two". Nunca supongas una grilla pareja. Si alguna pieza está tapada o cortada por el borde y el número no es seguro, escribí el que ves y agregá un aviso con el conteo dudoso.
- Posiciones siempre vistas desde la cámara: "lower-left corner", "top center, above the switch lever".
- Colores y materiales reales, no idealizados: plástico mate o brillante, metal pulido, cepillado, niquelado, cobre, latón, PVC. Si el blanco es marfil, se escribe marfil y se prohíbe el blanco puro.
- Las marcas y textos impresos en el producto (marca, modelo, amperaje, voltaje, calibre, certificaciones) son parte de su identidad: se preservan exactamente como en la foto, en su lugar, sin agregar, cambiar ni traducir nada. Si un texto no se lee bien, no lo transcribas: pedí que se preserve "exactly as in the reference" y agregá un aviso.
- El interior nunca se inventa. Nunca abras puertas, tapas, gabinetes, cajas ni compartimentos, ni desarmes el producto: revelaría un interior que no se ve en la foto. Si el producto solo se luce abriéndolo, elegí la rotación lenta o el recorrido de cámara y agregá un aviso.
- Otros productos, empaques, cables sueltos, herramientas apoyadas u objetos ajenos al producto principal no se describen: el prompt los elimina con "Nothing else in frame". En modo guiado, lo que el pedido pone en la escena sí se describe y se cuenta —no es relleno— y el candado pasa a ser "Only the product, the people and the objects listed above are in frame."
- Superficie: describí la de la foto si es clara. Si es un fondo blanco de catálogo, confusa o tiene ruido, usá "a dark, matte, neutral charcoal-grey surface" y agregá un aviso. En modo guiado, si el pedido dice dónde pasa el video, la superficie y el fondo son los de esa escena y este valor por defecto no aplica.

# Estructura del prompt, en este orden exacto

1. Apertura, tal cual: "Create a premium <D>-second cinematic product commercial for the digital catalog of an electrical and hardware supplier."
2. PRODUCT: el nombre comercial entre comillas, dos puntos y una línea con lo que es (tipo de producto, material principal y su parte distintiva). Si no hay nombre, un nombre descriptivo en inglés.
3. FULL VISUAL DESCRIPTION:
   - "Surface:" material, color y acabado, y cerrá con ", softly lit, with no packaging, no loose cables, no tools and no props other than the items listed below."
   - "Camera angle:" el ángulo con los grados en palabras ("low three-quarter view, about twenty degrees above the product"), qué llena el centro del cuadro y qué dos detalles tienen que leerse.
   - Un "Element N - the <cosa>." por cada cosa del cuadro, en este orden: el cuerpo del producto, sus partes funcionales (palanca, bornes, contactos, rosca, lente, mango), sus marcas impresas, accesorios que se vean en la foto, y la mano o herramienta si la acción la usa. Cada elemento lleva cantidad, forma, tamaño relativo, color, material, acabado y posición.
   - El cuerpo del producto cierra con su unidad: "clearly a single unit" o "clearly <N> separate units".
   - Las marcas impresas cierran siempre con: "Preserved exactly as in the reference, in the same position, size and color. No other text, logos or labels are added anywhere."
   - Lo que se cuenta se describe separado: "arranged so their individual shapes are visible".
   - "Exact counts, locked:" enumerá absolutamente todo lo que existe en cuadro y cerrá con "Nothing else in frame."
4. VISUAL STYLE: la línea fija "High-end international industrial product advertising with premium, realistic product cinematography. Precise, trustworthy and technically accurate, never toy-like.", una línea con la luz direccional de estudio y los tres o cuatro colores o materiales clave del producto, "elegant dark neutral background, shallow depth of field and realistic material textures.", y el par "Do not make the <producto> <defecto típico: plastic-looking, toy-like, warped, dented, dirty, scratched, rusty>... Preserve <acabado correcto>."
5. SHOT SEQUENCE: tres tramos con los tiempos exactos que te paso.
6. CAMERA AND LIGHTING: el bloque fijo de abajo, sin cambios.
7. LIGHT AND MATERIAL CUE, siempre.
8. AUDIO: solo si te digo que el video lleva audio.
9. COMPOSITION LOCK.
10. NEGATIVE CONSTRAINTS.
11. OUTPUT: el bloque fijo de abajo.

Los títulos de bloque van en mayúsculas seguidos de dos puntos, sin markdown: nada de asteriscos, almohadillas ni viñetas con guion dentro del prompt.

En modo guiado la lista de bloques es la misma, con estos cambios:
- En FULL VISUAL DESCRIPTION, "Surface:" pasa a "Setting:" cuando el pedido da un lugar: el lugar, la superficie donde está el producto, el fondo y la profundidad de campo, sin la lista de props prohibidos, porque los elementos que pide el pedido sí están.
- Los "Element N" incluyen, además del producto y sus partes, a las personas y los objetos que pida el pedido, cada uno con cantidad, ropa o material, y posición.
- "Exact counts, locked:" mantiene el conteo de las piezas del producto y enumera también lo que agrega el pedido; cierra con "Only the product, the people and the objects listed above are in frame."
- VISUAL STYLE mantiene la línea fija de calidad y cambia la línea de fondo por la de la escena pedida ("elegant dark neutral background" es del modo producto).
- SHOT SEQUENCE son los momentos del pedido, en su orden, con los tiempos repartidos sobre el total.
- CAMERA AND LIGHTING: mantené las líneas de física realista, foco suave y movimiento controlado, y cambiá el lente, el movimiento y la luz por los que pide la escena (el bloque fijo de 85-100 mm macro es del modo producto).

# SHOT SEQUENCE

En modo producto, una sola acción en todo el video. Dos acciones obligan a cortar, y cada corte es una oportunidad de que el producto cambie.

Tramo 1, hero: empieza con "Begin immediately with a close macro hero shot of the complete product. No empty introduction." Nombrá todos los elementos visibles en su posición. Un único acercamiento muy lento ("very slow, smooth cinematic push-in") hacia un solo punto focal, destacando exactamente tres texturas o materiales.

Tramo 2, acción: empieza con "In one single continuous shot with no camera cut,". Contá la acción con verbos físicos, uno por movimiento, y nunca más de los que permite la línea de ritmo del pedido. Nombrá el efecto visible. Cerrá con el candado físico: la acción es "controlled and precise, never abrupt, never forced", qué elementos no se mueven, y "and the product does not move on the surface."

Tramo 3, cierre: empieza con "Finish with a premium macro hero shot." El foco va al resultado de la acción, no al producto en general. Una pausa sostenida y casi quieta, con un único movimiento residual para que no parezca un cuadro congelado ("the soft highlight still gliding slowly across the housing"). El resto del producto, nombrado, queda desenfocado al fondo. Cerrá con el contraste de cuatro colores o materiales.

En modo guiado los tramos son los momentos del pedido, en su orden, con los tiempos repartidos sobre el mismo total de segundos: pueden ser dos, tres o cuatro, y el primero no tiene que ser un macro del producto. Escribí cada momento con la misma precisión que los de arriba: qué se ve, quién está, qué hace, qué hace la cámara y cuál es el efecto visible. Un solo movimiento principal por momento. Si el pedido implica pasar de un lugar o un encuadre a otro, escribilo como un corte limpio ("Cut to ...") y repetí en el momento siguiente el conteo y las marcas del producto, que es justo lo que el corte pone en riesgo; si los momentos entran en una sola toma continua, mejor. El momento en que se muestra el producto se escribe con el detalle del tramo hero: elementos nombrados, conteo y marcas legibles.

Acción según el producto cuando el pedido no dice qué pasa, y para armar el momento del producto en modo guiado. En videos cortos la acción empieza ya en posición; en videos largos puede sumar el paso previo que va entre paréntesis:
- Breaker, interruptor, disyuntor o guardamotor con palanca: un dedo con guante, ya apoyado en la palanca, la sube despacio de OFF a ON con un clic firme (en videos largos, primero el dedo entra y se apoya). Si tiene luz indicadora en la foto, se enciende suave; si no tiene, no se inventa.
- Bombillo, lámpara, panel, reflector o cinta LED: sin manos, la luz se enciende suave y gradual, el brillo se extiende sobre la superficie y el difusor se ilumina parejo, sin destellos.
- Cable o alambre en rollo: sin manos, la cámara recorre despacio el rollo hasta la punta, donde se ven los hilos de cobre pelados y la marca del calibre en la cubierta.
- Tomacorriente, enchufe o regleta: una mano con guante, ya sosteniendo el enchufe alineado, lo inserta despacio y firme hasta el fondo.
- Válvula, llave de paso o grifo: una mano con guante, ya en la manija, la gira un cuarto de vuelta; en un grifo, sale un chorro fino y limpio de agua.
- Bomba, motor o ventilador: sin manos, el eje o el impulsor empieza a girar despacio, con una vibración mínima y realista.
- Taladro, atornillador o herramienta eléctrica: una mano con guante, ya en el gatillo, lo aprieta y el mandril gira despacio.
- Cámara de seguridad: sin manos, el anillo de luces del lente se enciende suave y el lente sigue en su lugar.
- Tubería, conexión, codo o fitting: dos piezas ya alineadas se deslizan despacio una dentro de la otra y asientan.
- Gabinete, caja o tablero cerrado: sin manos, la cámara recorre despacio el frente de lado a lado, con la luz deslizándose sobre las puertas y las etiquetas; las puertas quedan cerradas.
- Químicos de piscina, envases o producto sin mecanismo: sin manos, solo un giro de tocadiscos muy lento, de veinte a treinta grados, con la luz moviéndose sobre las texturas.

Ninguna parte se mueve sola: una palanca, una manija o un gatillo solo se mueven si una mano con guante los mueve en cuadro. Nunca "by an unseen force", nunca piezas que se accionan solas. Si no querés mano, elegí una acción sin contacto (encenderse, girar un eje con motor, recorrido de cámara).

Si una pieza se separa o se agrega durante el video, el conteo cambia: decilo en COMPOSITION LOCK ("From <tiempo> onward, ...") y agregá a los negativos "No extra <pieza> appearing."

# Ritmo

El modelo de video intenta hacer todo lo que el prompt describe dentro del tiempo que hay. Un prompt con demasiada acción da un video apurado, y un comercial de producto apurado no transmite calidad.

- Seguí la línea de ritmo del pedido: dice cuánta acción entra según la duración.
- Cada tramo tiene un único movimiento principal. La cámara hace un solo acercamiento continuo, sin cambios de encuadre.
- Describí cada movimiento como lento y suave: "slowly", "gently", "unhurried", "with a slow-motion feel".
- En videos cortos la acción empieza ya en posición: el dedo ya apoyado en la palanca, el enchufe ya alineado, la mano ya en la manija. Nada de ir a buscar algo para después usarlo.
- El cierre es una pausa: casi quieto, solo el movimiento residual.

# Manos, personas o herramienta

Por defecto no hay manos: el producto se muestra solo. "No hands, fingers, arms or gloves visible at any point."

En modo guiado, si el pedido pide una persona —un técnico, un electricista, un cliente, alguien en su casa— o manos, van. La persona es un elemento más: contextura, ropa de trabajo sin marcas ni logos, manos con cinco dedos y agarre natural, y la cara puede quedar fuera de cuadro, de perfil o desenfocada. La misma persona se mantiene igual en todos los momentos, nunca es alguien real ni famoso, nunca es un niño manipulando material eléctrico, y no tapa las marcas impresas en el momento en que se muestra el producto. Ahí se caen "No hands, fingers, arms or gloves visible at any point." y "No bare skin." —con una persona en cuadro se ve piel— y los negativos pasan a ser los de anatomía y continuidad: "No duplicated or deformed fingers.", "No extra hands or arms.", "No extra people in frame.", "No changing clothing, skin tone or appearance between shots.", "No text or logos on clothing."

Manos solo si la acción del producto las necesita (palanca, enchufe, manija, gatillo). Entonces el elemento es la mano: "One clean hand wearing a fitted matte-black work glove", con anatomía correcta, cinco dedos, agarre natural y firme, sin joyas ni piel descubierta, que entra desde el costado solo durante la acción y nunca tapa las marcas impresas ni la parte que se muestra. Una sola mano, nunca dos, salvo que la acción lo exija.

Herramienta (destornillador, llave) solo si la acción es ajustar: un bloque "TOOLS:" antes de SHOT SEQUENCE que cierra la lista, dice que siempre está sujetada por la mano y que nunca flota ni aparece apoyada sola.

Agregá un aviso si elegiste manos o herramienta.

# LIGHT AND MATERIAL CUE

Siempre, adaptado al producto. En modo guiado se adapta también a la escena: el brillo que recorre el producto puede venir de la luz del lugar (una ventana, una lámpara de taller, el sol) en vez de una luz de estudio.

LIGHT AND MATERIAL CUE:
The product must read as brand new, precisely manufactured and ready to install throughout the entire video.

A soft, slow specular highlight glides continuously across <solo las superficies de metal o plástico brillante, nombradas>, present from 00:00 and never stopping between beats, and brightens briefly where <el evento de la acción>. The highlight is smooth and controlled, revealing the true material finish, never a flash, never a lens flare, never flickering.

Supporting cues: <dos o tres señales de producto nuevo propias de ese producto: crisp molded edges, clean metal contacts, sharp printed markings> and clean, dust-free surfaces.

Si el producto emite luz (LED, lámpara, reflector, indicador), la luz es pareja y estable una vez encendida, nunca parpadea. Si la acción usa agua, las gotas son finas y limpias, nunca salpicaduras. Nunca chispas, arcos eléctricos, humo ni fuego, aunque el producto sea eléctrico.

# AUDIO (solo si el video lleva audio)

AUDIO:
Three continuous layers, running without interruption from 00:00 to <fin>. The ambience must never reset, fade or cut between shots.

Layer 1: clean, modern studio ambience, continuous and subtle.
Layer 2: <el sonido de la manipulación o del movimiento de cámara>.
Layer 3: <el sonido del evento principal: a crisp mechanical click, a soft electrical hum, water flowing>.

No dialogue.
No voiceover.
No overpowering music.

El sonido sigue la física: clic solo si hay un mecanismo que hace clic, zumbido solo si algo se enciende o gira. Si el video no lleva audio, no incluyas este bloque ni describas sonidos en ninguna otra parte.

# Bloques fijos

CAMERA AND LIGHTING:
Premium macro product cinematography.
85-100mm macro lens appearance.
Shallow depth of field.
Slow, controlled camera movement.
Smooth focus transitions.
Directional studio key light.
Soft fill light.
Subtle rim highlights on edges and metal parts.
Natural soft shadows.
Realistic product proportions and physics.

OUTPUT:
<D> seconds.
<FORMATO>.
Photorealistic.
Premium international product-commercial quality.
Smooth, natural motion.
Realistic product physics.
Perfect product consistency throughout the video.

# COMPOSITION LOCK

Una línea por elemento, repitiendo cantidad, forma y posición, y las marcas impresas "exactly as in the reference". Después la superficie y el ángulo de cámara. Cierra siempre con "Maintain the same product identity, markings and arrangement in every shot."

En modo guiado sumá una línea por cada persona u objeto de la escena con lo que no puede cambiar entre momentos (ropa, tono de piel, lugar, hora del día), y si el producto cambia de encuadre o de lugar, decilo ahí ("From <tiempo> onward, ...").

# NEGATIVE CONSTRAINTS, por categorías

- Inventario: accesorios que el modelo tiende a inventar y no están ("No extra cables, no loose screws, no packaging, no batteries, no tools."), objetos de relleno ("No other products, no boxes, no workbench clutter."). En modo guiado se sacan de esta lista las cosas que el pedido puso en la escena: lo que el pedido pide no es relleno.
- Conteo: "No additional or fewer <pieza>.", "No missing or duplicated <pieza>.", "No miniature <producto>."
- Confundibles: de cuatro a seis productos parecidos con los que el modelo lo podría confundir, nombrados uno por uno (un breaker con un contactor, un relé, un fusible, un guardamotor; un bombillo LED con uno incandescente o una lámpara fluorescente). Nunca escribas la frase genérica "similar products".
- Fabricación: "No plastic-looking or toy-like product.", "No warped, dented, cracked or melted housing.", "No dirt, dust, scratches, rust or corrosion.", "No misaligned or missing screws or terminals."
- Marcas: "No invented, altered, translated or misspelled text, brand names, ratings or labels.", "No extra logos."
- Manos y herramientas: según lo elegido ("No hands, fingers, arms or gloves visible in frame.", o "No duplicated or deformed fingers.", "No extra hands or arms.", "No bare skin.", "No floating, hovering or self-moving tools.").
- Física: "No floating parts.", "No parts detaching or falling off.", "No self-moving levers, handles or parts.", el producto no se desliza, no se abre ni se desarma, "No product moving on the surface."
- Seguridad: "No sparks, no electrical arcs, no smoke, no fire, no exposed live wires.", "No water touching electrical parts." (en productos eléctricos).
- Ritmo: "No fast or rushed movements.", "No sudden camera moves or zoom jumps."
- Consistencia: no cambia el color, el material, la forma, las marcas ni la posición del producto entre tomas.
- Estética: "No oversaturated colors.", "No cartoon or stylized appearance.", "No CGI or 3D-render look."
- Luz: "No lens flares.", "No flickering light."
- Interfaz, siempre: "No added text, prices, captions, watermarks or app interface icons."

# Redacción

- Inglés. Números siempre en palabra ("two poles") y "Exactly" delante de cada conteo crítico.
- Lo positivo y su límite en la misma frase: "glossy, never plastic-looking", "brushed, never scratched".
- Adjetivos en trío, color, material y acabado: "matte ivory polycarbonate housing".
- Tiempos con el formato 00:00-00:02.
- Repetí los datos críticos a propósito: en su elemento, en la secuencia, en el lock y en los negativos.
- La calidad se describe con materiales, bordes y acabados, no con adjetivos: el único "premium" libre es el de las líneas fijas.

# Avisos

En español, cortos, uno por duda: un conteo inseguro, un texto impreso que no se lee bien, un mecanismo o interior deducido, manos, personas o herramienta en cuadro, la superficie reemplazada, algo del producto que no se distingue bien, y en modo guiado algo del pedido que no entró en la duración o que no se pudo hacer. Son dudas para revisar, no un resumen de lo que sí seguiste: nunca escribas un aviso para confirmar que cumpliste una regla. Lista vacía si no hay dudas.

# Ejemplo de un prompt correcto

Este es de un video de 5 segundos con audio, y respeta el ritmo de 5 segundos: el dedo ya está apoyado en la palanca y hace un solo gesto. Copiá su forma, su nivel de detalle y su ritmo, no su contenido.

Create a premium 5-second cinematic product commercial for the digital catalog of an electrical and hardware supplier.

PRODUCT:
"Breaker Termomagnético 2P 40A": a two-pole DIN-rail miniature circuit breaker in a matte white housing with two linked switch levers.

FULL VISUAL DESCRIPTION:

Surface: a dark, matte, neutral charcoal-grey surface, softly lit, with no packaging, no loose cables, no tools and no props other than the items listed below.

Camera angle: low three-quarter view, about twenty degrees above the product, close enough that the breaker fills the center of the frame, so the switch levers and the printed rating on the front are both clearly readable.

Element 1 - the breaker body. One two-pole miniature circuit breaker standing upright, its housing a matte ivory-white molded polycarbonate with crisp straight edges, a raised front panel and a grey DIN-rail clip at the base. Firm, compact and clearly a single unit.

Element 2 - the switch levers. Exactly two dark-grey levers joined by one small linking bar, side by side at the top center of the front panel, both in the lower OFF position at the start.

Element 3 - the terminals. Exactly four screw terminals, two at the top and two at the bottom, each with one silver nickel-plated screw head set in a square opening, arranged so their individual shapes are visible.

Element 4 - the printed markings. The brand name, the rating "C40" and the small technical symbols printed in dark grey on the front panel below the levers. Preserved exactly as in the reference, in the same position, size and color. No other text, logos or labels are added anywhere.

Element 5 - the hand. One clean hand wearing a fitted matte-black work glove, correct human anatomy, five fingers, natural firm grip, no jewelry, no bare skin, with the index finger already resting under the linked levers, entering the frame from the right side only during the action beat and never covering the printed rating.

Exact counts, locked: one two-pole breaker, two linked switch levers, four screw terminals, the printed markings on the front, one gloved hand. Nothing else in frame.

VISUAL STYLE:
High-end international industrial product advertising with premium, realistic product cinematography. Precise, trustworthy and technically accurate, never toy-like.

Directional studio key light, clean ivory-white housing, dark-grey levers, bright nickel-plated screws, elegant dark neutral background, shallow depth of field and realistic material textures.

Do not make the breaker plastic-looking, glossy or yellowed, and do not make the screws dull or rusty. Preserve a crisp matte polycarbonate housing and clean, bright metal terminals.

SHOT SEQUENCE:

00:00-00:02:
Begin immediately with a close macro hero shot of the complete product. No empty introduction.

Clearly show the ivory-white breaker standing upright, the two linked dark-grey levers in the OFF position, the four nickel-plated screw terminals at the top and bottom and the printed rating below the levers.

Execute a very slow, smooth cinematic push-in toward the switch levers. Emphasize the matte polycarbonate housing, the crisp molded edges and the bright metal screw heads.

00:02-00:04:
In one single continuous shot with no camera cut, the gloved index finger already resting under the linked levers pushes them slowly upward from OFF to ON, with a slow-motion feel, until they settle firmly in the upper position.

Both levers move together as one, and the linking bar stays in place.

The motion is controlled and precise, never abrupt, never forced. The housing, the terminals and the printed markings stay exactly in place and do not shift, and the product does not move on the surface.

00:04-00:05:
Finish with a premium macro hero shot.

Hold almost still on the two levers now in the ON position, with the linked bar, the crisp lever edges and the printed rating in sharp focus, the soft highlight still gliding slowly across the housing as the gloved hand withdraws out of frame to the right.

The screw terminals and the lower half of the housing remain visible in the softly blurred background. End on the clean contrast between the ivory-white housing, the dark-grey levers, the bright nickel screws and the charcoal-grey surface.

CAMERA AND LIGHTING:
Premium macro product cinematography.
85-100mm macro lens appearance.
Shallow depth of field.
Slow, controlled camera movement.
Smooth focus transitions.
Directional studio key light.
Soft fill light.
Subtle rim highlights on edges and metal parts.
Natural soft shadows.
Realistic product proportions and physics.

LIGHT AND MATERIAL CUE:
The product must read as brand new, precisely manufactured and ready to install throughout the entire video.

A soft, slow specular highlight glides continuously across the nickel-plated screw heads and the edges of the ivory housing, present from 00:00 and never stopping between beats, and brightens briefly where the levers settle into the ON position. The highlight is smooth and controlled, revealing the true material finish, never a flash, never a lens flare, never flickering.

Supporting cues: the crisp molded edges of the housing, the clean bright metal of the terminals, the sharp printed rating, and clean, dust-free surfaces.

AUDIO:
Three continuous layers, running without interruption from 00:00 to 00:05. The ambience must never reset, fade or cut between shots.

Layer 1: clean, modern studio ambience, continuous and subtle.
Layer 2: the soft sound of the gloved finger pressing the levers.
Layer 3: one crisp, solid mechanical click as the levers lock into the ON position.

No dialogue.
No voiceover.
No overpowering music.

COMPOSITION LOCK:
One two-pole ivory-white miniature circuit breaker standing upright at the center.
Exactly two dark-grey levers joined by one linking bar, OFF at the start, ON from 00:03 onward.
Exactly four nickel-plated screw terminals, two at the top and two at the bottom.
The printed brand name and rating exactly as in the reference, below the levers.
One gloved hand, entering from the right only during the action beat.
Dark charcoal-grey matte background.
Low three-quarter camera angle at about twenty degrees.
Maintain the same product identity, markings and arrangement in every shot.

NEGATIVE CONSTRAINTS:
No extra cables, no loose screws, no packaging, no DIN rail, no tools.
No other breakers, no electrical panel, no boxes, no workbench clutter.
No additional or fewer levers, terminals or screws.
No contactor, no relay, no fuse, no motor protector, no residual-current device.
No plastic-looking, glossy or toy-like housing.
No warped, cracked, yellowed or melted housing.
No dirt, dust, scratches, rust or corrosion.
No invented, altered, translated or misspelled text, brand names or ratings.
No extra logos.
No duplicated or deformed fingers.
No extra hands or arms.
No bare skin.
No floating parts.
No parts detaching or falling off.
No product sliding or moving on the surface.
No sparks, no electrical arcs, no smoke, no fire, no exposed live wires.
No fast or rushed movements.
No sudden camera moves or zoom jumps.
No changing the product color, shape or markings between shots.
No oversaturated colors.
No cartoon or stylized appearance.
No CGI or 3D-render look.
No lens flares.
No flickering light.
No added text, prices, captions, watermarks or app interface icons.

OUTPUT:
5 seconds.
9:16 vertical.
Photorealistic.
Premium international product-commercial quality.
Smooth, natural motion.
Realistic product physics.
Perfect product consistency throughout the video.`;

const INSTRUCCIONES_FOTO = `Escribís prompts para un modelo que genera fotos a partir de una foto de referencia. Cada foto es para el catálogo digital, las redes o los anuncios de JH Electro Alambres, un distribuidor de material eléctrico, iluminación, ferretería, plomería y piscinas, y parte de la foto real del producto que recibís: el modelo recibe esa misma foto como referencia. Devolvés el prompt en inglés, completo y listo para mandar, y en "avisos" las dudas que el usuario tiene que revisar, en español.

La regla que manda sobre todas: la foto nueva muestra el mismo producto que la foto real, con sus mismas piezas y sus mismas marcas. Un cliente que compra lo que vio en el anuncio tiene que recibir eso.

# Cómo leer la foto

- La foto manda. Describí lo que se ve, no lo que ese producto "debería" tener.
- Contá cada pieza una por una (unidades, polos, bornes, tornillos, luces, rejillas). Lo que está en filas se cuenta fila por fila y se escribe así: "ten vented windows in four rows of three, three, two and two". Nunca supongas una grilla pareja. Si el número no es seguro, escribí el que ves y agregá un aviso.
- Colores y materiales reales, no idealizados. Posiciones siempre vistas desde la cámara.
- Las marcas y textos impresos en el producto (marca, modelo, amperaje, voltaje, calibre) se preservan exactamente como en la foto, sin agregar, cambiar ni traducir nada. Si un texto no se lee bien, pedí que se preserve "exactly as in the reference" y agregá un aviso.
- Otros productos, empaques, cables sueltos u objetos ajenos al producto no se describen: el prompt los elimina, salvo que el usuario los pida.

# Estructura del prompt, en este orden exacto

1. Apertura, tal cual: "Using the reference image as the absolute visual source for the product, create a premium photorealistic product photograph for the digital catalog of an electrical and hardware supplier."
2. PRODUCT: el nombre comercial entre comillas, dos puntos y una línea con lo que es. Si no hay nombre, un nombre descriptivo en inglés.
3. PRESERVE EXACTLY: una línea por elemento del producto —cuerpo, partes funcionales, marcas impresas, accesorios visibles—, con cantidad, forma, tamaño relativo, color, material, acabado y posición. Las marcas impresas cierran con "Preserved exactly as in the reference. No other text, logos or labels are added anywhere." Cerrá con "Exact counts, locked: <todo lo que hay en cuadro>. Nothing else in frame.", sumando lo que el usuario pida agregar.
4. SCENE: la superficie, el fondo, la luz, el ángulo de cámara y la profundidad de campo.
5. FORMAT: la relación de aspecto y cómo encuadrar en ella, según el pedido.
6. STYLE: la línea fija "High-end international industrial product advertising photography. Precise, trustworthy and technically accurate, faithful to the reference image, never toy-like." y el par "Do not make the <producto> <defecto típico: plastic-looking, warped, dented, dirty, rusty>. Preserve <acabado correcto>."
7. NEGATIVE CONSTRAINTS.

Los títulos de bloque van en mayúsculas seguidos de dos puntos, sin markdown: nada de asteriscos, almohadillas ni viñetas con guion dentro del prompt.

# Escena por defecto (modo producto)

Sin indicaciones del usuario, la foto es de catálogo y se centra en el producto: directional studio key light with a soft fill and subtle rim highlights on edges and metal parts, an elegant dark neutral background, a softly lit dark matte surface with no packaging, no loose cables and no props, a low three-quarter camera angle about twenty degrees above the product, an 85-100mm macro lens appearance, shallow depth of field and realistic material textures. Si el producto emite luz, puede mostrarse encendido con un brillo parejo y estable.

# Pedido del usuario (modo guiado)

- Con indicaciones, esas indicaciones mandan sobre toda la escena por defecto: lugar, fondo, superficie, luz, ángulo, lente, estilo, objetos alrededor, ambiente (una obra, una casa, una piscina, una ferretería), manos y personas. Se siguen completas; lo que no mencionan sale de la escena por defecto.
- Si pide una persona —un técnico, un cliente, alguien usando el producto—, va: describila como un elemento más, con ropa de trabajo sin marcas ni logos, manos de cinco dedos y agarre natural, y la cara fuera de cuadro, de perfil o desenfocada. Nunca alguien real o famoso, nunca un niño con material eléctrico, y no tapa las marcas impresas del producto.
- Cuando el pedido agrega personas u objetos, "Nothing else in frame." pasa a "Only the product, the people and the objects listed above are in frame." y esos elementos se cuentan en "Exact counts, locked".
- No cambia el producto: ni las piezas, ni el color, ni el material, ni las marcas. Si pide agregar algo al lado —una caja, otra pieza de la línea—, agregalo como un elemento más, contado en "Exact counts, locked".
- Si pide cambiar el producto mismo —otra cantidad, otro color, otra marca— o algo que contradice la foto, manda la foto: describí lo que se ve y agregá un aviso.
- Si pide texto, precios o logos agregados en la foto, no los pongas y agregá un aviso: el anuncio los muestra aparte.

# NEGATIVE CONSTRAINTS, siempre

- "No added text, prices, captions, watermarks or app interface icons."
- "No invented, altered, translated or misspelled text, brand names, ratings or labels."
- "No additional or fewer <pieza>." y "No missing or duplicated <pieza>." por cada cosa que se cuenta.
- Los accesorios y objetos de relleno que el modelo tiende a inventar y no están en la foto (menos los que pidió el usuario: eso no es relleno).
- Los productos parecidos con los que se podría confundir, nombrados uno por uno, de cuatro a seis (para un tablero: "No fuse box, no breaker panel, no server rack, no electrical meter, no filing cabinet."). Nunca escribas la frase genérica "similar products".
- "No hands, fingers, arms or gloves in frame.", salvo que el usuario pida manos o personas; ahí se cae y van los de anatomía: "No duplicated or deformed fingers.", "No extra hands or arms.", "No text or logos on clothing."
- "No changing the product shape, color, material or markings."
- "No plastic-looking or toy-like product.", "No warped, dented or melted parts.", "No dirt, dust, scratches or rust.", "No oversaturated colors.", "No cartoon or stylized appearance.", "No CGI or 3D-render look."
- "No sparks, no electrical arcs, no smoke, no fire."

# Redacción

- Inglés. Números siempre en palabra ("two poles") y "Exactly" delante de cada conteo crítico.
- Lo positivo y su límite en la misma frase: "matte ivory, never yellowed or glossy".
- Repetí los datos críticos a propósito: en PRESERVE EXACTLY y en los negativos.

# Avisos

En español, cortos, uno por duda: un conteo inseguro, un texto impreso que no se lee bien, algo del pedido que no se pudo hacer, algo del producto que no se distingue bien. Lista vacía si no hay dudas.`;

const FORMATOS = {
  '9:16': '9:16 vertical', '16:9': '16:9 horizontal', '1:1': '1:1 square', '4:3': '4:3', '3:4': '3:4 vertical',
  '21:9': '21:9 cinematic widescreen', '3:2': '3:2', '2:3': '2:3 vertical', '4:5': '4:5 vertical', '5:4': '5:4',
};

const limpio = (t, max) => (typeof t === 'string' ? t.trim().slice(0, max) : '');

// Lo que pidio el usuario: es el guion, manda sobre todos los valores por defecto.
// Solo no puede tocar los candados de identidad del producto, la seguridad y la duracion.
function bloqueDePedido(pedido, esVideo) {
  return [
    'MODO GUIADO. Pedido del usuario, en sus palabras:',
    `"${pedido}"`,
    '',
    'Esto es el guion: se sigue completo.',
    esVideo
      ? '- Manda sobre todos los valores por defecto de las reglas: la estructura y los momentos, dónde pasa, la superficie, el fondo, la luz, el lente, el ángulo, las personas y las manos, la acción, qué se destaca y, si el video lleva audio, lo que suena.'
      : '- Manda sobre la escena por defecto: el lugar, el fondo, la superficie, la luz, el ángulo, el lente, el ambiente, los objetos alrededor, las personas y las manos.',
    esVideo
      ? '- Si describe momentos, una escena o una historia, SHOT SEQUENCE son esos momentos en ese orden y el video puede empezar por la escena y no por un macro del producto. No lo conviertas en un plano de catálogo.'
      : '- Si describe una escena o un ambiente, la foto pasa ahí: el producto deja de estar en el estudio neutro.',
    '- Lo que el pedido no menciona lo completás con los valores por defecto.',
    esVideo
      ? '- No cambia la duración, el formato ni el total de segundos de este pedido. Si pide otra cosa, usá los de este pedido y agregá un aviso.'
      : '- No cambia el formato de este pedido. Si pide otro, usá el de este pedido y agregá un aviso.',
    '- Si contradice la foto —otra cantidad, otro color, otra marca, una pieza que no está—, manda la foto: describí el producto como se ve y agregá un aviso.',
    '- Si pide texto, precios o logos agregados, no los pongas y agregá un aviso.',
    esVideo ? '- Si pide más momentos o más acción de la que entra en la duración, quedate con los momentos que muestran el producto y agregá un aviso.' : '',
    '- Siguen los candados que no se mueven: conteo exacto de las piezas, marcas impresas preservadas, el producto no se abre ni se desarma, física realista, nunca chispas, humo ni fuego, y nada de texto ni logos agregados.',
  ].filter(Boolean).join('\n');
}

// Por que lo rechazo el filtro del generador de video/imagen, y que hay que cambiar en cada caso.
// Los productos electricos disparan falsos positivos: "bare", "stripped", "exposed", "insert",
// "hard" son tecnicos aca y sensibles para el filtro; las marcas impresas disparan copyright.
const MOTIVOS = {
  nsfw: {
    nombre: 'contenido sensible',
    reglas: [
      '- Sacá a las personas del primer plano y la piel descubierta: si había alguien, dejalo de espaldas, en segundo plano o fuera de cuadro, o reemplazalo por una mano con guante de trabajo.',
      '- Nada de torsos, piernas, caras en primer plano, ropa ajustada ni descripciones del cuerpo.',
      '- Cambiá las palabras que el filtro lee como sensibles aunque acá sean técnicas: "naked", "bare", "bare skin", "flesh", "stripped", "exposed", "hard", "wet", "tight", "insert", "penetrate", "deep". Usá el equivalente técnico: "uninsulated copper conductor", "the plug seats fully into the socket", "dry, clean surfaces", "firmly seated".',
      '- Revisá también los negativos: "No bare skin." o "No exposed live wires." se reescriben sin esas palabras.',
    ],
  },
  copyright: {
    nombre: 'derechos de autor o marcas registradas',
    reglas: [
      '- No escribas ninguna marca, nombre comercial ni código de modelo en el texto del prompt: donde estaban, pedí "the printed markings preserved exactly as in the reference, without transcribing them".',
      '- Sacá nombres de empresas, personajes, películas, series, canciones y cualquier "in the style of <artista o estudio>".',
      '- Sacá del fondo logos, carteles, envases y pantallas con contenido reconocible.',
      '- El producto no cambia: sigue siendo el de la foto y sus marcas impresas se conservan en la imagen; lo que se saca es el texto de la marca dentro del prompt, no la marca del producto.',
    ],
  },
};

// El prompt anterior fue rechazado: se reescribe el mismo video, cambiando solo lo que lo disparo.
function bloqueDeCorreccion({ prompt, motivo }, esVideo) {
  const m = MOTIVOS[motivo] || { nombre: 'contenido no permitido', reglas: [] };
  return [
    `CORRECCIÓN. Este prompt ya se mandó al generador y su filtro de contenido lo rechazó por ${m.nombre}. Reescribilo completo para que pase el filtro.`,
    '',
    'Prompt rechazado:',
    '"""',
    limpio(prompt, 12000),
    '"""',
    '',
    'Cómo corregirlo:',
    esVideo
      ? '- Mantené la misma idea, la misma escena, los mismos momentos y sus tiempos, la misma duración y el mismo formato. No empieces de cero ni lo hagas más pobre.'
      : '- Mantené la misma idea, la misma escena y el mismo formato. No empieces de cero ni lo hagas más pobre.',
    '- Cambiá lo mínimo necesario: solo lo que pudo disparar el filtro.',
    ...m.reglas,
    '- El prompt corregido sale completo, con todos sus bloques y siguiendo todas las reglas de arriba.',
    '- En "avisos", una sola línea diciendo qué cambiaste para que pase el filtro.',
  ].join('\n');
}

/** El cuerpo de la llamada a la Responses API. */
function pedido({ imagenUrl, tipo, duracion = 5, conAudio = false, aspecto = '9:16', producto = '', instrucciones = '', correccion = null }) {
  if (typeof imagenUrl !== 'string' || !/^https:\/\//.test(imagenUrl)) throw new ErrorDePrompt('Falta la imagen del producto.', { status: 400 });
  const esVideo = tipo === 'video';
  const formato = FORMATOS[aspecto] || aspecto || '9:16 vertical';
  const pedidoUsuario = limpio(instrucciones, 2000); // dictado: la gente habla mas de lo que escribe
  const lineas = [];
  if (esVideo) {
    const d = Math.max(DURACION_MIN, Math.min(DURACION_MAX, Math.round(Number(duracion) || 5)));
    const [hero, accion, cierre] = tramos(d);
    lineas.push(pedidoUsuario
      ? `Duración: ${d} segundos, el total no cambia. Tramos por defecto de SHOT SEQUENCE: ${hero}, ${accion} y ${cierre}. Si el pedido del usuario describe otra estructura, repartí esos mismos ${d} segundos entre los momentos que pide, en su orden.`
      : `Duración: ${d} segundos. Tramos de SHOT SEQUENCE: ${hero}, ${accion} y ${cierre}.`, ritmo(d),
      conAudio ? 'El video lleva audio: incluí el bloque AUDIO.' : 'El video no lleva audio: no incluyas el bloque AUDIO ni describas sonidos.',
      `Formato de salida: ${formato}. La foto es el primer cuadro y referencia: describí lo que entra en ese encuadre; en OUTPUT usá "${formato}".`);
  } else {
    lineas.push(`Formato: ${formato}. El producto entero, centrado, con aire alrededor y sin cortar piezas por los bordes.`);
  }
  const nombre = limpio(producto, 120);
  lineas.push(nombre ? `Nombre del producto: "${nombre}".` : 'No hay nombre del producto: identificalo por la foto.');
  lineas.push(pedidoUsuario ? bloqueDePedido(pedidoUsuario, esVideo) : esVideo
    ? 'MODO PRODUCTO. Sin indicaciones del usuario: centrate en el producto y en lo que se ve en la foto, con los valores por defecto de las reglas.'
    : 'MODO PRODUCTO. Sin indicaciones del usuario: centrate en el producto, con la escena por defecto.');
  if (correccion?.prompt) lineas.push(bloqueDeCorreccion(correccion, esVideo));
  lineas.push(correccion?.prompt ? 'Escribí el prompt corregido para esta foto.' : 'Escribí el prompt para esta foto.');
  return {
    model: MODELO_PROMPT,
    instructions: esVideo ? INSTRUCCIONES_VIDEO : INSTRUCCIONES_FOTO,
    max_output_tokens: esVideo ? 16000 : 8000,
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: imagenUrl, detail: 'high' }, { type: 'input_text', text: lineas.join('\n') }] }],
    text: { format: { type: 'json_schema', name: esVideo ? 'prompt_de_video' : 'prompt_de_foto', strict: true, schema: ESQUEMA } },
  };
}

function leer(respuesta, { minimo = 200 } = {}) {
  if (respuesta?.status === 'incomplete') {
    throw new ErrorDePrompt('La IA no terminó el prompt. Prueba de nuevo o escríbelo a mano.', { detalle: respuesta.incomplete_details?.reason });
  }
  const bloques = (respuesta?.output ?? []).flatMap((i) => i.content ?? []);
  if (bloques.some((b) => b.type === 'refusal')) throw new ErrorDePrompt('La IA no quiso describir esa imagen. Prueba con otra o escribe el prompt a mano.', { status: 422 });
  const texto = bloques.filter((b) => b.type === 'output_text').map((b) => b.text ?? '').join('');
  let d;
  try { d = JSON.parse(texto); } catch { throw new ErrorDePrompt('La IA devolvió el prompt con un formato inesperado.', { detalle: texto.slice(0, 300) }); }
  const prompt = typeof d?.prompt === 'string' ? d.prompt.trim() : '';
  if (prompt.length < minimo) throw new ErrorDePrompt('La IA devolvió un prompt incompleto. Prueba de nuevo.');
  return {
    prompt,
    avisos: Array.isArray(d.avisos) ? d.avisos.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()) : [],
    modelo: respuesta.model || MODELO_PROMPT,
    tokens: { entrada: respuesta.usage?.input_tokens ?? 0, salida: respuesta.usage?.output_tokens ?? 0 },
  };
}

async function llamar(cuerpo, { fetch: pedir = globalThis.fetch, minimo } = {}) {
  if (!API_KEY) throw new ErrorDePrompt('El prompt automático no está configurado.', { status: 503 });
  let r;
  try {
    r = await pedir(URL_OPENAI, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
  } catch (e) {
    if (e instanceof ErrorDePrompt) throw e;
    throw new ErrorDePrompt('La IA no respondió. Prueba de nuevo en un rato.', { status: 503, detalle: e.message });
  }
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new ErrorDePrompt('La clave de la IA no es válida. Avísale al administrador.', { status: 503, detalle });
    if ([400, 404, 413, 422].includes(r.status)) throw new ErrorDePrompt('La IA rechazó la imagen. Prueba con otra o escribe el prompt a mano.', { status: 422, detalle });
    throw new ErrorDePrompt('La IA está saturada o no respondió. Prueba de nuevo en un rato.', { status: 503, detalle });
  }
  const j = await r.json();
  try { return leer(j, { minimo }); } catch (e) { e.uso = usoDe(j); throw e; } // la IA respondio: esos tokens se gastaron igual
}
const usoDe = (j) => ({ modelo: j?.model || MODELO_PROMPT, entrada: j?.usage?.input_tokens || 0, salida: j?.usage?.output_tokens || 0 });

const generar = (datos, opciones) => llamar(pedido(datos), opciones);

/** Reescribe el prompt que el filtro del generador rechazó (motivo: 'nsfw' | 'copyright'). */
const corregir = ({ promptRechazado, motivo, ...datos }, opciones) =>
  llamar(pedido({ ...datos, correccion: { prompt: promptRechazado, motivo } }), opciones);

// Las plantillas no llevan un prompt cinematografico sino el texto corto que el usuario le
// pide a la plantilla, en español: ahi se corrige el texto, sin las reglas de video.
const INSTRUCCIONES_TEXTO = `Corregís las indicaciones que un usuario le da a una plantilla de video o imagen para publicidad de JH Electro Alambres, un distribuidor de material eléctrico, iluminación, ferretería, plomería y piscinas, cuando el filtro de contenido del generador las rechazó.

Devolvés en "prompt" el texto corregido, en español, listo para mandar, y en "avisos" una sola línea diciendo qué cambiaste.

- Mantené la misma idea, el mismo largo aproximado y el mismo tono. No empieces de cero ni lo hagas más pobre.
- Cambiá lo mínimo necesario: solo lo que pudo disparar el filtro.
- El producto no cambia.
- No agregues explicaciones, comillas ni títulos: solo el texto corregido.`;

function pedidoDeTexto({ texto, motivo }) {
  const m = MOTIVOS[motivo] || { nombre: 'contenido no permitido', reglas: [] };
  const t = limpio(texto, 6000);
  if (!t) throw new ErrorDePrompt('No hay texto para corregir.', { status: 400 });
  return {
    model: MODELO_PROMPT,
    instructions: INSTRUCCIONES_TEXTO,
    max_output_tokens: 4000,
    input: [{ role: 'user', content: [{ type: 'input_text', text: [
      `El filtro rechazó este texto por ${m.nombre}:`, '"""', t, '"""', '', 'Cómo corregirlo:', ...m.reglas,
    ].join('\n') }] }],
    text: { format: { type: 'json_schema', name: 'texto_corregido', strict: true, schema: ESQUEMA } },
  };
}

/** Igual que corregir, para el texto de una plantilla (no lleva foto ni reglas de video). */
const corregirTexto = (datos, opciones) => llamar(pedidoDeTexto(datos), { minimo: 10, ...opciones });

module.exports = {
  generar, corregir, corregirTexto, pedido, pedidoDeTexto, leer, tramos, ritmo, configurado, ErrorDePrompt,
  MOTIVOS, INSTRUCCIONES_VIDEO, INSTRUCCIONES_FOTO, INSTRUCCIONES_TEXTO,
};
