import { useEffect, useRef, useState } from 'react';
import { empezarDictado, reconocedorDeVoz, sumarDictado, motivoDeError } from '../lib/dictado';

// Boton 🎙 Dictar para cualquier caja de texto: lo dicho se va escribiendo en la caja mientras
// se habla (sumado a lo que ya habia), asi lo mal entendido se corrige antes de usarlo.
export default function Dictar({ valor, onCambiar, max = 2000, idioma = 'es-DO', grande = false }) {
  const [dictando, setDictando] = useState(false);
  const [error, setError] = useState(null);
  const parar = useRef(null);
  const base = useRef('');
  const puede = Boolean(reconocedorDeVoz());

  // Salir del paso con el micrófono abierto no lo deja escuchando.
  useEffect(() => () => parar.current?.(), []);

  const dictar = () => {
    setError(null);
    base.current = valor || '';
    try {
      parar.current = empezarDictado({
        idioma,
        onTexto: (dicho) => onCambiar(sumarDictado(base.current, dicho, max)),
        onError: (codigo) => setError(motivoDeError(codigo)),
        onFin: () => { parar.current = null; setDictando(false); },
      });
      setDictando(true);
    } catch {
      setError(motivoDeError());
    }
  };

  if (!puede) {
    return <span className="dictar-no">🎙 Para dictar usa Chrome, Edge o Safari (este navegador no lo permite).</span>;
  }
  return (
    <div className="dictar">
      <button type="button" className={`${grande ? 'btn' : 'mini-btn'} ${dictando ? 'dictar-on' : ''}`} onClick={dictando ? () => parar.current?.() : dictar}>
        {dictando ? '■ Parar' : '🎙 Dictar'}
      </button>
      <span className="dictar-estado" aria-live="polite">
        {dictando ? <><span className="dictar-punto" />Te escucho: lo que digas se va escribiendo en la caja.</> : error ? '' : 'Habla normal; después puedes corregir el texto.'}
      </span>
      {error && <span className="dictar-err" role="alert">{error}</span>}
    </div>
  );
}
