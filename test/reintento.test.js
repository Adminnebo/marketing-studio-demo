// Reintento automatico tras un rechazo del filtro de contenido (lib/reintento.js).
// Los motivos se prueban sin base; el reintento completo pide Postgres real.
const test = require('node:test');
const assert = require('node:assert/strict');

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.OPENAI_API_KEY ||= 'clave-de-prueba'; // solo para que el corrector cuente como configurado (las llamadas van simuladas)
const reintento = require('../server/lib/reintento');

test('motivo: solo los rechazos del filtro, no las fallas de verdad', () => {
  assert.equal(reintento.motivoDe({ estados: ['nsfw'] }), 'nsfw');
  assert.equal(reintento.motivoDe({ estados: ['completed', 'nsfw'] }), 'nsfw');
  assert.equal(reintento.motivoDe({ mensaje: 'Request blocked by content policy' }), 'nsfw');
  assert.equal(reintento.motivoDe({ mensaje: 'moderation flagged the prompt' }), 'nsfw');
  assert.equal(reintento.motivoDe({ mensaje: 'Copyrighted character detected' }), 'copyright');
  assert.equal(reintento.motivoDe({ mensaje: 'trademark infringement' }), 'copyright');
  // Nada de esto se reintenta: no es el filtro.
  assert.equal(reintento.motivoDe({ estados: ['failed'] }), null);
  assert.equal(reintento.motivoDe({ estados: ['expired', 'canceled'] }), null);
  assert.equal(reintento.motivoDe({ mensaje: 'not_enough_credits' }), null);
  assert.equal(reintento.motivoDe({ mensaje: 'create sin job_ids: {}' }), null);
  assert.equal(reintento.motivoDe({}), null);
});

test('la entrada corregida guarda el prompt nuevo y de dónde viene', () => {
  const g = { id: 7, entrada: { tool: 'generate_video', params: { prompt: 'viejo', input_images: ['m1'] }, libre: { duracion: 5 } } };
  const e = reintento.entradaCorregida(g, { prompt: 'nuevo', motivo: 'nsfw', intento: 1, avisos: ['saqué la piel descubierta'] });
  assert.match(e.params.prompt, /^nuevo/);
  assert.match(e.params.prompt, /LANGUAGE: Spanish/);        // la clausula de idioma se mantiene
  assert.deepEqual(e.params.input_images, ['m1']);           // la foto y el resto no cambian
  assert.deepEqual(e.reintento, { de: 7, motivo: 'nsfw', intento: 1, avisos: ['saqué la piel descubierta'] });
  assert.equal(reintento.intentoDe({ entrada: e }), 1);
  // Plantilla: se corrige entrada.args.prompt.
  const p = reintento.entradaCorregida({ id: 9, entrada: { args: { prompt: 'viejo', preset_id: 'x' } } }, { prompt: 'nuevo', motivo: 'copyright', intento: 1 });
  assert.match(p.args.prompt, /^nuevo/);
  assert.equal(p.args.preset_id, 'x');
  assert.equal(p.reintento.de, 9);
});

test('el prompt a corregir sale de la generación libre o de la plantilla', () => {
  assert.deepEqual(reintento.promptDe({ entrada: { params: { prompt: 'a' } } }), { texto: 'a', donde: 'libre' });
  assert.deepEqual(reintento.promptDe({ entrada: { args: { prompt: 'b' } } }), { texto: 'b', donde: 'plantilla' });
  assert.equal(reintento.promptDe({ entrada: {} }), null);
});

