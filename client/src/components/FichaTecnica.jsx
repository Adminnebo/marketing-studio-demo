import { useState } from 'react';
import { fichaCamila } from '../api';

// Suma un texto al final de otro sin pasarse del maximo (lo usan las cajas de descripcion).
export const sumarTexto = (antes, texto, max) => (antes?.trim() ? `${antes.trimEnd()}\n\n${texto}` : texto).slice(0, max);

/**
 * "Datos de la ficha técnica": con un producto elegido con Camila, lee su ficha (PDF) y
 * muestra lo pertinente para la foto o el video; "Añadir" lo suma a la descripción.
 */
export default function FichaTecnica({ codigo, tieneFicha, onAnadir, onCosto }) {
  const [st, setSt] = useState({ fase: 'nada' }); // nada | leyendo | listo | sin | error
  if (!codigo) return null;

  const leer = async () => {
    setSt({ fase: 'leyendo' });
    try {
      const r = await fichaCamila(codigo);
      if (r.costoIa > 0) onCosto?.(r.costoIa); // leerla la primera vez cuesta; se suma a la creacion
      setSt(r.sinFicha ? { fase: 'sin' } : { fase: 'listo', r, anadido: false });
    } catch (e) { setSt({ fase: 'error', error: e.message }); }
  };

  if (st.fase === 'listo') {
    const { r } = st;
    return (
      <div className="ft-caja">
        <div className="ft-cab"><span className="ft-ic">📄</span><b>De la ficha técnica{r.producto ? `: ${r.producto}` : ''}</b>
          <button className="ft-x" onClick={() => setSt({ fase: 'nada' })} aria-label="Cerrar">✕</button></div>
        {r.sinDatos ? <p className="ft-nada">La ficha no trae datos útiles para la descripción.</p> : (
          <>
            {r.datos.length > 0 && <div className="ft-datos">{r.datos.map((d) => <span key={d.dato}><em>{d.dato}:</em> {d.valor}</span>)}</div>}
            {r.visibles.length > 0 && <div className="ft-vis">Se ve: {r.visibles.join(' · ')}</div>}
            <p className="ft-texto">{r.texto}</p>
            <div className="ft-acc">
              {st.anadido
                ? <span className="ft-ok">✓ Añadido a la descripción</span>
                : <button className="btn" onClick={() => { onAnadir(r.texto); setSt({ ...st, anadido: true }); }}>Añadir a la descripción</button>}
              <span className="ft-nota">Revísalo: solo trae lo que dice la ficha.</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="ft-fila">
      <button className="ft-btn" onClick={leer} disabled={st.fase === 'leyendo' || tieneFicha === false}
        title={tieneFicha === false ? 'Este producto no tiene ficha técnica cargada' : 'Lee la ficha técnica y sugiere datos para la descripción'}>
        📄 {st.fase === 'leyendo' ? 'Leyendo la ficha… (unos 10 s)' : tieneFicha === false ? 'Sin ficha técnica' : 'Datos de la ficha técnica'}
      </button>
      {st.fase === 'sin' && <span className="ft-nota">Este producto no tiene ficha técnica cargada.</span>}
      {st.fase === 'error' && <span className="ft-err">{st.error}</span>}
    </div>
  );
}
