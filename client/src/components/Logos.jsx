import { useEffect, useRef, useState } from 'react';
import { fetchLogos, subirLogo, renombrarLogo, logoPorDefecto, borrarLogo, guardarAjustesLogo } from '../api';

const ESQUINAS = [['arriba-izq', 'Arriba izq.'], ['arriba-der', 'Arriba der.'], ['abajo-izq', 'Abajo izq.'], ['abajo-der', 'Abajo der.'], ['centro', 'Centro']];
const FORMATOS = [
  { k: '9:16', l: 'Vertical (Reels, TikTok)', w: 90, h: 160, vertical: true },
  { k: '1:1', l: 'Cuadrado (feed)', w: 130, h: 130 },
  { k: '16:9', l: 'Horizontal (web, YouTube)', w: 180, h: 101 },
];
const urlLogo = (l, v) => `/api/logos/${l.id}/${v}?t=${new Date(l.creado).getTime()}`;

// Vista previa: el logo sobre un ejemplo de cada formato, con la esquina, el tamaño y la opacidad reales.
function Previa({ logo, ajustes }) {
  if (!logo) return null;
  return (
    <div className="lg-previas">
      {FORMATOS.map((f) => {
        const pos = f.vertical ? ajustes.logo_pos_vertical : ajustes.logo_pos_resto;
        const margen = `${ajustes.logo_margen}%`;
        const [v, h] = pos === 'centro' ? ['centro', 'centro'] : pos.split('-');
        const estilo = {
          width: `${ajustes.logo_tam}%`, opacity: ajustes.logo_opacidad / 100, position: 'absolute',
          ...(v === 'centro' ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
            : { [v === 'arriba' ? 'top' : 'bottom']: margen, [h === 'izq' ? 'left' : 'right']: margen }),
        };
        const claro = !!logo.tiene_claro;
        return (
          <figure key={f.k} className="lg-previa">
            <div className="lg-lienzo" style={{ width: f.w * 1.5, height: f.h * 1.5 }}>
              <img className="lg-marca" src={urlLogo(logo, claro ? 'claro' : 'oscuro')} alt="" style={estilo} />
            </div>
            <figcaption>{f.l}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function Logo({ l, puedeSubir, onCambio, onSubirVersion }) {
  const [nombre, setNombre] = useState(l.nombre);
  return (
    <div className={`lg-item ${l.por_defecto ? 'on' : ''}`}>
      <div className="lg-muestras">
        {l.tiene_claro && <span className="lg-muestra osc"><img src={urlLogo(l, 'claro')} alt={`${l.nombre} claro`} /><em>Claro</em></span>}
        {l.tiene_oscuro && <span className="lg-muestra"><img src={urlLogo(l, 'oscuro')} alt={`${l.nombre} oscuro`} /><em>Oscuro</em></span>}
      </div>
      <div className="lg-item-t">
        {puedeSubir ? (
          <input className="ms-input lg-nombre" value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)}
            onBlur={() => nombre.trim() && nombre !== l.nombre && renombrarLogo(l.id, nombre.trim()).then(onCambio)} />
        ) : <strong>{l.nombre}</strong>}
        <span className="ms-cost">{Math.round(l.bytes / 1024)} KB · lo subió {l.por}</span>
        {!l.tiene_oscuro && <span className="ms-cost">Falta la versión <strong>oscura</strong> (para fotos claras): súbela y el panel elige sola cuál usar.</span>}
        {!l.tiene_claro && <span className="ms-cost">Falta la versión <strong>clara</strong> (para fotos oscuras): súbela y el panel elige sola cuál usar.</span>}
      </div>
      {puedeSubir && (
        <div className="lg-item-acc">
          {l.por_defecto ? <span className="pill st-completado">El de siempre</span>
            : <button className="mini-btn" onClick={() => logoPorDefecto(l.id).then(onCambio)}>Usar este</button>}
          <button className="mini-btn" onClick={() => onSubirVersion(l, 'claro')}>{l.tiene_claro ? 'Cambiar la clara' : '＋ Versión clara'}</button>
          <button className="mini-btn" onClick={() => onSubirVersion(l, 'oscuro')}>{l.tiene_oscuro ? 'Cambiar la oscura' : '＋ Versión oscura'}</button>
          <button className="mini-btn ms-gen-borrar" onClick={() => window.confirm(`¿Borrar "${l.nombre}"?`) && borrarLogo(l.id).then(onCambio)}>🗑</button>
        </div>
      )}
    </div>
  );
}

export default function Logos() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [subiendo, setSubiendo] = useState(false);
  const [quitarFondo, setQuitarFondo] = useState(true);
  const archivo = useRef(null);
  const destino = useRef({ logoId: null, version: 'claro' });
  const cargar = () => fetchLogos().then(setD).catch((e) => setError(e.message));
  useEffect(() => { cargar(); }, []);

  const elegir = (logo = null, version = 'claro') => { destino.current = { logoId: logo?.id || null, version }; archivo.current?.click(); };
  const subir = async (f) => {
    if (!f) return;
    setSubiendo(true); setMsg(null);
    try {
      await subirLogo(f, { ...destino.current, nombre: f.name.replace(/\.\w+$/, ''), quitarFondo });
      setMsg({ ok: 'Logo guardado.' });
      await cargar();
    } catch (e) { setMsg({ error: e.message }); }
    setSubiendo(false);
  };
  const cambiarAjuste = async (k, v) => {
    setD((x) => ({ ...x, ajustes: { ...x.ajustes, [k]: v } }));
    try { const r = await guardarAjustesLogo({ [k]: v }); setD((x) => ({ ...x, ajustes: r.ajustes })); } catch (e) { setMsg({ error: e.message }); cargar(); }
  };

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>{error}</div>;
  if (!d) return <div className="loading"><div className="spinner" /></div>;
  const a = d.ajustes;
  const porDefecto = d.logos.find((l) => l.por_defecto) || d.logos[0];

  return (
    <>
      {!d.ffmpeg && <div className="banner-off" style={{ marginTop: 16 }}>El panel no puede poner marcas de agua ahora mismo (falta ffmpeg en el servidor). Avísale a Nebo.</div>}
      <div className="section-title">Logos de JH</div>
      <div className="card lg-card">
        <div className="card-sub">
          De cada logo conviene tener dos versiones: una <strong>clara</strong> (para fotos oscuras) y una <strong>oscura</strong> (para fotos claras).
          El panel mide la esquina de cada creación y usa la que se vea. Lo mejor es PNG con fondo transparente.
        </div>
        {d.logos.length === 0 && <div className="empty-state">Todavía no hay logos. Sube el primero y se le pone solo a todo lo nuevo.</div>}
        <div className="lg-lista">
          {d.logos.map((l) => <Logo key={l.id} l={l} puedeSubir={d.puedeSubir} onCambio={cargar} onSubirVersion={elegir} />)}
        </div>
        {d.puedeSubir && (
          <div className="lg-subir">
            <input ref={archivo} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={(e) => { subir(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn" disabled={subiendo} onClick={() => elegir(null, 'claro')}>{subiendo ? 'Subiendo…' : '＋ Subir un logo'}</button>
            <label className="gn-check"><input type="checkbox" checked={quitarFondo} onChange={(e) => setQuitarFondo(e.target.checked)} /> Quitarle el fondo blanco</label>
            <span className="ms-cost">PNG, WEBP o JPG, hasta 2 MB.</span>
            {msg && <span className={msg.ok ? 'cr-ok' : 'cr-err'}>{msg.ok || msg.error}</span>}
          </div>
        )}
      </div>

      <div className="section-title">Cómo se pone</div>
      <div className="card lg-card">
        <label className="gn-check lg-auto">
          <input type="checkbox" checked={Number(a.logo_auto) === 1} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_auto', e.target.checked ? 1 : 0)} />
          <span><strong>Ponerlo solo a todo lo nuevo.</strong> Cada foto o video que salga lleva el logo. El original sin logo se guarda igual y se puede ver o descargar.</span>
        </label>
        <div className="lg-ajustes">
          <label className="filter-field"><span>Esquina en vertical (9:16)</span>
            <select className="search select" value={a.logo_pos_vertical} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_pos_vertical', e.target.value)}>
              {ESQUINAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <span className="ms-cost">En Reels y TikTok, abajo lo tapan los botones y el texto.</span>
          </label>
          <label className="filter-field"><span>Esquina en cuadrado y horizontal</span>
            <select className="search select" value={a.logo_pos_resto} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_pos_resto', e.target.value)}>
              {ESQUINAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="filter-field"><span>Tamaño: {a.logo_tam} % del ancho</span>
            <input type="range" min="5" max="40" value={a.logo_tam} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_tam', Number(e.target.value))} />
          </label>
          <label className="filter-field"><span>Margen: {a.logo_margen} %</span>
            <input type="range" min="0" max="15" value={a.logo_margen} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_margen', Number(e.target.value))} />
          </label>
          <label className="filter-field"><span>Opacidad: {a.logo_opacidad} %</span>
            <input type="range" min="20" max="100" value={a.logo_opacidad} disabled={!d.puedeSubir} onChange={(e) => cambiarAjuste('logo_opacidad', Number(e.target.value))} />
          </label>
        </div>
        <Previa logo={porDefecto} ajustes={a} />
        <div className="ms-cost">Los ejemplos son para ver el tamaño y la esquina. En cada creación el panel elige la versión clara u oscura según lo que haya detrás, y le pone una sombra suave.</div>
      </div>
    </>
  );
}