if (!process.env.TEST_DATABASE_URL) {
  test('reintento con base (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  const { pool, migrar } = require('../server/lib/db');
  const promptAuto = require('../server/lib/prompt-auto');
  const ajustes = require('../server/lib/config');
  const auth = require('../server/lib/auth');
  const worker = require('../server/worker');

  const PROMPT_MALO = 'PRODUCT: "Breaker": a two-pole breaker. A hand with bare skin inserts it deep into the panel. '.repeat(4);
  let corregidos = [];

  test.before(async () => {
    await migrar();
    await ajustes.guardar({ reintento_moderacion: 1 }, 'test');
    // Sin llamar a OpenAI ni a Supabase: la correccion y el rol se simulan.
    promptAuto.corregir = async (d) => { corregidos.push(d); return { prompt: 'CORREGIDO: ' + 'x'.repeat(250), avisos: ['saqué la piel descubierta'], modelo: 'gpt-4.1', tokens: { entrada: 100, salida: 200 } }; };
    promptAuto.corregirTexto = async (d) => { corregidos.push(d); return { prompt: 'texto corregido', avisos: [], modelo: 'gpt-4.1', tokens: { entrada: 10, salida: 20 } }; };
    auth.rolMarketing = async () => ({ rol: 'super_admin' }); // no cobra: el saldo no es lo que probamos aca
  });
  test.beforeEach(async () => {
    corregidos = [];
    await pool.query('TRUNCATE pagos_eventos, billetera, generaciones RESTART IDENTITY CASCADE');
  });
  test.after(async () => { await ajustes.guardar({ reintento_moderacion: 1 }, 'test'); });

  const crear = async (entrada, tipo = 'libre_video') => {
    const { rows: [g] } = await pool.query(
      `INSERT INTO generaciones (creado_por, preset_id, preset_nombre, preset_tipo, portada, entrada, estado, creditos_estimados, precio_usd)
       VALUES ('vendedor@jh.com','veo3','Veo 3',$1,'{"url":"https://cdn/foto.jpg"}',$2,'fallido', 100, 1.5) RETURNING *`,
      [tipo, JSON.stringify(entrada)]
    );
    return g;
  };
  const libre = { tool: 'generate_video', params: { prompt: PROMPT_MALO, input_images: ['m1'] },
    libre: { modelo: 'veo3', aspecto: '9:16', duracion: 10, opciones: { generate_audio: true } },
    producto: { media_id: 'm1', url: 'https://cdn/foto.jpg', nombre: 'Breaker 2P 40A' } };

  test('rechazo nsfw: corrige el prompt y encola una creación nueva', async () => {
    const g = await crear(libre);
    const r = await reintento.intentar(g, 'nsfw');
    assert.ok(r, 'tenía que reintentar');
    assert.equal(r.intento, 1);
    // A la IA le llegó el prompt rechazado, el motivo y el contexto del video.
    assert.equal(corregidos.length, 1);
    assert.equal(corregidos[0].motivo, 'nsfw');
    assert.equal(corregidos[0].promptRechazado, PROMPT_MALO);
    assert.equal(corregidos[0].duracion, 10);
    assert.equal(corregidos[0].conAudio, true);
    assert.equal(corregidos[0].imagenUrl, 'https://cdn/foto.jpg');
    // La creacion nueva queda pendiente, con el prompt corregido y la marca del reintento.
    const { rows: [nueva] } = await pool.query('SELECT * FROM generaciones WHERE id = $1', [r.id]);
    assert.equal(nueva.estado, 'pendiente');
    assert.match(nueva.entrada.params.prompt, /^CORREGIDO:/);
    assert.deepEqual(nueva.entrada.params.input_images, ['m1']);
    assert.equal(nueva.entrada.reintento.de, g.id);
    assert.equal(nueva.preset_tipo, 'libre_video');
    // Y la rechazada apunta a su reintento.
    const { rows: [vieja] } = await pool.query('SELECT reintento_id FROM generaciones WHERE id = $1', [g.id]);
    assert.equal(vieja.reintento_id, r.id);
  });

  test('plantilla: se corrige el texto, no el prompt de video', async () => {
    const g = await crear({ args: { prompt: 'un electricista sin camisa', preset_id: 'badge' }, preset: { id: 'badge' } }, 'marketplace');
    const r = await reintento.intentar(g, 'copyright');
    assert.ok(r);
    assert.equal(corregidos[0].texto, 'un electricista sin camisa');
    assert.equal(corregidos[0].promptRechazado, undefined);
    const { rows: [nueva] } = await pool.query('SELECT entrada FROM generaciones WHERE id = $1', [r.id]);
    assert.match(nueva.entrada.args.prompt, /^texto corregido/);
  });

  test('no se encadena: un reintento no se reintenta de nuevo', async () => {
    const g = await crear({ ...libre, reintento: { de: 1, motivo: 'nsfw', intento: 1 } });
    assert.equal(await reintento.intentar(g, 'nsfw'), null);
    assert.equal(corregidos.length, 0);
  });

  test('apagado en ajustes: no reintenta nada', async () => {
    await ajustes.guardar({ reintento_moderacion: 0 }, 'test');
    const g = await crear(libre);
    assert.equal(await reintento.intentar(g, 'nsfw'), null);
    await ajustes.guardar({ reintento_moderacion: 1 }, 'test');
  });

  test('sin motivo de filtro no se toca nada', async () => {
    const g = await crear(libre);
    assert.equal(await reintento.intentar(g, null), null);
    assert.equal(corregidos.length, 0);
  });

  test('el worker avisa en la fallida que se reintentó', async () => {
    const g = await crear(libre);
    await pool.query(`UPDATE generaciones SET error = 'El filtro de contenido del generador rechazó esta creación. Prueba con otra imagen o descripción.' WHERE id = $1`, [g.id]);
    await worker.reintentarCorregido(g.id, 'nsfw');
    const { rows: [vieja] } = await pool.query('SELECT error, reintento_id FROM generaciones WHERE id = $1', [g.id]);
    assert.match(vieja.error, /Se reintentó solo con la descripción corregida \(creación #\d+\)/);
    assert.ok(vieja.reintento_id);
  });
}
