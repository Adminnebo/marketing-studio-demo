/**
 * Marca de agua: pone el logo sobre una foto o un video ya creados (ffmpeg, sin gastar creditos).
 *
 * Reglas (acordadas con JH):
 *  - El tamano y el margen van en % del ancho, para que quede igual en 9:16, 1:1 o 16:9.
 *  - La esquina depende del formato: en vertical las redes tapan abajo (botones de TikTok y el
 *    texto del post), asi que va arriba; en cuadrado y horizontal va abajo a la derecha.
 *  - En una pieza suelta se puede poner donde sea: `cx` y `cy` son el CENTRO del logo en % del
 *    ancho y del alto (lo que se arrastra en el panel). Si vienen, mandan sobre la esquina.
 *  - Si hay version clara y oscura del logo, se mide el brillo de esa esquina (varios cuadros en
 *    video) y se usa la que contrasta. Ademas el logo lleva una sombra suave para despegarlo del fondo.
 */
const { execFile } = require('child_process');
const { promises: fs } = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const TIEMPO_MAX_MS = Number(process.env.MARCA_TIMEOUT_MS) || 240000;

const POSICIONES = ['arriba-izq', 'arriba-der', 'abajo-izq', 'abajo-der', 'centro'];
const DEFECTOS = { tamPct: 16, margenPct: 4, opacidad: 90, posVertical: 'arriba-izq', posResto: 'abajo-der' };

class ErrorDeMarca extends Error {
  constructor(mensaje, { detalle = null } = {}) { super(mensaje); this.detalle = detalle; }
}

function correr(bin, args, { timeoutMs = TIEMPO_MAX_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) return reject(new ErrorDeMarca(`${path.basename(bin)} falló`, { detalle: (stderr || e.message).slice(-500) }));
      resolve({ stdout, stderr });
    });
  });
}

const disponible = async () => { try { await correr(FFMPEG, ['-version'], { timeoutMs: 10000 }); return true; } catch { return false; } };

