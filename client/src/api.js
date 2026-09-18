// Cliente del API del panel. La sesion (token firmado) vive en localStorage.
const CLAVE = 'ms_sesion';

export function sesion() {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || null; } catch { return null; }
}
function guardar(s) {
  try { s ? localStorage.setItem(CLAVE, JSON.stringify(s)) : localStorage.removeItem(CLAVE); } catch { /* sin storage */ }
  window.dispatchEvent(new Event('ms-sesion'));
}
export const salir = () => guardar(null);

export async function entrar(email, password) {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'No se pudo entrar.');
  guardar({ token: j.token, email: j.email });
}

async function api(ruta, opts = {}) {
  const s = sesion();
  const r = await fetch('/api' + ruta, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}), authorization: 'Bearer ' + (s?.token || '') },
  });
  if (r.status === 401) { salir(); throw new Error('Sesión vencida.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.desconectado = !!j.desconectado; throw e; }
  return j;
}

export const fetchMe = () => api('/me');
export const fetchEstado = () => api('/estado');
export const fetchSaldo = () => api('/saldo');
export const fetchCategorias = () => api('/catalogo/categorias');
export const fetchCostos = () => api('/catalogo/costos');
export const fetchPlantillas = (categoria, cursor) =>
  api(`/catalogo/plantillas?categoria=${encodeURIComponent(categoria)}${cursor ? `&cursor=${cursor}` : ''}`);
export const fetchAvatares = (c = {}) => {
  const q = new URLSearchParams();
  if (c.preset_cursor) q.set('preset_cursor', c.preset_cursor);
  if (c.user_cursor) q.set('user_cursor', c.user_cursor);
  return api('/catalogo/avatares?' + q);
};
export const crearGeneracion = (datos) => api('/generaciones', { method: 'POST', body: JSON.stringify(datos) });
export const fetchGeneraciones = (antes) => api('/generaciones?limite=30' + (antes ? `&antes=${antes}` : ''));

// Subida con progreso (XHR): el servidor la reenvia a Higgsfield.
export function subirImagen(archivo, onProgreso) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/medios');
    x.setRequestHeader('authorization', 'Bearer ' + (sesion()?.token || ''));
    x.setRequestHeader('content-type', archivo.type);
    x.setRequestHeader('x-nombre', encodeURIComponent(archivo.name).slice(0, 200));
    x.upload.onprogress = (e) => e.lengthComputable && onProgreso?.(e.loaded / e.total);
    x.onload = () => {
      let j = {};
      try { j = JSON.parse(x.responseText); } catch { /* vacio */ }
      if (x.status === 401) salir();
      x.status >= 200 && x.status < 300 ? resolve(j) : reject(new Error(j.error || `Error ${x.status}`));
    };
    x.onerror = () => reject(new Error('Se cortó la conexión al subir.'));
    x.send(archivo);
  });
}

// Descarga a traves del panel (lleva la sesion y el nombre de archivo propio).
export async function descargar(id, i = 0) {
  const r = await fetch(`/api/generaciones/${id}/descargar?i=${i}`, { headers: { authorization: 'Bearer ' + (sesion()?.token || '') } });
  if (r.status === 401) { salir(); throw new Error('Sesión vencida.'); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'No se pudo descargar.'); }
  const nombre = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `marketing_${id}`;
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ── Redes sociales ──
export const fetchRedesEstado = () => api('/redes/estado');
export const fetchCuentas = () => api('/redes/cuentas');
export const conectarRed = (plataforma) => api('/redes/conectar', { method: 'POST', body: JSON.stringify({ plataforma }) });
export const desconectarCuenta = (id) => api(`/redes/cuentas/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const fetchInfoTiktok = (id, tipo) => api(`/redes/cuentas/${encodeURIComponent(id)}/tiktok?tipo=${tipo}`);
export const publicar = (datos) => api('/publicaciones', { method: 'POST', body: JSON.stringify(datos) });
export const fetchPublicaciones = () => api('/publicaciones');
export const cancelarPublicacion = (id) => api(`/publicaciones/${id}/cancelar`, { method: 'POST' });
