/**
 * Receptor de webhooks de Zernio (POST /api/zernio/webhook). Verifica la firma
 * con el cuerpo crudo, descarta repetidos (llegan al menos una vez) y actualiza la
 * publicacion al momento, sin esperar la vuelta del worker (que queda de respaldo).
 */
const express = require('express');
const { pool } = require('./lib/db');
const zernio = require('./lib/zernio');

const redesP = import('../shared/redes.mjs');
const router = express.Router();

// Plataformas del payload -> forma que guardamos (la misma que devuelve GET /v1/posts/:id).
const plataformasDe = (post) => (post?.platforms || []).map((x) => ({
  platform: x.platform, status: x.status, accountId: x.accountId || null,
  platformPostUrl: x.publishedUrl || null, errorMessage: x.error || null,
}));

async function procesar(ev) {
  const { DESDE_ZERNIO, REDES } = await redesP;
  if (ev.event?.startsWith('post.') && ev.post?.id) {
    const plataformas = plataformasDe(ev.post);
    const estado = DESDE_ZERNIO[ev.post.status] || null;
    const fallos = plataformas.filter((x) => x.status === 'failed');
    const r = await pool.query(
      `UPDATE publicaciones SET plataformas = $2, estado = COALESCE($3, estado),
         error = $4, error_detalle = $5, revisado = now(), actualizado = now()
       WHERE zernio_post_id = $1 RETURNING id`,
      [ev.post.id, JSON.stringify(plataformas), estado,
        fallos.length ? 'No salió en: ' + fallos.map((x) => REDES[x.platform]?.nombre || x.platform).join(', ') + '.' : null,
        fallos.length ? fallos.map((x) => `${x.platform}: ${x.errorMessage || 'error'}`).join(' | ').slice(0, 1000) : null]
    );
    return r.rowCount ? `publicacion #${r.rows[0].id} -> ${estado || ev.post.status}` : 'post ajeno al panel';
  }
  if (ev.event === 'account.disconnected' || ev.event === 'account.connected') {
    return `cuenta ${ev.account?.platform || ''} @${ev.account?.username || ev.account?.accountId || ''} ${ev.event === 'account.connected' ? 'conectada' : 'DESCONECTADA'}`;
  }
  return 'sin accion';
}

router.post('/zernio/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!zernio.firmaValida(req.body, req.headers['x-zernio-signature'] || req.headers['x-late-signature'])) {
    return res.status(401).json({ error: 'firma invalida' });
  }
  let ev;
  try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'json invalido' }); }
  const id = String(ev.id || req.headers['x-zernio-event-id'] || '');
  if (!id) return res.status(400).json({ error: 'sin id' });
  try {
    const nuevo = await pool.query('INSERT INTO zernio_eventos (id, evento) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, String(ev.event || '')]);
    if (!nuevo.rowCount) return res.json({ ok: true, repetido: true });
    const r = await procesar(ev);
    console.log(`[zernio] ${ev.event}: ${r}`);
    res.json({ ok: true });
  } catch (e) {
    // Sin 2xx Zernio reintenta; se borra la marca para que el reintento se procese.
    await pool.query('DELETE FROM zernio_eventos WHERE id = $1', [id]).catch(() => {});
    console.error('[zernio webhook]', e.message);
    res.status(500).json({ error: 'error procesando' });
  }
});

module.exports = { router, procesar, plataformasDe };
