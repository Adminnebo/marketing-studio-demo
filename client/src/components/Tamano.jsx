import { useState } from 'react';

// Tamaño de las vistas previas de una galería (se recuerda por navegador).
export function useTamano(clave, inicial) {
  const [tam, setTamSt] = useState(() => { try { return Number(localStorage.getItem(clave)) || inicial; } catch { return inicial; } });
  const setTam = (v) => { setTamSt(v); try { localStorage.setItem(clave, String(v)); } catch { /* sin storage */ } };
  return [tam, setTam];
}

const Cuadros = ({ grande }) => (
  <svg width={grande ? 15 : 13} height={grande ? 15 : 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {grande ? <rect x="4" y="4" width="16" height="16" rx="2.5" /> : <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>}
  </svg>
);

export default function Tamano({ valor, onCambio, min = 140, max = 340 }) {
  return (
    <label className="tamano" title="Tamaño de las vistas previas">
      <Cuadros />
      <input type="range" min={min} max={max} step="10" value={valor} onChange={(e) => onCambio(Number(e.target.value))} aria-label="Tamaño de las vistas previas" />
      <Cuadros grande />
    </label>
  );
}
