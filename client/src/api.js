// Cliente del API del panel. La sesion es la de Supabase (la misma cuenta de
// los otros paneles); el access_token se adjunta en cada llamada.
import { createClient } from '@supabase/supabase-js';

let supabase = null;
let token = null;
const avisar = () => window.dispatchEvent(new Event('ms-sesion'));

// Carga la config publica y restaura la sesion guardada. Devuelve la sesion (o null).
export async function iniciarAuth() {
  const cfg = await (await fetch('/api/config')).json();
  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: { session } } = await supabase.auth.getSession();
  token = session?.access_token || null;
  supabase.auth.onAuthStateChange((_e, s) => {
    const antes = token;
    token = s?.access_token || null;
    if (!!antes !== !!token) avisar();
  });
  return session ? { email: session.user.email } : null;
}

export function sesion() { return token ? { token } : null; }

export async function entrar(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const m = (error.message || '').toLowerCase();
    throw new Error(m.includes('invalid login') ? 'Correo o contraseña incorrectos.'
      : m.includes('not confirmed') ? 'El correo no está confirmado.' : error.message);
  }
  token = data.session?.access_token || null;
  avisar();
}

export async function salir() {
  try { await supabase?.auth.signOut(); } catch { /* sin red */ }
  token = null;
  avisar();
}

// "Ver como" (solo super_admin): el servidor aplica los permisos del rol elegido.
const CLAVE_VER = 'ms_ver_como';
export function verComo() { try { return sessionStorage.getItem(CLAVE_VER) || ''; } catch { return ''; } }
export function cambiarVerComo(rol) {
  try { rol ? sessionStorage.setItem(CLAVE_VER, rol) : sessionStorage.removeItem(CLAVE_VER); } catch { /* sin storage */ }
  window.location.reload();
}

async function api(ruta, opts = {}) {
  const vc = verComo();
  const r = await fetch('/api' + ruta, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}), authorization: 'Bearer ' + (token || ''), ...(vc ? { 'x-ver-como': vc } : {}) },
  });
  if (r.status === 401) { await salir(); throw new Error('Sesión vencida.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Error ${r.status}`);
    e.desconectado = !!j.desconectado;
    e.sinAcceso = !!j.sinAcceso;
    throw e;
  }
  return j;
}

export const fetchMe = () => api('/me');
export const fetchEstado = () => api('/estado');
export const fetchSaldo = () => api('/saldo');
export const fetchCategorias = () => api('/catalogo/categorias');
export const fetchCostos = () => api('/catalogo/costos');
export const fetchPlantillas = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== '' && v != null) q.set(k, v);
  return api('/catalogo/plantillas?' + q);
};
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
    x.setRequestHeader('authorization', 'Bearer ' + (token || ''));
    if (verComo()) x.setRequestHeader('x-ver-como', verComo());
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
  const r = await fetch(`/api/generaciones/${id}/descargar?i=${i}`, { headers: { authorization: 'Bearer ' + (token || '') } });
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

// ── Super Admin ──
export const fetchAjustes = () => api('/superadmin/ajustes');
export const guardarAjustes = (cambios) => api('/superadmin/ajustes', { method: 'PUT', body: JSON.stringify(cambios) });
export const fetchUsuarios = () => api('/superadmin/usuarios');
export const cambiarAcceso = (id, acceso) => api(`/superadmin/usuarios/${id}`, { method: 'PUT', body: JSON.stringify({ acceso }) });
export const fetchConsumo = (mes) => api('/superadmin/consumo' + (mes ? `?mes=${mes}` : ''));
export const fetchCreditos = ({ fresco = false } = {}) => api('/creditos' + (fresco ? '?fresco=1' : ''));
export const recargaManual = (datos) => api('/superadmin/recargas', { method: 'POST', body: JSON.stringify(datos) });
export const actualizarCosto = () => api('/superadmin/costo/actualizar', { method: 'POST' });
// ── Generacion libre ──
export const fetchModelos = () => api('/modelos');
export const costoLibre = (datos) => api('/libre/costo', { method: 'POST', body: JSON.stringify(datos) });
export const crearLibre = (datos) => api('/libre', { method: 'POST', body: JSON.stringify(datos) });
export const autoPrompt = (datos) => api('/libre/autoprompt', { method: 'POST', body: JSON.stringify(datos) });
export const reconectarGenerador = () => api('/superadmin/generador/conectar', { method: 'POST' });
// Plataforma de pagos: estado del saldo externo y de los gastos informados (super admin).
export const fetchPagosAdmin = () => api('/superadmin/pagos');
export const probarPagos = () => api('/superadmin/pagos/probar', { method: 'POST' });
export const reintentarConsumo = (id) => api(`/superadmin/pagos/eventos/${id}/reintentar`, { method: 'POST' });
export const fetchHistorialPagos = () => api('/superadmin/pagos/historial');
export const enviarHistorialPagos = (total) => api('/superadmin/pagos/historial', { method: 'POST', body: JSON.stringify({ total }) });
export const marcarDescontado = (id) => api(`/superadmin/pagos/eventos/${id}/hecho`, { method: 'POST' });
export const verificarCli = () => api('/superadmin/cli/verificar', { method: 'POST' });
export const cargarSesionCli = (paquete) => api('/superadmin/cli/sesion', { method: 'POST', body: JSON.stringify({ paquete }) });
export const clasificarPlantillas = () => api('/superadmin/plantillas/clasificar', { method: 'POST' });
export const registrarWebhookRedes = () => api('/superadmin/zernio/webhook', { method: 'POST' });

// Camila: buscar productos de JH y dejarlos listos para crear.
export const fetchCamilaEstado = () => api('/camila/estado');
export const fetchCamilaConversacion = () => api('/camila/conversacion');
export const mensajeCamila = (datos) => api('/camila/mensaje', { method: 'POST', body: JSON.stringify(datos) });
export const usarProductoCamila = (datos) => api('/camila/usar', { method: 'POST', body: JSON.stringify(datos) });
export const fichaCamila = (codigo) => api('/camila/ficha', { method: 'POST', body: JSON.stringify({ codigo }) });
export const fetchZernioSetup = () => api('/superadmin/zernio');
export const elegirPerfilZernio = (id) => api('/superadmin/zernio/perfil', { method: 'PUT', body: JSON.stringify({ id }) });
export const captionPublicacion = (datos) => api('/publicaciones/caption', { method: 'POST', body: JSON.stringify(datos) });
export const cambiarPermisoPublicar = (id, valor) => api(`/superadmin/usuarios/${id}/publicar`, { method: 'PUT', body: JSON.stringify({ valor }) });
export const cambiarPermisoAprobar = (id, valor) => api(`/superadmin/usuarios/${id}/aprobar`, { method: 'PUT', body: JSON.stringify({ valor }) });
// Saldo de Marketing: pedir recarga y (quien puede aprobar) resolver las solicitudes.
export const pedirRecarga = (monto, motivo) => api('/creditos/solicitudes', { method: 'POST', body: JSON.stringify({ monto, motivo }) });
export const aprobarRecarga = (id, nota) => api(`/creditos/solicitudes/${id}/aprobar`, { method: 'POST', body: JSON.stringify({ nota }) });
export const rechazarRecarga = (id, nota) => api(`/creditos/solicitudes/${id}/rechazar`, { method: 'POST', body: JSON.stringify({ nota }) });
export const resolverRecarga = (id, aplicada) => api(`/creditos/solicitudes/${id}/revision`, { method: 'POST', body: JSON.stringify({ aplicada }) });
