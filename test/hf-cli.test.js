// Sesion de la CLI en la base (rota como hf_token) y modelos que solo tiene la CLI.
// Usa una CLI falsa (HF_CLI_BIN). La parte con base requiere TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// CLI falsa: renueva credentials.json (como la real al vencer el token) y responde segun el comando.
const FALSA = path.join(os.tmpdir(), `hf-falsa-${process.pid}.js`);
fs.writeFileSync(FALSA, `
const fs = require('fs'); const path = require('path');
const f = path.join(process.env.XDG_CONFIG_HOME, 'higgsfield', 'credentials.json');
const c = JSON.parse(fs.readFileSync(f, 'utf8'));
const args = process.argv.slice(2);
if (c.refresh_token === 'vencido') { console.error('Error: not authenticated, run higgsfield auth login'); process.exit(1); }
c.refresh_token = c.refresh_token + '+'; fs.writeFileSync(f, JSON.stringify(c));
fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'higgsfield', 'args.json'), JSON.stringify(args));
if (args[0] === 'account') console.log(JSON.stringify({ email: 'admin@x.com', credits: 100, subscription_plan_type: 'ultra' }));
else if (args[1] === 'cost') console.log('aviso de version\\n' + JSON.stringify({ credits: 35 }));
else if (args[1] === 'create') console.log(JSON.stringify(['0b98bb61-ce87-47aa-ad5e-3e035321d7f3']));
else { console.error('Error: duration: Input should be less than or equal to 30'); process.exit(1); }
`);
process.env.HF_CLI_BIN = FALSA;

const paquete = (refresh) => Buffer.from(JSON.stringify({ archivos: {
  'credentials.json': Buffer.from(JSON.stringify({ refresh_token: refresh, access_token: 'a' })).toString('base64'),
  'config.json': Buffer.from(JSON.stringify({ workspace_id: 'w' })).toString('base64'),
} })).toString('base64');

const URL_BD = process.env.TEST_DATABASE_URL;
if (URL_BD) process.env.DATABASE_URL = URL_BD;
const hfCli = require('../server/lib/hf-cli');
const modelos = require('../server/lib/modelos');

test('paquete invalido o sin refresh_token se rechaza', () => {
  assert.throws(() => hfCli.leerPaquete('no-es-base64-json'), /no es válido/);
  const sinRefresh = Buffer.from(JSON.stringify({ archivos: { 'credentials.json': Buffer.from('{}').toString('base64') } })).toString('base64');
  assert.throws(() => hfCli.leerPaquete(sinRefresh), /refresh_token/);
  const malo = Buffer.from(JSON.stringify({ archivos: { 'credentials.json': Buffer.from('{"refresh_token":"x"}').toString('base64'), '../x': 'AA==' } })).toString('base64');
  assert.throws(() => hfCli.leerPaquete(malo), /inválido/);
});

test('Cinema Studio 4.0: imagen como start_image, modo segun haya imagen, argumentos sin shell', () => {
  const cs4 = modelos.CLI_MODELOS.find((m) => m.id === 'cinematic_studio_video_4_0');
  const con = modelos.armar(cs4, { prompt: 'linea 1\nlinea 2', aspecto: '9:16', duracion: 10, opciones: { resolution: '1080p', generate_audio: false }, mediaId: 'm1' });
  assert.equal(con.tool, 'cli');
  assert.deepEqual(con.params, { model: 'cinematic_studio_video_4_0', prompt: 'linea 1\nlinea 2', aspect_ratio: '9:16', duration: 10, resolution: '1080p', generate_audio: false, mode: 'omni_reference', start_image: 'm1' });
  assert.deepEqual(modelos.argsCli('create', con.params), ['generate', 'create', 'cinematic_studio_video_4_0', '--prompt', 'linea 1\nlinea 2', '--aspect-ratio', '9:16',
    '--duration', '10', '--resolution', '1080p', '--generate-audio=false', '--mode', 'omni_reference', '--start-image', 'm1']);
  const sin = modelos.armar(cs4, { prompt: 'p', duracion: 45 });
  assert.equal(sin.params.mode, 't2v');
  assert.equal(sin.params.duration, undefined, 'fuera de 4-30 s no se manda');
  const cs35 = modelos.armar(modelos.CLI_MODELOS.find((m) => m.id === 'cinematic_studio_video_3_5'), { prompt: 'p' });
  assert.equal(cs35.params.prompt_language, 'en');
});

if (!URL_BD) {
  test('sesion de la CLI en la base (sin TEST_DATABASE_URL, se salta)', { skip: true }, () => {});
} else {
  const { pool, migrar } = require('../server/lib/db');
  const refreshGuardado = async () => {
    const { rows: [s] } = await pool.query('SELECT archivos FROM hf_cli_sesion WHERE id = 1');
    return JSON.parse(Buffer.from(s.archivos['credentials.json'], 'base64').toString('utf8')).refresh_token;
  };

  test('sin sesion: error de desconexion (el worker deja la generacion pendiente)', async () => {
    await migrar();
    await pool.query('DELETE FROM hf_cli_sesion');
    await assert.rejects(hfCli.llamar(['account', 'status']), (e) => e.desconectado === true);
    assert.equal((await hfCli.estado()).cargada, false);
  });

  test('cada llamada guarda lo que la CLI renovo; el costo y el create salen de su JSON', async () => {
    await hfCli.guardarSesion(paquete('r0'), { por: 'test' });
    assert.equal((await hfCli.cuenta()).email, 'admin@x.com');
    assert.equal(await refreshGuardado(), 'r0+');
    const cs4 = modelos.CLI_MODELOS[0];
    assert.equal(await modelos.costo(modelos.armar(cs4, { prompt: 'p', duracion: 5 })), 35);
    assert.deepEqual(await modelos.crearCli(modelos.armar(cs4, { prompt: 'p' }).params), ['0b98bb61-ce87-47aa-ad5e-3e035321d7f3']);
    assert.equal(await refreshGuardado(), 'r0+++');
    const e = await hfCli.estado();
    assert.equal(e.cuenta, 'admin@x.com');
    assert.equal(e.desconectada, false);
  });

  test('llamadas simultaneas no pisan la sesion (una a la vez)', async () => {
    await hfCli.guardarSesion(paquete('s'), { por: 'test' });
    await Promise.all([1, 2, 3, 4].map(() => hfCli.cuenta()));
    assert.equal(await refreshGuardado(), 's++++');
  });

  test('error de la CLI: el de sesion marca desconectado, el de parametros no', async () => {
    await assert.rejects(hfCli.llamar(['generate', 'get', 'x']), (e) => e.desconectado === false && /less than or equal/.test(e.message));
    await hfCli.guardarSesion(paquete('vencido'), { por: 'test' });
    await assert.rejects(hfCli.llamar(['account', 'status']), (e) => e.desconectado === true);
    assert.equal((await hfCli.estado()).desconectada, true);
  });

  test('HF_CLI_SESION siembra solo si no hay sesion', async () => {
    process.env.HF_CLI_SESION = paquete('semilla');
    assert.equal(await hfCli.sembrar(), false);
    await pool.query('DELETE FROM hf_cli_sesion');
    assert.equal(await hfCli.sembrar(), true);
    assert.equal(await refreshGuardado(), 'semilla');
    delete process.env.HF_CLI_SESION;
    await pool.query('DELETE FROM hf_cli_sesion');
  });

  test.after(async () => { await pool.end(); fs.rmSync(FALSA, { force: true }); });
}