/** Ancho, alto, duracion y si trae audio. */
async function medir(archivo) {
  const { stdout } = await correr(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height,codec_type', '-show_entries', 'format=duration', '-of', 'json', archivo], { timeoutMs: 30000 });
  const d = JSON.parse(stdout);
  const v = (d.streams || []).find((s) => s.codec_type === 'video');
  if (!v?.width) throw new ErrorDeMarca('El archivo no tiene imagen.');
  return { ancho: v.width, alto: v.height, audio: (d.streams || []).some((s) => s.codec_type === 'audio'), duracion: Number(d.format?.duration) || 0 };
}

/** Esquina donde va el logo, segun el formato (vertical = las redes tapan abajo). */
const posicionPara = ({ ancho, alto }, a = {}) => (alto > ancho ? (a.posVertical || DEFECTOS.posVertical) : (a.posResto || DEFECTOS.posResto));

/** El centro del logo (en % del lienzo) para una esquina dada: lo usa el panel al arrastrar. */
function centroDe(posicion, { tamPct = DEFECTOS.tamPct, margenPct = DEFECTOS.margenPct, relacion = 1 } = {}) {
  // `relacion` = ancho/alto del lienzo: el margen se mide en % del ancho, tambien hacia arriba y abajo.
  const mediaW = tamPct / 2;
  const mediaH = (tamPct * 0.4 * relacion) / 2; // el alto del logo se estima; el panel lo afina con el real
  const margenV = margenPct * relacion;
  if (posicion === 'centro') return { cx: 50, cy: 50 };
  const [v, h] = String(posicion).split('-');
  return {
    cx: h === 'izq' ? margenPct + mediaW : 100 - margenPct - mediaW,
    cy: v === 'arriba' ? margenV + mediaH : 100 - margenV - mediaH,
  };
}

/** Coordenadas (px) de la caja del logo dentro del lienzo. */
function caja({ ancho, alto }, posicion, anchoLogo, altoLogo, margen) {
  const x = { izq: margen, der: Math.max(0, ancho - anchoLogo - margen), centro: Math.round((ancho - anchoLogo) / 2) };
  const y = { arriba: margen, abajo: Math.max(0, alto - altoLogo - margen), centro: Math.round((alto - altoLogo) / 2) };
  if (posicion === 'centro') return { x: x.centro, y: y.centro };
  const [v, h] = posicion.split('-');
  return { x: x[h === 'izq' ? 'izq' : 'der'], y: y[v === 'arriba' ? 'arriba' : 'abajo'] };
}

/**
 * Brillo medio (0-255) de esa zona. En video mira varios cuadros repartidos, porque la escena cambia.
 * Devuelve null si no se pudo medir (entonces se usa el logo claro, que es lo normal).
 */
async function brilloDe(archivo, { x, y, w, h }, { esVideo = false, duracion = 0 } = {}) {
  const filtro = `crop=${Math.max(2, w)}:${Math.max(2, h)}:${x}:${y},signalstats,metadata=print:file=-`;
  const args = ['-v', 'error'];
  if (esVideo && duracion > 1) args.push('-ss', '0');
  args.push('-i', archivo, '-vf', esVideo ? `${filtro},fps=3` : filtro, '-frames:v', esVideo ? '12' : '1', '-f', 'null', '-');
  try {
    const { stdout } = await correr(FFMPEG, args, { timeoutMs: 60000 });
    const vals = [...stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  } catch { return null; }
}

/**
 * Pone el logo. `logos` = { claro: rutaPNG, oscuro: rutaPNG } (al menos uno).
 * Devuelve { salida, posicion, version, brillo } con la ruta del archivo nuevo.
 */
async function ponerMarca(entrada, logos, opciones = {}) {
  const a = { ...DEFECTOS, ...opciones };
  const info = await medir(entrada);
  const esVideo = /\.(mp4|mov|webm|m4v)$/i.test(entrada) || info.duracion > 0.2;
  const posicion = POSICIONES.includes(a.posicion) ? a.posicion : posicionPara(info, a);
  const anchoLogo = Math.max(24, Math.round(info.ancho * (Number(a.tamPct) || DEFECTOS.tamPct) / 100));
  const margen = Math.round(info.ancho * (Number(a.margenPct) || DEFECTOS.margenPct) / 100);

  // Donde va el logo: arrastrado (centro en % del lienzo) o en su esquina.
  const libre = Number.isFinite(Number(a.cx)) && Number.isFinite(Number(a.cy));
  const altoLogo = Math.round(anchoLogo * 0.45); // estimado, solo para medir el fondo
  const zona = libre
    ? { x: Math.max(0, Math.min(info.ancho - anchoLogo, Math.round(info.ancho * Number(a.cx) / 100 - anchoLogo / 2))),
      y: Math.max(0, Math.min(info.alto - altoLogo, Math.round(info.alto * Number(a.cy) / 100 - altoLogo / 2))) }
    : caja(info, posicion, anchoLogo, altoLogo, margen);

  // Version del logo: la que contrasta con el fondo de ESE lugar (si subieron las dos).
  let version = logos.claro ? 'claro' : 'oscuro';
  let brillo = null;
  if (logos.claro && logos.oscuro) {
    brillo = await brilloDe(entrada, { x: zona.x, y: zona.y, w: anchoLogo, h: altoLogo }, { esVideo, duracion: info.duracion });
    if (brillo != null) version = brillo > 140 ? 'oscuro' : 'claro'; // fondo claro -> logo oscuro
  }
  const logo = logos[version] || logos.claro || logos.oscuro;

  const op = Math.min(1, Math.max(0.05, (Number(a.opacidad) ?? DEFECTOS.opacidad) / 100));
  const desenfoque = Math.max(2, Math.round(anchoLogo * 0.02));
  const desplaz = Math.max(1, Math.round(anchoLogo * 0.012));
  // Con cx/cy el logo va donde lo dejaron (centro en % del lienzo), sin salirse del borde.
  const pos = libre
    ? [`max(0\\,min(W-w\\,${Math.round(info.ancho * Number(a.cx) / 100)}-w/2))`, `max(0\\,min(H-h\\,${Math.round(info.alto * Number(a.cy) / 100)}-h/2))`]
    : { 'arriba-izq': [`${margen}`, `${margen}`], 'arriba-der': [`W-w-${margen}`, `${margen}`],
      'abajo-izq': [`${margen}`, `H-h-${margen}`], 'abajo-der': [`W-w-${margen}`, `H-h-${margen}`], centro: ['(W-w)/2', '(H-h)/2'] }[posicion];

  const filtro = [
    `[1:v]scale=${anchoLogo}:-1,format=rgba,colorchannelmixer=aa=${op.toFixed(3)}[lg]`,
    '[lg]split[lg1][lg2]',
    // Sombra suave: copia negra y difuminada del logo, un poco corrida.
    `[lg2]colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0:aa=0.55,boxblur=${desenfoque}:1:${desenfoque}:1[sh]`,
    `[0:v][sh]overlay=${pos[0]}+${desplaz}:${pos[1]}+${desplaz}:format=auto[conSombra]`,
    `[conSombra][lg1]overlay=${pos[0]}:${pos[1]}:format=auto`,
  ].join(';');

  const salida = path.join(path.dirname(entrada), `marca-${crypto.randomBytes(4).toString('hex')}${esVideo ? '.mp4' : '.png'}`);
  const args = ['-y', '-i', entrada, '-i', logo, '-filter_complex', esVideo ? `${filtro},format=yuv420p` : filtro];
  if (esVideo) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-map', '0:a?', '-c:a', 'copy');
  args.push('-frames:v', esVideo ? '99999' : '1', salida);
  await correr(FFMPEG, args);
  return { salida, posicion: libre ? null : posicion, cx: libre ? Number(a.cx) : null, cy: libre ? Number(a.cy) : null,
    tamPct: Math.round((anchoLogo / info.ancho) * 1000) / 10, opacidad: Math.round(op * 100),
    version, brillo, esVideo, ancho: info.ancho, alto: info.alto };
}

/**
 * Qué tan claro es el dibujo del logo (0 = negro, 255 = blanco), mirando SOLO lo que se ve
 * (pesa cada pixel por su transparencia). Sirve para saber si el logo es la versión clara
 * (para fotos oscuras) o la oscura (para fotos claras). Devuelve null si no se pudo medir.
 */
async function luminanciaDe(bytes, ext = 'png') {
  const dir = await carpetaTemp();
  try {
    const entrada = path.join(dir, `logo.${ext}`);
    const crudo = path.join(dir, 'crudo.rgba');
    await fs.writeFile(entrada, bytes);
    // Se achica primero: alcanza de sobra para el promedio y no come memoria.
    await correr(FFMPEG, ['-y', '-v', 'error', '-i', entrada, '-vf', 'scale=128:-1,format=rgba', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', crudo], { timeoutMs: 30000 });
    const b = await fs.readFile(crudo);
    let suma = 0; let peso = 0;
    for (let i = 0; i < b.length; i += 4) {
      const a = b[i + 3] / 255;
      if (a < 0.2) continue; // lo transparente no cuenta
      suma += (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]) * a;
      peso += a;
    }
    return peso > 20 ? Math.round(suma / peso) : null;
  } catch { return null; } finally { await borrarCarpeta(dir); }
}

/**
 * Deja transparente el fondo blanco de un logo (muchos vienen en JPG o PNG con fondo liso).
 * Devuelve un PNG nuevo. Si el logo ya trae transparencia, no le pasa nada.
 */
async function quitarFondo(bytes, ext = 'png') {
  const dir = await carpetaTemp();
  try {
    const entrada = path.join(dir, `logo.${ext}`);
    const salida = path.join(dir, 'logo-sin-fondo.png');
    await fs.writeFile(entrada, bytes);
    await correr(FFMPEG, ['-y', '-v', 'error', '-i', entrada, '-vf', 'colorkey=0xFFFFFF:0.12:0.04,format=rgba', '-frames:v', '1', salida], { timeoutMs: 60000 });
    return await fs.readFile(salida);
  } finally { await borrarCarpeta(dir); }
}

/** Carpeta temporal propia (se borra sola con borrarCarpeta). */
async function carpetaTemp() { return fs.mkdtemp(path.join(os.tmpdir(), 'marca-')); }
const borrarCarpeta = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

module.exports = { ponerMarca, quitarFondo, luminanciaDe, centroDe, medir, brilloDe, posicionPara, caja, disponible, carpetaTemp, borrarCarpeta, POSICIONES, DEFECTOS, ErrorDeMarca };
