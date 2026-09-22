import { useState } from 'react';
import { PALETAS, LUCES, FONDOS, ESTILOS, TIPOS_CON_TEXTO, MAX_TEXTO, textoDe, cuantas, validar } from '@shared/personalizar.mjs';

function Chips({ opciones, valor, onCambio, desactivado }) {
  return (
    <div className="pz-chips">
      <button type="button" className={`pz-chip ${!valor ? 'on' : ''}`} disabled={desactivado} onClick={() => onCambio(null)}>Como la plantilla</button>
      {Object.entries(opciones).map(([k, o]) => (
        <button key={k} type="button" className={`pz-chip ${valor === k ? 'on' : ''}`} disabled={desactivado} onClick={() => onCambio(k)}>{o.nombre}</button>
      ))}
    </div>
  );
}

// Personalizacion avanzada de una plantilla: colores, fondo, luz, estilo y (en anuncios,
// posters y marketplace) los textos del diseño. Todo se suma a las instrucciones.
export default function Personalizar({ tipo, valor, onCambio, desactivado }) {
  const p = valor || {};
  const [abierto, setAbierto] = useState(cuantas(validar(p, tipo)) > 0);
  const [verTexto, setVerTexto] = useState(false);
  const set = (cambios) => onCambio({ ...p, ...cambios });
  const n = cuantas(validar(p, tipo));
  const propios = p.colores?.length ? p.colores : ['#0B2A5B', '#F2B705'];
  const conTexto = TIPOS_CON_TEXTO.has(tipo);
  const texto = textoDe(p, tipo);

  return (
    <div className={`pz ${abierto ? 'abierto' : ''}`}>
      <button type="button" className="pz-cab" onClick={() => setAbierto(!abierto)} aria-expanded={abierto}>
        <span>🎨 Personalizar <span className="pz-sub">colores, fondo, luz, estilo{conTexto ? ' y textos' : ''}</span></span>
        <span className="pz-cab-d">{n > 0 && <span className="pz-n">{n}</span>}{abierto ? '▲' : '▼'}</span>
      </button>
      {abierto && (
        <div className="pz-cuerpo">
          <div className="pz-grupo">
            <div className="pz-lbl">Colores</div>
            <div className="pz-paletas">
              <button type="button" className={`pz-paleta ${!p.paleta ? 'on' : ''}`} disabled={desactivado} onClick={() => set({ paleta: null, colores: undefined })}>
                <span className="pz-muestra pz-muestra-libre">≈</span><span className="pz-pn">Como la plantilla</span>
              </button>
              {Object.entries(PALETAS).map(([k, o]) => (
                <button key={k} type="button" className={`pz-paleta ${p.paleta === k ? 'on' : ''}`} disabled={desactivado} onClick={() => set({ paleta: k, colores: undefined })} title={o.uso}>
                  <span className="pz-muestra">{o.colores.map((c) => <i key={c} style={{ background: c }} />)}</span>
                  <span className="pz-pn">{o.nombre}</span><span className="pz-pu">{o.uso}</span>
                </button>
              ))}
              <button type="button" className={`pz-paleta ${p.paleta === 'propia' ? 'on' : ''}`} disabled={desactivado} onClick={() => set({ paleta: 'propia', colores: propios })}>
                <span className="pz-muestra">{propios.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
                <span className="pz-pn">Personalizado</span><span className="pz-pu">Elige tus colores</span>
              </button>
            </div>
            {p.paleta === 'propia' && (
              <div className="pz-propios">
                {[['Principal (fondo)', 0], ['Acento (detalles)', 1]].map(([l, i]) => (
                  <label key={i} className="pz-color">
                    <input type="color" value={propios[i] || '#FFFFFF'} disabled={desactivado}
                      onChange={(e) => { const c = [...propios]; c[i] = e.target.value.toUpperCase(); set({ colores: c }); }} />
                    <span>{l}<br /><code>{(propios[i] || '').toUpperCase()}</code></span>
                  </label>
                ))}
              </div>
            )}
            <div className="pz-nota">Cambia el fondo y los detalles de la escena. El producto conserva sus colores reales.</div>
          </div>

          <div className="pz-grupo"><div className="pz-lbl">Fondo</div><Chips opciones={FONDOS} valor={p.fondo} desactivado={desactivado} onCambio={(v) => set({ fondo: v })} /></div>
          <div className="pz-grupo"><div className="pz-lbl">Luz</div><Chips opciones={LUCES} valor={p.luz} desactivado={desactivado} onCambio={(v) => set({ luz: v })} /></div>
          <div className="pz-grupo"><div className="pz-lbl">Estilo</div><Chips opciones={ESTILOS} valor={p.estilo} desactivado={desactivado} onCambio={(v) => set({ estilo: v })} /></div>

          {conTexto && (
            <div className="pz-grupo">
              <div className="pz-lbl">Textos del diseño <span className="pz-sub">(se escriben tal cual; vacío = los decide la plantilla)</span></div>
              <div className="pz-textos">
                {[['titulo', 'Titular', 'Ej.: Ilumina tu obra'], ['subtitulo', 'Texto secundario', 'Ej.: Bajo consumo, alta duración'], ['llamada', 'Llamada a la acción', 'Ej.: Pídelo por WhatsApp']].map(([k, l, ph]) => (
                  <label key={k} className="filter-field"><span>{l}</span>
                    <input className="ms-input" maxLength={MAX_TEXTO} placeholder={ph} value={p[k] || ''} disabled={desactivado} onChange={(e) => set({ [k]: e.target.value })} />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="pz-pie">
            {n > 0 ? (
              <>
                <button type="button" className="linklike" onClick={() => setVerTexto(!verTexto)}>{verTexto ? 'Ocultar' : 'Ver'} lo que se agrega a las instrucciones</button>
                {!desactivado && <button type="button" className="linklike pz-quitar" onClick={() => onCambio({})}>Quitar personalización</button>}
              </>
            ) : <span className="pz-nota">Sin cambios: se hace igual a la plantilla.</span>}
          </div>
          {verTexto && texto && <pre className="pz-texto">{texto}</pre>}
        </div>
      )}
    </div>
  );
}
