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

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 4000;
const REVISAR_CADA_MS = 8000;            // cada cuanto consultar un job en proceso
const TIMEOUT_MIN = Number(process.env.WORKER_TIMEOUT_MIN) || 45;
const ENVIANDO_ATASCADO_MIN = 10;
const TERMINADOS_OK = new Set(['completed', 'succeeded', 'success']);
const TERMINADOS_MAL = new Set(['failed', 'error', 'nsfw', 'canceled', 'cancelled', 'rejected', 'expired']);

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function enviar(g) {
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
      const aviso = e.desconectado ? null
        : /sin job_ids/.test(e.message)
          ? 'El pedido se recibió pero no se confirmó. Avísale al administrador antes de repetir (puede que sí se haya generado).'
          : 'No se pudo enviar la generación. Revisa la imagen y la descripción e intenta de nuevo.';
      await pool.query(`UPDATE generaciones SET estado = $2, error = $3, error_detalle = $4, terminado = CASE WHEN $2 = 'fallido' THEN now() END WHERE id = $1`,
        [g.id, estado, aviso, e.message.slice(0, 1000)]);
      log(`#${g.id} no se pudo enviar: ${e.message}`);
    }
  }
}

async function revisarEnProceso() {
  const { rows } = await pool.query(
    `SELECT id, hf_job_ids, enviado, resultados FROM generaciones
     WHERE estado = 'en_proceso' AND (revisado IS NULL OR revisado < now() - ($1 || ' milliseconds')::interval)
     ORDER BY revisado NULLS FIRST LIMIT 8`, [REVISAR_CADA_MS]
  );
  if (!rows.length) return;
  const ids = [...new Set(rows.flatMap((g) => g.hf_job_ids))].slice(0, 8);
  const d = await hf.llamar('marketing_studio_v2_status', { job_ids: ids });
  const porId = new Map((d.jobs || []).map((j) => [j.id, j]));

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
        await pool.query(`UPDATE generaciones SET estado = 'completado', resultados = $2, terminado = now(), revisado = now() WHERE id = $1`, [g.id, JSON.stringify(resultados)]);
        log(`#${g.id} completada (${ok.length} resultado/s)`);
      } else {
        const motivo = st.includes('nsfw') ? 'El contenido fue rechazado por el filtro de seguridad. Prueba con otra imagen o descripción.' : 'La generación falló. Intenta de nuevo o prueba otra plantilla.';
        await pool.query(`UPDATE generaciones SET estado = 'fallido', resultados = $2, error = $3, error_detalle = $4, terminado = now(), revisado = now() WHERE id = $1`,
          [g.id, JSON.stringify(resultados), motivo, 'estados: ' + st.join(', ')]);
        log(`#${g.id} fallida: ${st.join(',')}`);
      }
    } else if (Date.now() - new Date(g.enviado).getTime() > TIMEOUT_MIN * 60e3) {
      await pool.query(`UPDATE generaciones SET estado = 'fallido', resultados = $2, error = $3, terminado = now() WHERE id = $1`,
        [g.id, JSON.stringify(resultados), `No terminó en ${TIMEOUT_MIN} minutos. Intenta de nuevo.`]);
      log(`#${g.id} vencida tras ${TIMEOUT_MIN} min`);
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

let ultimoAviso = 0;
async function ciclo() {
  try {
    await hf.accessToken(); // renueva si hace falta
    await liberarAtascadas();
    await tomarPendientes();
    await revisarEnProceso();
  } catch (e) {
    // No inundar los logs si Higgsfield esta desconectado.
    if (Date.now() - ultimoAviso > 60e3) { log('Error en el ciclo:', e.message); ultimoAviso = Date.now(); }
  }
}

let parar = false;
async function main() {
  await migrar();
  if (await hf.sembrarToken()) log('Token de Higgsfield sembrado desde HF_REFRESH_TOKEN.');
  log(`Worker Marketing Studio arrancado (cada ${POLL_MS} ms)`);
  while (!parar) {
    await ciclo();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await pool.end();
}

for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { parar = true; });

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { ciclo, tomarPendientes, revisarEnProceso, liberarAtascadas };
