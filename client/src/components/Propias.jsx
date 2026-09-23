import { useEffect, useRef, useState } from 'react';
import { fetchPropias, analizarPropia, crearPropia, editarPropia, borrarPropia, subirImagen } from '../api';
import { usdFino } from '../precio';

// Plantillas propias: los diseños que JH ya publicó, convertidos en receta reutilizable.
// Se sube el diseño, la IA saca la receta (cómo está armado, sin el producto del ejemplo),
// se revisa y se guarda. Al usarla, abre "Desde cero" con la receta ya puesta.

const FORMATOS = { '9:16': 'Vertical', '16:9': 'Horizontal', '1:1': 'Cuadrado', '4:5': 'Vertical 4:5', '3:4': 'Vertical 3:4', '4:3': 'Horizontal 4:3', '2:3': 'Vertical 2:3', '3:2': 'Horizontal 3:2', '21:9': 'Cine' };
const MAX_RECETA = 1500;

function Nueva({ onListo, onCancelar }) {
  const [para, setPara] = useState('video');
  const [imagen, setImagen] = useState(null);   // { media_id, url, local, nombre }
  const [subiendo, setSubiendo] = useState(false);
  const [analizando, setAnalizando] = useState(false);
  const [r, setR] = useState(null);             // { nombre, receta, aspecto, duracion, avisos, costoIa }
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const elegir = async (archivo) => {
    if (!archivo) return;
    setError(null); setR(null); setSubiendo(true);
    const local = URL.createObjectURL(archivo);
    setImagen({ local, nombre: archivo.name });
    try {
      const m = await subirImagen(archivo);
      setImagen({ ...m, local });
    } catch (e) { setError(e.message); setImagen(null); } finally { setSubiendo(false); }
  };

  const analizar = async () => {
    setAnalizando(true); setError(null);
    try { setR(await analizarPropia({ imagen, para })); } catch (e) { setError(e.message); } finally { setAnalizando(false); }
  };

  const guardar = async () => {
    setGuardando(true); setError(null);
    try {
      const f = await crearPropia({ ...r, para, conAudio: para === 'video', imagen });
      onListo(f);
    } catch (e) { setError(e.message); setGuardando(false); }
  };

  return (
    <div className="card pp-nueva">
      <h3>➕ Nueva plantilla desde un diseño tuyo</h3>
      <div className="card-sub">Sube una imagen de algo que ya publicaste. La IA saca de ahí cómo está armado —composición, fondo, luz, colores, zonas de texto— para poder repetirlo con cualquier otro producto. El producto del ejemplo no se copia.</div>

      <div className="pp-paso">
        <div className="pp-lbl">1. ¿Para qué la vas a usar?</div>
        <div className="seg">
          <button className={para === 'video' ? 'on' : ''} onClick={() => { setPara('video'); setR(null); }}>🎬 Videos</button>
          <button className={para === 'foto' ? 'on' : ''} onClick={() => { setPara('foto'); setR(null); }}>🖼️ Fotos</button>
        </div>
      </div>

      <div className="pp-paso">
        <div className="pp-lbl">2. El diseño</div>
        <div className="pp-subir">
          {imagen ? (
            <div className="pp-prev">
              <img src={imagen.local || imagen.url} alt="" />
              <div>
                <div className="pp-prev-n">{imagen.nombre || 'Tu diseño'}</div>
                <button className="linklike" onClick={() => { setImagen(null); setR(null); }}>Cambiar</button>
              </div>
            </div>
          ) : (
            <button className="btn secondary" onClick={() => inputRef.current?.click()} disabled={subiendo}>
              {subiendo ? 'Subiendo…' : '📤 Subir imagen del diseño'}
            </button>
          )}
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => elegir(e.target.files?.[0])} />
        </div>
        <div className="pp-nota">Por ahora solo imágenes (PNG, JPG o WEBP). Si tu diseño es un video, sube una captura de su mejor momento.</div>
      </div>

      {imagen?.media_id && !r && (
        <button className="btn" onClick={analizar} disabled={analizando}>{analizando ? 'Leyendo el diseño… (unos 15 s)' : '✨ Leer el diseño'}</button>
      )}

      {r && (
        <div className="pp-paso">
          <div className="pp-lbl">3. Revisa la receta y guárdala</div>
          <label className="filter-field"><span>Nombre de la plantilla</span>
            <input className="ms-input" maxLength={80} value={r.nombre} onChange={(e) => setR({ ...r, nombre: e.target.value })} />
          </label>
          <label className="filter-field"><span>Receta: lo que se va a repetir en cada pieza (puedes editarla)</span>
            <textarea className="ms-textarea pp-receta" maxLength={MAX_RECETA} value={r.receta} onChange={(e) => setR({ ...r, receta: e.target.value })} />
          </label>
          <div className="pp-fila">
            <label className="filter-field"><span>Formato</span>
              <select className="ms-input" value={r.aspecto} onChange={(e) => setR({ ...r, aspecto: e.target.value })}>
                {Object.entries(FORMATOS).map(([k, n]) => <option key={k} value={k}>{n} ({k})</option>)}
              </select>
            </label>
            {para === 'video' && (
              <label className="filter-field"><span>Duración (segundos)</span>
                <input className="ms-input" type="number" min="3" max="30" value={r.duracion ?? 10} onChange={(e) => setR({ ...r, duracion: Number(e.target.value) })} />
              </label>
            )}
          </div>
          {r.avisos?.length > 0 && (
            <div className="lb-avisos"><strong>Revisa esto:</strong><ul>{r.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          )}
          {r.costoIa > 0 && <div className="pp-nota">Leer el diseño costó {usdFino(r.costoIa)}.</div>}
          <div className="pp-acc">
            <button className="btn" onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : '💾 Guardar plantilla'}</button>
            <button className="btn secondary" onClick={analizar} disabled={analizando}>{analizando ? 'Leyendo…' : '↻ Leer de nuevo'}</button>
          </div>
        </div>
      )}

      {error && <div className="ms-errors">{error}</div>}
      <button className="linklike" onClick={onCancelar}>Cancelar</button>
    </div>
  );
}

