/**
 * Filtros de "Mis creaciones" (GET /api/generaciones) -> WHERE parametrizado.
 * q: producto, codigo o descripcion (de Camila), plantilla, descripcion usada, persona o #numero.
 * estado: curso|completado|fallido · medio: foto|video · autor: correo o 'yo' · dias: 1|7|30 · publicadas: '1' · antes: id.
 * `vals` ya trae los valores previos (p. ej. el limite en $1).
 */
const TIPOS_VIDEO_SQL = `('ugc', '2d_motion', 'hypermotion', 'mixed_media', 'saas_motion', 'libre_video')`;

function filtrosGeneraciones(q, { email, vals = [] }) {
  const cond = [];
  const v = (x) => { vals.push(x); return `$${vals.length}`; };
  if (Number(q.antes)) cond.push(`id < ${v(Number(q.antes))}`);
  // Cada palabra tiene que aparecer en algun campo ("gabinete 11" encuentra "GABINETE METALICO 11 MODULOS").
  const palabras = String(q.q || '').trim().slice(0, 80).split(/\s+/).filter(Boolean).slice(0, 6);
  for (const palabra of palabras) {
    const num = /^#?(\d{1,9})$/.exec(palabra)?.[1];
    const like = v(`%${palabra.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    cond.push(`(${num ? `id = ${v(Number(num))} OR ` : ''}preset_nombre ILIKE ${like} OR creado_por ILIKE ${like}
      OR entrada->'producto'->>'nombre' ILIKE ${like}
      OR COALESCE(entrada->'args'->>'prompt', entrada->'params'->>'prompt', '') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM camila_usos u WHERE u.media_id = COALESCE(entrada->'producto'->>'media_id', entrada->'args'->>'product_media_id')
                 AND (u.codigo ILIKE ${like} OR u.descripcion ILIKE ${like})))`);
  }
  if (q.estado === 'curso') cond.push(`estado IN ('pendiente', 'enviando', 'en_proceso')`);
  else if (['completado', 'fallido'].includes(q.estado)) cond.push(`estado = ${v(q.estado)}`);
  if (q.medio === 'video') cond.push(`preset_tipo IN ${TIPOS_VIDEO_SQL}`);
  else if (q.medio === 'foto') cond.push(`preset_tipo NOT IN ${TIPOS_VIDEO_SQL}`);
  if (q.autor) cond.push(`lower(creado_por) = ${v(q.autor === 'yo' ? String(email || '').toLowerCase() : String(q.autor).toLowerCase())}`);
  if ([1, 7, 30].includes(Number(q.dias))) cond.push(`creado > now() - ${v(`${Number(q.dias)} days`)}::interval`);
  if (q.publicadas === '1') cond.push(`EXISTS (SELECT 1 FROM publicaciones p WHERE p.generacion_id = generaciones.id)`);
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', vals };
}

module.exports = { filtrosGeneraciones };
