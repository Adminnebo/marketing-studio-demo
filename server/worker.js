/**
 * Worker de Marketing Studio. Ciclo cada POLL_MS:
 *  1. Toma generaciones 'pendiente' (FOR UPDATE SKIP LOCKED), las manda a
 *     Higgsfield con marketing_studio_v2_create y guarda los job_ids.
 *  2. Revisa las 'en_proceso' con marketing_studio_v2_status (hasta 8 jobs por
 *     llamada) y guarda las URLs de resultado al terminar.
 *  3. Mantiene vivo el token (renueva antes de que venza).
 *
 * Crear NO es idempotente (cobra creditos): si el worker muere entre el create
 * y guardar los job_ids, la fila queda 'enviando' y se marca fallida para
 * revisar a mano, nunca se reenvia sola.
 */
require('dotenv').config();
const { pool, migrar } = require('./lib/db');
const hf = require('./lib/higgsfield');
const zernio = require('./lib/zernio');
const billetera = require('./lib/billetera');
const saldoMarketing = require('./lib/saldo-marketing');
const marcarGen = require('./lib/marcar-generacion');
const logos = require('./lib/logos');
const modelos = require('./lib/modelos');
const catalogo = require('./lib/catalogo');
const clasificar = require('./lib/clasificar');
const costo = require('./lib/costo');
const hfCli = require('./lib/hf-cli');
const pagos = require('./lib/pagos');
const reintento = require('./lib/reintento');
const wallet = require('./lib/wallet');
const ajustes = require('./lib/config');
const promptAuto = require('./lib/prompt-auto');

const redesP = import('../shared/redes.mjs');

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 4000;
const REVISAR_CADA_MS = 8000;            // cada cuanto consultar un job en proceso
const TIMEOUT_MIN = Number(process.env.WORKER_TIMEOUT_MIN) || 45;
const ENVIANDO_ATASCADO_MIN = 10;
const TERMINADOS_OK = new Set(['completed', 'succeeded', 'success']);
const TERMINADOS_MAL = new Set(['failed', 'error', 'nsfw', 'canceled', 'cancelled', 'rejected', 'expired']);

