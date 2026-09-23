// Plantillas propias: la receta que se saca de un diseño y su guardado (lib/plantillas-propias.js).
const test = require('node:test');
const assert = require('node:assert/strict');

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.OPENAI_API_KEY ||= 'clave-de-prueba';
const propias = require('../server/lib/plantillas-propias');

test('el pedido lleva la imagen, para qué es la plantilla y las reglas', () => {
  const b = propias.pedido({ imagenUrl: 'https://cdn/diseno.png', para: 'video', nombre: 'el azul de siempre' });
  assert.equal(b.instructions, propias.INSTRUCCIONES);
  const [img, txt] = b.input[0].content;
  assert.deepEqual(img, { type: 'input_image', image_url: 'https://cdn/diseno.png', detail: 'high' });
  assert.match(txt.text, /para hacer VIDEOS/);
  assert.match(txt.text, /"el azul de siempre"/);
  assert.equal(b.text.format.strict, true);
  // Las reglas prohíben copiar el producto y las marcas del ejemplo: es lo que hace reutilizable la receta.
  assert.match(propias.INSTRUCCIONES, /no lo nombres, no lo describas/);
  assert.match(propias.INSTRUCCIONES, /Marcas ajenas, logos de otras empresas/);
  const f = propias.pedido({ imagenUrl: 'https://cdn/d.png', para: 'foto' });
  assert.match(f.input[0].content[1].text, /para hacer FOTOS/);
  assert.match(f.input[0].content[1].text, /duracion_s va en null/);
  assert.throws(() => propias.pedido({ imagenUrl: 'ftp://x', para: 'foto' }), /Falta la imagen/);
});

test('las reglas no permiten pedir huecos vacíos ni copiar marcas del ejemplo', () => {
  // El fallo real: la receta pedía "reserve blank space only" y la pieza salía como una hoja en blanco.
  assert.match(propias.INSTRUCCIONES, /NUNCA pidas dejar áreas vacías/);
  assert.match(propias.INSTRUCCIONES, /las palabras las escribe el usuario/);
  assert.match(propias.INSTRUCCIONES, /Códigos QR, sellos de garantía/);
  assert.match(propias.INSTRUCCIONES, /El logo de JH tampoco se dibuja/);
});

test('valida lo que llega del navegador', () => {
  const v = propias.valida({ nombre: '  Ficha sobre azul  ', para: 'video', receta: 'x'.repeat(60), aspecto: '4:5', duracion: 99 });
  assert.equal(v.nombre, 'Ficha sobre azul');
  assert.equal(v.aspecto, '4:5');
  assert.equal(v.duracion, 30, 'la duración se recorta al máximo');
  assert.equal(propias.valida({ nombre: 'x', para: 'foto', receta: 'y'.repeat(60) }).duracion, null, 'una plantilla de fotos no lleva duración');
  assert.equal(propias.valida({ nombre: 'x', para: 'lo-que-sea', receta: 'y'.repeat(60), aspecto: 'raro' }).aspecto, '9:16', 'un formato inventado cae al de siempre');
  assert.throws(() => propias.valida({ nombre: '', para: 'foto', receta: 'y'.repeat(60) }), /nombre/);
  assert.throws(() => propias.valida({ nombre: 'x', para: 'foto', receta: 'corta' }), /receta es muy corta/);
});

if (!process.env.TEST_DATABASE_URL) {
  test('guardado (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  const { pool, migrar } = require('../server/lib/db');
  const RECETA = 'El producto entra centrado sobre un fondo azul profundo, con luz lateral suave y un acento amarillo abajo. La cámara se acerca despacio y cierra casi quieta. Hay espacio para el logo arriba a la derecha.';

  test.before(async () => { await migrar(); await pool.query('TRUNCATE plantillas_propias RESTART IDENTITY'); });
  test.after(async () => { await pool.end(); });

  test('crear, listar, editar y borrar una plantilla propia', async () => {
    const f = await propias.crear(
      { nombre: 'Producto sobre azul', para: 'video', receta: RECETA, aspecto: '9:16', duracion: 10, conAudio: true },
      { email: 'vendedor@jh.com', portada: { url: 'https://cdn/diseno.png' }, origen: { media_id: 'm1', url: 'https://cdn/diseno.png' } }
    );
    assert.equal(f.nombre, 'Producto sobre azul');
    assert.equal(f.para, 'video');
    assert.equal(f.duracion, 10);
    assert.equal(f.con_audio, true);
    assert.equal(f.usos, 0);
    assert.equal(f.portada.url, 'https://cdn/diseno.png');

    assert.equal((await propias.listar()).length, 1, 'las plantillas son compartidas: se listan para todos');

    const ed = await propias.editar(f.id, { nombre: 'Producto sobre azul v2', para: 'video', receta: RECETA, aspecto: '1:1', duracion: 8, conAudio: false });
    assert.equal(ed.nombre, 'Producto sobre azul v2');
    assert.equal(ed.aspecto, '1:1');

    await propias.usada(f.id);
    assert.equal((await propias.leer(f.id)).usos, 1, 'cuenta los usos');

    assert.equal(await propias.borrar(f.id), true);
    assert.equal(await propias.leer(f.id), null);
    assert.equal((await propias.listar()).length, 0);
    // Se marca eliminada, no se borra: las creaciones que salieron de ella siguen apuntando aquí.
    const { rows } = await pool.query('SELECT eliminada FROM plantillas_propias WHERE id = $1', [f.id]);
    assert.equal(rows[0].eliminada, true);
    assert.equal(await propias.borrar(f.id), false, 'borrar dos veces no hace nada');
  });

  test('analizar: recorta, valida el formato y exige una receta de verdad', async () => {
    const promptAuto = require('../server/lib/prompt-auto');
    const original = promptAuto.llamarDatos;
    promptAuto.llamarDatos = async () => ({ datos: { nombre: ' Mi   plantilla ', receta: RECETA, aspecto: 'inventado', duracion_s: 99, avisos: ['ojo con el texto', ''] }, modelo: 'gpt-4.1', entrada: 900, salida: 300 });
    const r = await propias.analizar({ imagenUrl: 'https://cdn/d.png', para: 'video' });
    assert.equal(r.nombre, 'Mi plantilla');
    assert.equal(r.aspecto, '9:16');
    assert.equal(r.duracion, 30);
    assert.deepEqual(r.avisos, ['ojo con el texto']);
    assert.deepEqual(r.tokens, { entrada: 900, salida: 300 });
    // Para fotos no hay duración, aunque la IA proponga una.
    const f = await propias.analizar({ imagenUrl: 'https://cdn/d.png', para: 'foto' });
    assert.equal(f.duracion, null);
    // Una receta vacía o de una línea no sirve como plantilla.
    promptAuto.llamarDatos = async () => ({ datos: { nombre: 'x', receta: 'bonito', aspecto: '9:16', duracion_s: null, avisos: [] }, modelo: 'gpt-4.1', entrada: 1, salida: 1 });
    await assert.rejects(() => propias.analizar({ imagenUrl: 'https://cdn/d.png', para: 'foto' }), /no pudo sacar una receta/);
    promptAuto.llamarDatos = original;
  });
}