function Tarjeta({ p, onUsar, onBorrada, puedeBorrar }) {
  const [abierta, setAbierta] = useState(false);
  const [editando, setEditando] = useState(null);
  const [msg, setMsg] = useState(null);
  const guardar = async () => {
    try { await editarPropia(p.id, { nombre: editando.nombre, receta: editando.receta }); setEditando(null); onBorrada(); } catch (e) { setMsg(e.message); }
  };
  const borrar = async () => {
    if (!window.confirm(`¿Borrar la plantilla "${p.nombre}"? Las creaciones que ya se hicieron con ella no se tocan.`)) return;
    try { await borrarPropia(p.id); onBorrada(); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="pp-card">
      <button className="pp-card-img" onClick={() => setAbierta(!abierta)} title="Ver la receta">
        {p.portada?.url ? <img src={p.portada.url} alt="" loading="lazy" /> : <span>🧩</span>}
        <i className="pp-card-tipo">{p.para === 'foto' ? '🖼️' : '🎬'}</i>
      </button>
      <div className="pp-card-cuerpo">
        <div className="pp-card-t">{p.nombre}</div>
        <div className="pp-card-m">
          {p.para === 'foto' ? 'Fotos' : `Videos · ${p.duracion || 10} s`} · {FORMATOS[p.aspecto] || p.aspecto}
          {p.usos > 0 && ` · usada ${p.usos} ${p.usos === 1 ? 'vez' : 'veces'}`}
        </div>
        {abierta && (editando ? (
          <div className="pp-edit">
            <input className="ms-input" maxLength={80} value={editando.nombre} onChange={(e) => setEditando({ ...editando, nombre: e.target.value })} />
            <textarea className="ms-textarea pp-receta" maxLength={MAX_RECETA} value={editando.receta} onChange={(e) => setEditando({ ...editando, receta: e.target.value })} />
            <div className="pp-acc">
              <button className="mini-btn" onClick={guardar}>Guardar</button>
              <button className="mini-btn" onClick={() => setEditando(null)}>Cancelar</button>
            </div>
          </div>
        ) : <div className="pp-card-receta">{p.receta}</div>)}
        {msg && <div className="ms-gen-err">{msg}</div>}
        <div className="pp-card-acc">
          <button className="btn cal-b" onClick={() => onUsar(p)}>✨ Usar</button>
          <button className="btn secondary cal-b" onClick={() => setAbierta(!abierta)}>{abierta ? 'Ocultar receta' : 'Ver receta'}</button>
          {abierta && !editando && <button className="btn secondary cal-b" onClick={() => setEditando({ nombre: p.nombre, receta: p.receta })}>✏️ Editar</button>}
          {puedeBorrar && <button className="btn secondary cal-b cal-b-danger" onClick={borrar}>🗑 Borrar</button>}
        </div>
      </div>
    </div>
  );
}

export default function Propias({ onUsar, email, rol }) {
  const [d, setD] = useState({ items: [], cargando: true, error: null });
  const [nueva, setNueva] = useState(false);
  const cargar = () => {
    setD((x) => ({ ...x, cargando: true }));
    fetchPropias().then((r) => setD({ items: r.items, cargando: false, error: null }))
      .catch((e) => setD({ items: [], cargando: false, error: e.message }));
  };
  useEffect(cargar, []);

  return (
    <div className="pp">
      <div className="pp-barra">
        <div>
          <h2 className="pp-titulo">Mis plantillas</h2>
          <span className="ms-cost">Tus propios diseños, listos para repetir con cualquier producto.</span>
        </div>
        {!nueva && <button className="btn" onClick={() => setNueva(true)}>➕ Nueva plantilla</button>}
      </div>

      {nueva && <Nueva onCancelar={() => setNueva(false)} onListo={() => { setNueva(false); cargar(); }} />}

      {d.error && <div className="ms-errors">{d.error}</div>}
      {d.cargando ? <div className="spinner" /> : d.items.length ? (
        <div className="pp-grid">
          {d.items.map((p) => (
            <Tarjeta key={p.id} p={p} onUsar={onUsar} onBorrada={cargar} puedeBorrar={p.creado_por === email || rol !== 'usuario'} />
          ))}
        </div>
      ) : !nueva && (
        <div className="empty-state" style={{ padding: 28 }}>
          Todavía no hay plantillas propias.<br />
          Sube un diseño que ya publicaste y se convierte en una plantilla que puedes usar con cualquier producto.
        </div>
      )}
    </div>
  );
}