const SIN_CREDITOS = /not_enough_credits|out of credits|insufficient credits|not enough credits/i;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function enviar(g) {
  // Modelos que solo tiene la CLI (Cinema Studio 4.0...): crea con la CLI; el seguimiento
  // es el mismo job_status de abajo (el generador ve esos trabajos igual).
  if (g.entrada.tool === 'cli') return modelos.crearCli(g.entrada.params);
  // Generacion libre: generate_video / generate_image con los params ya armados.
  if (g.entrada.tool) {
    const r = await modelos.llamarGenerador(g.entrada.tool, g.entrada.params);
    const ids = [...(r.results || []), ...(r.jobs || [])].map((x) => x?.id).concat(r.job_ids || [])
      .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (!ids.length) throw new Error('create sin job_ids: ' + JSON.stringify(r).slice(0, 300));
    return [...new Set(ids)];
  }
  const args = { ...g.entrada.args };
  // product_shots_people con avatar: el avatar va como imagen importada.
  const av = g.entrada.avatar;
  if (av && g.preset_tipo === 'product_shots_people') {
    const imp = await hf.llamar('media_import_url', { url: av.preview_url, type: 'image' });
    if (!imp.media_id) throw new Error('No se pudo importar la imagen del avatar.');
    args.avatar_media_id = imp.media_id;
  }
  const r = await hf.llamar('marketing_studio_v2_create', args, { timeoutMs: 120000 });
  const ids = (r.job_ids || []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  if (!ids.length) throw new Error('create sin job_ids: ' + JSON.stringify(r).slice(0, 300));
  return ids;
}

const AVISO_FILTRO = 'El filtro de contenido del generador rechazó esta creación. Prueba con otra imagen o descripción.';

// Rechazo del filtro de contenido (nsfw o marcas): se corrige el prompt y se vuelve a
// encolar sola (lib/reintento.js). Si no se pudo, la creacion queda fallida como siempre.
async function reintentarCorregido(id, filtro) {
  try {
    const fila = await reintento.fila(id);
    const r = fila && (await reintento.intentar(fila, filtro, { log }));
    if (!r) return;
    await pool.query(`UPDATE generaciones SET error = $2 WHERE id = $1`,
      [id, `${AVISO_FILTRO} Se reintentó solo con la descripción corregida (creación #${r.id}).`]);
    log(`#${id} rechazada por ${filtro}: reintento corregido #${r.id} (intento ${r.intento})`);
  } catch (e) {
    log(`#${id} no se pudo reintentar corregido: ${e.message}`);
  }
}

// Devuelve a la billetera lo cobrado por una generacion que no salio.
// (Las 'enviando' atascadas NO se devuelven solas: puede que si se haya generado.)
async function devolver(id) {
  const cr = await billetera.reembolsar(id).catch((e) => { log(`#${id} no se pudo reembolsar: ${e.message}`); return 0; });
  if (cr) log(`#${id} reembolso de ${cr} creditos a la billetera`);
  const usd = await saldoMarketing.reembolsar(id).catch((e) => { log(`#${id} no se pudo devolver al saldo de Marketing: ${e.message}`); return 0; });
  if (usd) log(`#${id} devolucion de ${usd} USD al saldo de Marketing`);
}

// Costo por credito automatico (lib/costo.js), cada 6 h.
const COSTO_CADA_MS = 6 * 60 * 60e3;
let ultimoCosto = 0;
async function actualizarCosto() {
  if (Date.now() - ultimoCosto < COSTO_CADA_MS) return;
  ultimoCosto = Date.now();
  const r = await costo.actualizarCosto('worker');
  if (r.antes !== r.ahora) log(`costo por credito: ${r.antes} -> ${r.ahora} (${r.info.fuente})`);
}

async function tomarPendientes() {
  const { rows } = await pool.query(
    `UPDATE generaciones SET estado = 'enviando', enviado = now()
     WHERE id IN (SELECT id FROM generaciones WHERE estado = 'pendiente' ORDER BY id LIMIT 3 FOR UPDATE SKIP LOCKED)
     RETURNING *`
  );
  for (const g of rows) {
    try {
      const ids = await enviar(g);
      await pool.query(`UPDATE generaciones SET estado = 'en_proceso', hf_job_ids = $2, revisado = now() WHERE id = $1`, [g.id, ids]);
      log(`#${g.id} enviada (${g.preset_tipo} "${g.preset_nombre}") jobs=${ids.join(',')}`);
    } catch (e) {
      // Si el error es de conexion (token), la dejamos pendiente para cuando vuelva.
      const estado = e.desconectado ? 'pendiente' : 'fallido';
      const filtro = e.desconectado ? null : reintento.motivoDe({ mensaje: e.message });
      const aviso = e.desconectado ? null
        : SIN_CREDITOS.test(e.message)
          ? 'La cuenta del generador se quedó sin créditos. Avísale al administrador; los créditos de esta creación se devolvieron.'
        : filtro ? AVISO_FILTRO
        : /sin job_ids/.test(e.message)
          ? 'El pedido se recibió pero no se confirmó. Avísale al administrador antes de repetir (puede que sí se haya generado).'
          : 'No se pudo enviar la generación. Revisa la imagen y la descripción e intenta de nuevo.';
      await pool.query(`UPDATE generaciones SET estado = $2, error = $3, error_detalle = $4, terminado = CASE WHEN $2 = 'fallido' THEN now() END WHERE id = $1`,
        [g.id, estado, aviso, e.message.slice(0, 1000)]);
      log(`#${g.id} no se pudo enviar: ${e.message}`);
      if (estado === 'fallido') await devolver(g.id);
      if (filtro) await reintentarCorregido(g.id, filtro);
    }
  }
}

async function revisarEnProceso() {
  const { rows } = await pool.query(
    `SELECT id, hf_job_ids, enviado, resultados, (entrada ? 'tool') AS libre FROM generaciones
     WHERE estado = 'en_proceso' AND (revisado IS NULL OR revisado < now() - ($1 || ' milliseconds')::interval)
     ORDER BY revisado NULLS FIRST LIMIT 8`, [REVISAR_CADA_MS]
  );
  if (!rows.length) return;
  // Plantillas: marketing_studio_v2_status en lote. Libres: job_status por job.
  const ids = [...new Set(rows.filter((g) => !g.libre).flatMap((g) => g.hf_job_ids))].slice(0, 8);
  const porId = new Map();
  if (ids.length) {
    const d = await hf.llamar('marketing_studio_v2_status', { job_ids: ids });
    for (const j of d.jobs || []) porId.set(j.id, j);
  }
  for (const id of rows.filter((g) => g.libre).flatMap((g) => g.hf_job_ids)) {
    const d = await hf.llamar('job_status', { jobId: id });
    const gen = d.generation || d;
    porId.set(id, { id, status: gen.status, result_url: gen.results?.rawUrl || gen.results?.url || null, min_result_url: gen.results?.minUrl || null, job_set_type: gen.type || null });
  }

  for (const g of rows) {
    const jobs = g.hf_job_ids.map((id) => porId.get(id)).filter(Boolean);
    if (jobs.length < g.hf_job_ids.length) {
      // Algun job no vino en este lote (tope de 8): se revisa la proxima vuelta.
      await pool.query('UPDATE generaciones SET revisado = now() WHERE id = $1', [g.id]);
      continue;
    }
    const st = jobs.map((j) => String(j.status || '').toLowerCase());
    const resultados = jobs.map((j) => ({ job_id: j.id, estado: j.status, url: j.result_url || null, miniatura: j.min_result_url || null, tipo: j.job_set_type || null }));
    if (st.every((s) => TERMINADOS_OK.has(s) || TERMINADOS_MAL.has(s))) {
      const ok = resultados.filter((r) => TERMINADOS_OK.has(String(r.estado).toLowerCase()) && r.url);
      if (ok.length) {
        // Marca de agua automatica (lib/marcar-generacion.js): queda pendiente y se pone en la proxima vuelta.
        const conLogo = Number((await ajustes.leer()).logo_auto) === 1 && !!(await logos.porDefecto().catch(() => null));
        await pool.query(`UPDATE generaciones SET estado = 'completado', resultados = $2, terminado = now(), revisado = now(), marca_estado = $3 WHERE id = $1`,
          [g.id, JSON.stringify(resultados), conLogo ? 'pendiente' : null]);
        log(`#${g.id} completada (${ok.length} resultado/s)${conLogo ? ' · le toca el logo' : ''}`);
        // Lo cobrado se debita del wallet de Marketing en la plataforma central (va por la cola).
        // Sin wallet configurado sigue el camino viejo (descuento del saldo general de JH).
        if (wallet.configurado()) {
          if (await wallet.informarGasto(g.id).catch((e) => { log(`#${g.id} no se pudo encolar el débito: ${e.message}`); return false; })) log(`#${g.id} débito encolado para el wallet de Marketing`);
        } else if (await pagos.informarConsumo(g.id).catch((e) => { log(`#${g.id} no se pudo encolar el descuento: ${e.message}`); return false; })) {
          log(`#${g.id} descuento encolado para la plataforma de pagos`);
        }
      } else {
        const filtro = reintento.motivoDe({ estados: st });
        const motivo = filtro ? AVISO_FILTRO : 'La generación falló. Intenta de nuevo o prueba otra plantilla.';
        await pool.query(`UPDATE generaciones SET estado = 'fallido', resultados = $2, error = $3, error_detalle = $4, terminado = now(), revisado = now() WHERE id = $1`,
          [g.id, JSON.stringify(resultados), motivo, 'estados: ' + st.join(', ')]);
        log(`#${g.id} fallida: ${st.join(',')}`);
        await devolver(g.id); // primero se devuelve: el reintento se cobra igual que una creacion nueva
        if (filtro) await reintentarCorregido(g.id, filtro);
      }
    } else if (Date.now() - new Date(g.enviado).getTime() > TIMEOUT_MIN * 60e3) {
      await pool.query(`UPDATE generaciones SET estado = 'fallido', resultados = $2, error = $3, terminado = now() WHERE id = $1`,
        [g.id, JSON.stringify(resultados), `No terminó en ${TIMEOUT_MIN} minutos. Intenta de nuevo.`]);
      log(`#${g.id} vencida tras ${TIMEOUT_MIN} min`);
      await devolver(g.id);
    } else {
      await pool.query('UPDATE generaciones SET revisado = now(), resultados = $2 WHERE id = $1', [g.id, JSON.stringify(resultados)]);
    }
  }
}

async function liberarAtascadas() {
  const { rows } = await pool.query(
    `UPDATE generaciones SET estado = 'fallido', terminado = now(),
       error = 'El envío se interrumpió. Puede que sí se haya generado: avísale al administrador antes de repetir.'
     WHERE estado = 'enviando' AND enviado < now() - ($1 || ' minutes')::interval RETURNING id`, [ENVIANDO_ATASCADO_MIN]
  );
  for (const r of rows) log(`#${r.id} atascada en 'enviando', marcada fallida`);
}

// Publicaciones en redes: sigue el estado en Zernio hasta que salgan (o fallen).
// Las programadas solo se consultan desde su hora; las en curso, cada ~15 s.
async function revisarPublicaciones() {
  if (!zernio.configurado()) return;
  const { DESDE_ZERNIO, REDES } = await redesP;
  // Con webhooks los cambios llegan al momento; la consulta queda de respaldo y mas espaciada.
  const cada = zernio.webhookListo() ? '2 minutes' : '15 seconds';
  const { rows } = await pool.query(
    `SELECT id, zernio_post_id, estado FROM publicaciones
     WHERE zernio_post_id IS NOT NULL AND estado IN ('programada', 'publicando')
       AND (estado = 'publicando' OR programada_para IS NULL OR programada_para < now() + interval '1 minute')
       AND (revisado IS NULL OR revisado < now() - $1::interval)
     ORDER BY revisado NULLS FIRST LIMIT 10`, [cada]
  );
  for (const p of rows) {
    try {
      const { post } = await zernio.leerPost(p.zernio_post_id);
      const estado = DESDE_ZERNIO[post?.status] || p.estado;
      const plataformas = zernio.plataformasDe(post);
      const fallos = plataformas.filter((x) => x.status === 'failed');
      const error = fallos.length ? 'No salió en: ' + fallos.map((x) => REDES[x.platform]?.nombre || x.platform).join(', ') + '.' : null;
      await pool.query(
        `UPDATE publicaciones SET estado = $2, plataformas = $3, error = $4, error_detalle = $5, revisado = now(),
           actualizado = CASE WHEN estado <> $2 THEN now() ELSE actualizado END WHERE id = $1`,
        [p.id, estado, JSON.stringify(plataformas), error,
          fallos.length ? fallos.map((x) => `${x.platform}: ${x.errorMessage || 'error'}`).join(' | ').slice(0, 1000) : null]
      );
      if (estado !== p.estado) log(`publicacion #${p.id}: ${p.estado} -> ${estado}`);
    } catch (e) {
      await pool.query('UPDATE publicaciones SET revisado = now() WHERE id = $1', [p.id]);
      if (e.status === 404) await pool.query(`UPDATE publicaciones SET estado = 'cancelada' WHERE id = $1`, [p.id]);
      log(`publicacion #${p.id}: no se pudo leer (${e.message})`);
    }
  }
}

// Plantillas nuevas del generador: se clasifican solas cada 12 h (arranca a los 2 min).
const CLASIF_CADA_MS = 12 * 60 * 60e3;
let ultimaClasif = Date.now() - CLASIF_CADA_MS + 2 * 60e3;
async function clasificarPlantillas() {
  if (!clasificar.configurado() || Date.now() - ultimaClasif < CLASIF_CADA_MS) return;
  ultimaClasif = Date.now();
  catalogo.olvidar();
  const r = await clasificar.clasificarNuevas(await catalogo.todas(), { max: 60 });
  if (r.hechas || r.pendientes) log(`plantillas: ${r.hechas} nuevas clasificadas, quedan ${r.pendientes}`);
  if (r.uso?.entrada) await saldoMarketing.cobrarIa({ por: 'sistema', clase: 'clasificar', detalle: `${r.hechas} plantillas`, ...r.uso, aJh: true }).catch((e) => log(`clasificar: no se pudo registrar el costo (${e.message})`));
}

// Sesion de la CLI: se usa (y asi se renueva) cada 6 h aunque nadie genere con esos modelos.
const CLI_CADA_MS = 6 * 60 * 60e3;
let ultimaCli = 0;
async function mantenerCli() {
  if (!hfCli.instalada() || Date.now() - ultimaCli < CLI_CADA_MS) return;
  ultimaCli = Date.now();
  if (!(await hfCli.estado()).cargada) return;
  const c = await hfCli.cuenta();
  log(`sesion de la CLI ok: ${c.email} (${c.creditos} creditos)`);
}

let ultimoAviso = 0;
let ultimoLoteJh = 0;
async function ciclo() {
  try {
    await hf.accessToken(); // renueva si hace falta
    await liberarAtascadas();
    await tomarPendientes();
    await revisarEnProceso();
  } catch (e) {
    // No inundar los logs si el generador esta desconectado.
    if (Date.now() - ultimoAviso > 60e3) { log('Error en el ciclo:', e.message); ultimoAviso = Date.now(); }
  }
  try {
    await actualizarCosto();
  } catch (e) {
    log('No se pudo leer el costo por credito:', e.message);
  }
  try {
    await clasificarPlantillas();
  } catch (e) {
    log('No se pudieron clasificar plantillas:', e.message);
  }
  // Wallet de Marketing (plataforma central): debitar lo creado y las ayudas de IA.
  if (wallet.configurado()) {
    try {
      const f = await wallet.encolarFaltantes();
      if (f) log(`wallet: ${f} débito/s encolado/s que faltaban`);
      const cortados = await wallet.liberarEnviando();
      if (cortados) log(`wallet: ${cortados} débito/s cortado/s a mitad, quedan para revisar`);
      const r = await wallet.procesarCola();
      if (r.hechos) log(`wallet: ${r.hechos} débito/s aplicado/s${r.duplicados ? ` (${r.duplicados} ya estaban allá)` : ''}`);
    } catch (e) {
      log('Error con el wallet de Marketing:', e.message);
    }
  } else {
    // Modelo viejo: descontar del saldo general de JH (POST /api/credits/adjust).
    try {
      const f = await pagos.encolarFaltantes();
      if (f) log(`pagos: ${f} descuento/s encolado/s que faltaban`);
      const cortados = await pagos.liberarEnviando();
      if (cortados) log(`pagos: ${cortados} descuento/s cortado/s a mitad, quedan para revisar`);
      const r = await pagos.procesarCola();
      if (r.hechos) log(`pagos: ${r.hechos} descuento/s aplicado/s en la plataforma`);
    } catch (e) {
      log('Error con la plataforma de pagos:', e.message);
    }
  }
  // Marca de agua de lo recien creado (unas pocas por vuelta para no trancar el worker).
  try {
    for (const id of await marcarGen.pendientes(2)) {
      const r = await marcarGen.marcarGeneracion(id).catch(async (e) => {
        await pool.query(`UPDATE generaciones SET marca_estado = 'error', marca = $2 WHERE id = $1`, [id, JSON.stringify({ error: e.message.slice(0, 200) })]);
        log(`#${id} no se pudo poner el logo: ${e.message}`);
        return null;
      });
      if (r) log(`#${id} logo puesto (${r.hechas || 0} archivo/s, ${r.detalle?.posicion || r.motivo || '—'})`);
    }
  } catch (e) {
    log('Error poniendo logos:', e.message);
  }

  // IA de super admins y del sistema: al saldo general de JH, por lotes (cada 10 min).
  try {
    if (Date.now() - ultimoLoteJh > 10 * 60e3) {
      ultimoLoteJh = Date.now();
      const l = await saldoMarketing.enviarAJh();
      if (l) log(`IA a JH: lote #${l.lote} de $${l.usd} (${l.usos || '?'} usos) -> ${l.estado}${l.error ? ` (${l.error})` : ''}`);
    }
  } catch (e) {
    log('No se pudo enviar la IA de super admins a JH:', e.message);
  }
  try {
    await mantenerCli();
  } catch (e) {
    log('La sesion de la CLI fallo:', e.message);
  }
  // Aparte: una caida del generador no frena el seguimiento de publicaciones.
  try {
    await revisarPublicaciones();
  } catch (e) {
    log('Error revisando publicaciones:', e.message);
  }
}

let parar = false;
async function main() {
  await migrar();
  await saldoMarketing.migrar().catch((e) => log(`migracion del saldo de Marketing: ${e.message}`));
  await logos.migrar().catch((e) => log(`migracion de logos: ${e.message}`));
  if (await hf.sembrarToken()) log('Token de Higgsfield sembrado desde HF_REFRESH_TOKEN.');
  if (await hfCli.sembrar().catch((e) => log('HF_CLI_SESION invalida:', e.message))) log('Sesion de la CLI sembrada desde HF_CLI_SESION.');
  log(`Worker Marketing Studio arrancado (cada ${POLL_MS} ms)`);
  // Que se vea en los logs si el reintento por filtro de contenido puede funcionar (necesita la IA).
  const maxReintentos = Number((await ajustes.leer().catch(() => ({}))).reintento_moderacion || 0);
  log(`reintento por filtro de contenido: ${!promptAuto.configurado() ? 'APAGADO (falta OPENAI_API_KEY)' : maxReintentos > 0 ? `activo (hasta ${maxReintentos})` : 'apagado en ajustes'}`);
  if (wallet.configurado()) {
    const s = await wallet.leer().then((x) => `$${x.saldoUsd}`).catch((e) => `no se pudo leer (${e.message})`);
    log(`fuente de gasto: wallet de Marketing en la plataforma central · saldo ${s}`);
  } else {
    log('fuente de gasto: modelo viejo (saldo general de JH por /api/credits/adjust)');
  }
  while (!parar) {
    await ciclo();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await pool.end();
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { parar = true; });

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { ciclo, tomarPendientes, revisarEnProceso, liberarAtascadas, revisarPublicaciones, actualizarCosto, devolver, reintentarCorregido };
