// Redes soportadas para publicar (via Zernio) y sus reglas basicas. Las usa el
// formulario de publicar y el servidor para validar y armar el POST /v1/posts.

export const REDES = {
  instagram: { nombre: 'Instagram', icono: '📸', limite: 2200, imagen: true, video: true },
  facebook: { nombre: 'Facebook', icono: '📘', limite: 63206, imagen: true, video: true },
  tiktok: { nombre: 'TikTok', icono: '🎵', limite: 2200, limiteFoto: 4000, imagen: true, video: true },
  youtube: { nombre: 'YouTube', icono: '▶️', limite: 5000, imagen: false, video: true },
  linkedin: { nombre: 'LinkedIn', icono: '💼', limite: 3000, imagen: true, video: true },
  threads: { nombre: 'Threads', icono: '🧵', limite: 500, imagen: true, video: true },
  twitter: { nombre: 'X', icono: '✖️', limite: 280, imagen: true, video: true, nota: 'X cobra cada publicación por API (requiere tarjeta en la cuenta de redes).' },
};

export const ESTADOS_PUB = {
  enviando: 'Enviando', programada: 'Programada', publicando: 'Publicando', publicada: 'Publicada',
  parcial: 'Parcial', fallida: 'Falló', cancelada: 'Cancelada',
};
export const PUB_EN_CURSO = new Set(['enviando', 'programada', 'publicando']);

// Estado del post en Zernio -> estado local.
export const DESDE_ZERNIO = {
  draft: 'programada', scheduled: 'programada', publishing: 'publicando', published: 'publicada',
  partial: 'parcial', failed: 'fallida', cancelled: 'cancelada',
};

export const tipoMedio = (url) => (/\.(mp4|mov|webm)($|\?)/i.test(url || '') ? 'video' : 'image');

export function limiteDe(plataforma, tipo) {
  const r = REDES[plataforma];
  if (!r) return 0;
  return plataforma === 'tiktok' && tipo === 'image' ? r.limiteFoto : r.limite;
}

// Errores de validacion (vacio = se puede publicar). cuentas = [{ id, plataforma }]
export function validarPublicacion({ texto, tipo, cuentas, opciones = {}, modo, fecha }) {
  const out = [];
  const t = (texto || '').trim();
  if (!cuentas?.length) out.push('Elige al menos una cuenta.');
  const vistas = new Set();
  for (const c of cuentas || []) {
    const r = REDES[c.plataforma];
    if (!r) { out.push(`Red no soportada: ${c.plataforma}.`); continue; }
    if (tipo === 'video' && !r.video) out.push(`${r.nombre} no acepta videos.`);
    if (tipo === 'image' && !r.imagen) out.push(`${r.nombre} solo acepta videos.`);
    const lim = limiteDe(c.plataforma, tipo);
    if (t.length > lim) out.push(`${r.nombre}: el texto pasa de ${lim.toLocaleString('es')} caracteres (${t.length}).`);
    if (vistas.has(c.plataforma)) continue;
    vistas.add(c.plataforma);
    if (c.plataforma === 'tiktok') {
      const tk = opciones.tiktok || {};
      if (!tk.privacidad) out.push('TikTok: elige quién puede verlo.');
      if (!tk.consentimiento) out.push('TikTok: confirma que revisaste el contenido y aceptas la política de música.');
    }
    if (c.plataforma === 'youtube') {
      const titulo = (opciones.youtube?.titulo || '').trim();
      if (!titulo) out.push('YouTube: pon un título.');
      if (titulo.length > 100) out.push('YouTube: el título pasa de 100 caracteres.');
    }
  }
  // fecha = instante ISO (el navegador lo calcula desde su hora local).
  if (modo === 'programar') {
    if (!fecha) out.push('Elige fecha y hora.');
    else if (new Date(fecha).getTime() < Date.now() + 60e3) out.push('La fecha tiene que ser en el futuro.');
  }
  return out;
}
