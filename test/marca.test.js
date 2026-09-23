// Marca de agua con ffmpeg de verdad (se salta si no está instalado).
const test = require('node:test');
const assert = require('node:assert/strict');
const { promises: fs } = require('fs');
const path = require('path');
const marca = require('../server/lib/marca');

// PNG de un color liso (con alfa), para usar de logo o de lienzo.
function png(w, h, [r, g, b, a = 255]) {
  const zlib = require('zlib');
  const fila = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4).map((_, i) => [r, g, b, a][i % 4])]);
  const datos = zlib.deflateSync(Buffer.concat(Array(h).fill(fila)));
  const trozo = (t, d) => { const c = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(c) : require('zlib').crc32(c)); return Buffer.concat([l, c, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', ihdr), trozo('IDAT', datos), trozo('IEND', Buffer.alloc(0))]);
}

test('la esquina depende del formato: vertical arriba, lo demás abajo', () => {
  assert.equal(marca.posicionPara({ ancho: 1080, alto: 1920 }), 'arriba-izq');
  assert.equal(marca.posicionPara({ ancho: 1080, alto: 1080 }), 'abajo-der');
  assert.equal(marca.posicionPara({ ancho: 1920, alto: 1080 }), 'abajo-der');
  assert.equal(marca.posicionPara({ ancho: 1080, alto: 1920 }, { posVertical: 'arriba-der' }), 'arriba-der');
});

test('la caja del logo respeta el margen en cada esquina', () => {
  const l = { ancho: 1000, alto: 1000 };
  assert.deepEqual(marca.caja(l, 'arriba-izq', 200, 80, 40), { x: 40, y: 40 });
  assert.deepEqual(marca.caja(l, 'abajo-der', 200, 80, 40), { x: 760, y: 880 });
  assert.deepEqual(marca.caja(l, 'centro', 200, 80, 40), { x: 400, y: 460 });
});

const hay = require('child_process').spawnSync('ffmpeg', ['-version']).status === 0;
if (!hay) {
  test('marca de agua (sin ffmpeg, se salta)', { skip: true }, () => {});
} else {
  let dir;
  test.before(async () => { dir = await marca.carpetaTemp(); });
  test.after(() => marca.borrarCarpeta(dir));
  // Color medio de una zona del resultado, para comprobar que el logo quedó ahí.
  const colorEn = async (archivo, x, y) => {
    const salida = path.join(dir, `p-${Date.now()}.rawvideo`);
    await new Promise((res, rej) => require('child_process').execFile('ffmpeg', ['-y', '-v', 'error', '-i', archivo,
      '-vf', `crop=10:10:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', salida], (e) => (e ? rej(e) : res())));
    const b = await fs.readFile(salida);
    return [b[0], b[1], b[2]];
  };

  test('foto: el logo queda en la esquina que toca y con su sombra', async () => {
    const lienzo = path.join(dir, 'foto.png');
    await fs.writeFile(lienzo, png(800, 800, [250, 250, 250]));       // foto clara, cuadrada
    const rojo = path.join(dir, 'rojo.png');
    await fs.writeFile(rojo, png(300, 120, [220, 30, 30]));
    const r = await marca.ponerMarca(lienzo, { claro: rojo }, { tamPct: 20, margenPct: 5 });
    assert.equal(r.posicion, 'abajo-der'); // cuadrada -> abajo a la derecha
    assert.equal(r.esVideo, false);
    const [rr, gg] = await colorEn(r.salida, 700, 730); // dentro del logo
    assert.ok(rr > 180 && gg < 90, `esperaba rojo, salió ${rr},${gg}`);
    const esquinaLibre = await colorEn(r.salida, 20, 20); // la opuesta sigue limpia
    assert.deepEqual(esquinaLibre.map((c) => c > 240), [true, true, true]);
  });

  test('sobre fondo claro usa el logo oscuro (y al revés)', async () => {
    const claro = path.join(dir, 'lienzo-claro.png');
    const oscuro = path.join(dir, 'lienzo-oscuro.png');
    await fs.writeFile(claro, png(600, 600, [245, 245, 245]));
    await fs.writeFile(oscuro, png(600, 600, [12, 12, 12]));
    const logoClaro = path.join(dir, 'logo-claro.png');
    const logoOscuro = path.join(dir, 'logo-oscuro.png');
    await fs.writeFile(logoClaro, png(200, 80, [255, 255, 255]));
    await fs.writeFile(logoOscuro, png(200, 80, [10, 10, 10]));
    const sobreClaro = await marca.ponerMarca(claro, { claro: logoClaro, oscuro: logoOscuro }, {});
    assert.equal(sobreClaro.version, 'oscuro');
    assert.ok(sobreClaro.brillo > 200);
    const sobreOscuro = await marca.ponerMarca(oscuro, { claro: logoClaro, oscuro: logoOscuro }, {});
    assert.equal(sobreOscuro.version, 'claro');
  });

  test('video vertical: logo arriba, sigue siendo video y conserva la duración', async () => {
    const v = path.join(dir, 'v.mp4');
    await new Promise((res, rej) => require('child_process').execFile('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'color=c=0x101010:size=540x960:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v], (e) => (e ? rej(e) : res())));
    const logo = path.join(dir, 'logo-v.png');
    await fs.writeFile(logo, png(200, 80, [0, 200, 90]));
    const r = await marca.ponerMarca(v, { claro: logo }, { tamPct: 25, margenPct: 5 });
    assert.equal(r.posicion, 'arriba-izq');
    assert.equal(r.esVideo, true);
    const info = await marca.medir(r.salida);
    assert.equal(info.ancho, 540);
    assert.ok(Math.abs(info.duracion - 2) < 0.3, `duración ${info.duracion}`);
    const [, g] = await colorEn(r.salida, 50, 40);
    assert.ok(g > 120, `el logo no está arriba a la izquierda (verde ${g})`);
  });
}
