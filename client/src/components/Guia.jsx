import { useEffect } from 'react';

// Tira de 3 pasos arriba de Crear: como funciona el panel de un vistazo.
export function Pasos({ onAyuda }) {
  return (
    <div className="pasos">
      {[
        ['1', 'Elige cómo crear', 'Con una plantilla ya probada o desde cero, paso a paso.'],
        ['2', 'Completa los pasos', 'Puedes volver atrás y cambiar lo que sea antes de crear.'],
        ['3', 'Revisa y crea', 'Ves el costo antes de gastar; el resultado queda en Mis creaciones.'],
      ].map(([n, t, s]) => (
        <div key={n} className="paso">
          <span className="paso-num">{n}</span>
          <div><div className="paso-t">{t}</div><div className="paso-s">{s}</div></div>
        </div>
      ))}
      <button className="mini-btn pasos-ayuda" onClick={onAyuda}>❔ Guía rápida</button>
    </div>
  );
}

// Tutorial del camino largo (desde cero), en el mismo orden que el asistente.
const TUTORIAL = [
  ['Elige video o foto', 'Y el modelo de IA: si no sabes cuál, deja el recomendado.'],
  ['Formato, duración y calidad', 'Va antes de la descripción a propósito: la descripción que escribe la IA se arma para esa duración (reparte la escena en tres tramos), ese formato y el sonido. Si después cambias algo, el panel te avisa y te ofrece reescribirla.'],
  ['Sube la foto de tu producto', 'La IA copia el producto tal como se ve. Sin foto no puede escribir la descripción por ti y el producto saldría inventado.'],
  ['La descripción', 'Tres formas: la IA la escribe desde tu foto (unos 20 segundos), la dictas con 🎙 o la escribes. Si la dictas, eliges cómo usarla: como base para que la IA escriba la versión profesional (recomendado) o tal cual como descripción completa. Puedes editarla siempre, y revisa los avisos si aparecen.'],
  ['Revisar y crear', 'Repasa todo en una sola pantalla, con un botón Editar en cada línea, y crea cuando esté bien. Ahí ves cuántos créditos usa.'],
];

const PREGUNTAS = [
  ['¿Plantilla o desde cero?', 'Empieza con una plantilla: es un diseño que ya funciona y solo cambias el producto. "Desde cero" sirve cuando quieres algo muy específico: describes la escena (o dejas que la IA la escriba a partir de la foto) y eliges duración y formato.'],
  ['¿Qué foto subo?', 'Una foto del producto real, completo y nítido, idealmente sobre fondo blanco o liso, sin otros objetos. La IA respeta lo que ve: si la foto está cortada o borrosa, el resultado también. Formatos PNG, JPG o WEBP de hasta 60 MB.'],
  ['¿Cuánto tarda?', 'Las fotos, menos de un minuto. Los videos, de 2 a 10 minutos según la duración y la calidad. No hace falta esperar en la página: todo queda en Mis creaciones y se actualiza solo.'],
  ['¿Qué es un crédito?', 'La unidad con la que se paga cada creación. Antes de generar ves cuántos créditos usa y cuánto cuesta en dólares. Una foto de producto usa 1 o 2 créditos y un anuncio o póster unos 7; un video de 5 segundos, de 8 a 35 según el modelo, y un video con persona hablando (UGC) bastante más. Más duración o más calidad, más créditos.'],
  ['¿Y si sale mal?', 'Si la creación falla, los créditos se devuelven solos a tu saldo. Si salió pero no te gusta, usa "Usar de nuevo" para repetirla cambiando la foto o la descripción.'],
  ['¿Cómo dicto?', 'Toca 🎙 Dictar, permite el micrófono y habla normal: el texto se va escribiendo mientras hablas y después lo corriges. Funciona en Chrome, Edge y Safari (también en el celular); Firefox y algunos navegadores sin servicios de Google no lo permiten.'],
  ['¿Dónde descargo?', 'En Mis creaciones, con el botón Descargar de cada resultado.'],
];

export function Ayuda({ onCerrar }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCerrar]);
  return (
    <div className="ms-modal" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="ms-modal__box ayuda" role="dialog" aria-label="Guía rápida">
        <div className="ms-modal__body">
          <div className="ms-modal__head">
            <h2>Guía rápida</h2>
            <button className="ms-x" onClick={onCerrar} aria-label="Cerrar">✕</button>
          </div>
          <div className="ayuda-tut">
            <div className="ayuda-p">Crear desde cero, paso a paso</div>
            <ol className="ayuda-ol">
              {TUTORIAL.map(([t, d]) => <li key={t}><strong>{t}.</strong> {d}</li>)}
            </ol>
            <div className="ayuda-r">Con una plantilla es más corto: eliges el diseño, subes la foto y creas.</div>
          </div>
          {PREGUNTAS.map(([p, r]) => (
            <div key={p} className="ayuda-item">
              <div className="ayuda-p">{p}</div>
              <div className="ayuda-r">{r}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
