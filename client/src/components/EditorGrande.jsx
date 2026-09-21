import { useEffect, useRef } from 'react';

const Ampliar = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </svg>
);

// Boton en la esquina de una caja de texto para abrirla en grande.
export function BotonAmpliar({ onClick, titulo = 'Ver en grande' }) {
  return <button type="button" className="eg-amp" onClick={onClick} title={titulo} aria-label={titulo}><Ampliar /></button>;
}

/** Caja de texto en grande, encima de todo (como el editor de expresiones de n8n). */
export default function EditorGrande({ titulo, valor, onCambio, max = 5000, nota, placeholder, onCerrar }) {
  const caja = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => { const el = caja.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 30);
    const esc = (e) => { if (e.key === 'Escape') onCerrar(); };
    document.addEventListener('keydown', esc);
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { clearTimeout(t); document.removeEventListener('keydown', esc); document.body.style.overflow = antes; };
  }, [onCerrar]);
  return (
    <div className="eg-velo" onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="eg-caja" role="dialog" aria-label={titulo}>
        <div className="eg-cab">
          <b>{titulo}</b>
          <span className="eg-cuenta">{valor.length.toLocaleString('es-MX')} / {max.toLocaleString('es-MX')}</span>
          <button className="btn" onClick={onCerrar}>Listo</button>
        </div>
        <textarea ref={caja} className="eg-texto" value={valor} maxLength={max} placeholder={placeholder} onChange={(e) => onCambio(e.target.value)} />
        {nota && <div className="eg-nota">{nota}</div>}
      </div>
    </div>
  );
}
