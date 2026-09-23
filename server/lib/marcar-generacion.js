/**
 * Le pone la marca de agua a lo que ya se creó (lo corre el worker en cada vuelta).
 *
 * Por cada resultado: lo baja, le pone el logo con ffmpeg (lib/marca.js) y sube la copia al
 * generador para que tenga URL pública (la misma vía que usamos para las fotos de producto).
 * El original NO se toca: queda en `url` y la copia con logo en `url_logo`.
 */
const { promises: fs } = require('fs');
const path = require('path');
const { pool } = require('./db');
const hf = require('./higgsfield');
const marca = require('./marca');
const logos = require('./logos');
const ajustes = require('./config');

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' };
const esVideoUrl = (u) => /\.(mp4|mov|webm|m4v)($|\?)/i.test(u || '');

/** Baja un archivo a la carpeta temporal. */
async function bajar(url, dir, nombre) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`no se pudo bajar el archivo (HTTP ${r.status})`);
  const destino = path.join(dir, nombre);
  await fs.writeFile(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}

/** Sube el archivo con logo al generador y devuelve su URL pública. */
async function subir(archivo, { video }) {
  const tipo = video ? 'video/mp4' : 'image/png';
  const slot = (await hf.llamar('media_upload', { method: 'upload_url', filename: path.basename(archivo), content_type: tipo })).uploads?.[0];
  if (!slot?.upload_url || !slot.media_id) throw new Error('media_upload no devolvió dónde subir');
  const put = await fetch(slot.upload_url, { method: 'PUT', headers: { 'content-type': slot.content_type || tipo }, body: await fs.readFile(archivo), signal: AbortSignal.timeout(300000) });
  if (!put.ok) throw new Error(`PUT de la subida falló (HTTP ${put.status})`);
  const conf = await hf.llamar('media_confirm', { type: video ? 'video' : 'image', media_id: slot.media_id });
  const r = conf.results?.[0];
  return { url: r?.url || slot.url || null, media_id: r?.media_id || slot.media_id };
}

/**
 * Marca una generación. Devuelve { estado, hechas } y deja la fila al día.
 * `opciones` permite rehacerla con otra esquina o con otro logo (desde el panel).
 */
async function marcarGeneracion(id, { logoId = null, posicion = null, cx = null, cy = null, tamPct = null, opacidad = null, rehacer = false } = {}) {
  const { rows: [g] } = await pool.query('SELECT id, estado, resultados, marca FROM generaciones WHERE id = $1', [id]);
  if (!g || g.estado !== 'completado') return { estado: 'sin_logo', motivo: 'no está terminada' };
  const resultados = (g.resultados || []).map((r) => ({ ...r }));
  const conUrl = resultados.filter((r) => r.url);
  if (!conUrl.length) return { estado: 'sin_logo', motivo: 'sin archivos' };

  const a = await ajustes.leer();
  const logo = logoId ? await logos.uno(logoId) : await logos.porDefecto();
  if (!logo) { await guardarEstado(id, 'sin_logo', null, resultados); return { estado: 'sin_logo', motivo: 'no hay logos cargados' }; }
  const v = await logos.versiones(logo.id);
  if (!v?.claro && !v?.oscuro) { await guardarEstado(id, 'sin_logo', null, resultados); return { estado: 'sin_logo', motivo: 'el logo no tiene archivo' }; }

  const dir = await marca.carpetaTemp();
  try {
    const archivos = {};
    if (v.claro) { archivos.claro = path.join(dir, `logo-claro.${v.ext}`); await fs.writeFile(archivos.claro, v.claro); }
    if (v.oscuro) { archivos.oscuro = path.join(dir, `logo-oscuro.${v.ext}`); await fs.writeFile(archivos.oscuro, v.oscuro); }
    let hechas = 0; let detalle = null;
    for (const r of resultados) {
      if (!r.url || (r.url_logo && !rehacer)) continue;
      const video = esVideoUrl(r.url);
      const entrada = await bajar(r.url, dir, `orig-${hechas}.${video ? 'mp4' : 'png'}`);
      const hecho = await marca.ponerMarca(entrada, archivos, {
        tamPct: tamPct ?? a.logo_tam, margenPct: a.logo_margen, opacidad: opacidad ?? a.logo_opacidad,
        posVertical: a.logo_pos_vertical, posResto: a.logo_pos_resto, posicion, cx, cy,
      });
      const sub = await subir(hecho.salida, { video: hecho.esVideo });
      if (!sub.url) throw new Error('la subida no devolvió URL');
      r.url_logo = sub.url;
      r.media_logo = sub.media_id;
      detalle = { logo_id: logo.id, logo: logo.nombre, posicion: hecho.posicion, cx: hecho.cx, cy: hecho.cy,
        version: hecho.version, tam: hecho.tamPct, opacidad: hecho.opacidad, ancho: hecho.ancho, alto: hecho.alto };
      hechas++;
    }
    await guardarEstado(id, hechas ? 'hecha' : 'sin_logo', detalle, resultados);
    return { estado: hechas ? 'hecha' : 'sin_logo', hechas, detalle };
  } finally { await marca.borrarCarpeta(dir); }
}

const guardarEstado = (id, estado, detalle, resultados) => pool.query(
  'UPDATE generaciones SET marca_estado = $2, marca = $3, resultados = $4 WHERE id = $1',
  [id, estado, detalle ? JSON.stringify(detalle) : null, JSON.stringify(resultados)]
);

/** Quita la copia con logo (vuelve a verse el original). */
async function quitarMarca(id) {
  const { rows: [g] } = await pool.query('SELECT resultados FROM generaciones WHERE id = $1', [id]);
  if (!g) return false;
  const resultados = (g.resultados || []).map(({ url_logo, media_logo, ...r }) => r); // eslint-disable-line no-unused-vars
  await guardarEstado(id, 'sin_logo', null, resultados);
  return true;
}

/** Las que están esperando su marca (el worker toma unas pocas por vuelta). */
async function pendientes(limite = 2) {
  const { rows } = await pool.query(
    `SELECT id FROM generaciones WHERE marca_estado = 'pendiente' AND estado = 'completado' ORDER BY id LIMIT $1`, [limite]
  );
  return rows.map((r) => Number(r.id));
}

module.exports = { marcarGeneracion, quitarMarca, pendientes };
