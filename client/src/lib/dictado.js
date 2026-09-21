/**
 * Dictado con el reconocimiento de voz del navegador (el mismo del menu digital,
 * Adminnebo/Restaurant src/lib/dictado.js).
 *
 * Gratis, sin servidor y con el texto a la vista mientras se habla: se corrige lo
 * que se entendio mal antes de usarlo. Anda en Chrome, Edge, Android y Safari.
 * Firefox no lo tiene, y los Chromium sin servicios de Google (Brave, Helium...)
 * lo tienen pero fallan con 'network': los dos casos se explican al usuario.
 */

/** El reconocedor de voz del navegador, o null si no tiene. Safari y Chrome lo traen con prefijo. */
export function reconocedorDeVoz() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/** Suma lo dictado a lo que ya estaba escrito, con un espacio entre medio y sin pasarse del tope. */
export function sumarDictado(base, dicho, max) {
  const limpio = dicho.trim();
  if (!limpio) return base.slice(0, max);
  const separador = base && !/\s$/.test(base) ? ' ' : '';
  return `${base}${separador}${limpio}`.slice(0, max);
}

/** Mensaje claro para cada error del reconocedor. */
export function motivoDeError(codigo) {
  if (codigo === 'not-allowed' || codigo === 'service-not-allowed') return 'El navegador no dio permiso para usar el micrófono. Permítelo (ícono del candado en la barra de direcciones) y prueba de nuevo.';
  if (codigo === 'audio-capture') return 'No encontré un micrófono. Conecta uno y prueba de nuevo.';
  if (codigo === 'network') return 'Este navegador no tiene el servicio de dictado (pasa en navegadores sin servicios de Google). Usa Chrome, Edge o Safari, o escribe el texto.';
  if (codigo === 'language-not-supported') return 'El dictado en español no está disponible en este navegador.';
  return 'No se pudo dictar. Prueba de nuevo o escribe el texto.';
}

/**
 * Empieza a dictar y devuelve la funcion para parar.
 *
 * `onTexto` recibe todo lo entendido en esta tanda, no solo lo ultimo: el navegador va corrigiendo
 * lo que ya entendio. `onFin` llega siempre que el dictado se corta (se paro, silencio largo o error).
 */
export function empezarDictado({ idioma, onTexto, onError, onFin }) {
  const Reconocedor = reconocedorDeVoz();
  if (!Reconocedor) throw new Error('Este navegador no permite dictar.');
  const reconocedor = new Reconocedor();
  reconocedor.lang = idioma;
  reconocedor.continuous = true;
  reconocedor.interimResults = true;
  reconocedor.onresult = (evento) => onTexto(Array.from(evento.results).map((r) => r[0].transcript).join(''));
  reconocedor.onerror = (evento) => {
    // Quedarse callado o cancelar no es un problema del microfono.
    if (evento?.error !== 'no-speech' && evento?.error !== 'aborted') onError?.(evento?.error);
  };
  reconocedor.onend = () => onFin?.();
  reconocedor.start();
  return () => { try { reconocedor.stop(); } catch { /* ya estaba parado */ } };
}
