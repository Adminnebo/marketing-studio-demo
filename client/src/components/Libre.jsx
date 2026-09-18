import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchModelos, costoLibre, crearLibre, autoPrompt, subirImagen } from '../api';
import { usd, cred } from '../precio';

const ASPECTOS_ES = { '16:9': 'Horizontal 16:9', '9:16': 'Vertical 9:16', '1:1': 'Cuadrado 1:1', '4:3': '4:3', '3:4': '3:4', '21:9': 'Cine 21:9', '3:2': '3:2', '2:3': '2:3', '4:5': '4:5', '5:4': '5:4' };
const VALOR_ES = { true: 'Sí', false: 'No', on: 'Sí', off: 'No', std: 'Estándar', pro: 'Pro', fast: 'Rápido', auto: 'Auto', standard: 'Normal', high: 'Alto', low: 'Baja', medium: 'Media', basic: 'Básica', ultra: 'Ultra', max: 'Máxima', xhigh: 'Muy alta' };
const etiqueta = (v) => VALOR_ES[String(v)] || String(v);

// Generacion libre: cualquier modelo de video o imagen, con prompt manual o
// autogenerado desde la imagen, calidad, duracion y costo en creditos.
export default function Libre({ saldo, rol, inicial, onEnviada }) {
  const [modelos, setModelos] = useState(null);
  const [error, setError] = useState(null);
  const [tipo, setTipo] = useState(inicial?.tipo || 'video');
  const [modeloId, setModeloId] = useState(inicial?.modelo || '');
  const [prompt, setPrompt] = useState(inicial?.prompt || '');
  const [modoPrompt, setModoPrompt] = useState('manual');
  const [imagen, setImagen] = useState(inicial?.imagen || null); // { media_id, url, nombre, local }
  const [subida, setSubida] = useState(null);
  const [aspecto, setAspecto] = useState(inicial?.aspecto || '');
  const [duracion, setDuracion] = useState(inicial?.duracion || '');
  const [opciones, setOpciones] = useState(inicial?.opciones || {});
  const [costo, setCosto] = useState({ cargando: false, creditos: null, precio: null, error: null });
  const [enviando, setEnviando] = useState(false);
  const [generandoPrompt, setGenerandoPrompt] = useState(false);
  const [producto, setProducto] = useState('');
  const [indicaciones, setIndicaciones] = useState('');
  const [avisos, setAvisos] = useState([]);
  const [msg, setMsg] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { fetchModelos().then((d) => setModelos(d.modelos)).catch((e) => setError(e.message)); }, []);

  const deTipo = useMemo(() => (modelos || []).filter((m) => m.tipo === tipo), [modelos, tipo]);
  const modelo = (modelos || []).find((m) => m.id === modeloId) || deTipo[0] || null;

  // Al cambiar de modelo, valores por defecto validos para ese modelo.
  useEffect(() => {
    if (!modelo) return;
    if (modelo.id !== modeloId) setModeloId(modelo.id);
    setAspecto((a) => (modelo.aspectos.includes(a) ? a : modelo.aspectos.includes('9:16') ? '9:16' : modelo.aspectos[0] || ''));
    setDuracion((d) => {
      const r = modelo.duracion;
      if (!r || modelo.tipo !== 'video') return '';
      if (r.opciones) return r.opciones.includes(Number(d)) ? d : String(r.def ?? r.opciones[0]);
      const n = Number(d);
      return n >= r.min && n <= r.max ? d : String(r.def ?? Math.max(r.min, Math.min(5, r.max)));
    });
    setOpciones((o) => Object.fromEntries(modelo.params.map((p) => [p.nombre, p.nombre in o && (p.tipo === 'bool' || p.opciones.includes(o[p.nombre])) ? o[p.nombre] : p.def])));
  }, [modelo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const datos = () => ({ modelo: modelo?.id, prompt, aspecto, duracion: duracion ? Number(duracion) : null, opciones, imagen: imagen && { media_id: imagen.media_id, url: imagen.url, nombre: imagen.nombre }, promptAuto: modoPrompt === 'auto' });

  // Costo en vivo (sin generar), con pausa para no pedirlo en cada tecla.
  useEffect(() => {
    if (!modelo) return undefined;
    setCosto((c) => ({ ...c, cargando: true, error: null }));
    const t = setTimeout(() => {
      costoLibre(datos()).then((r) => setCosto({ cargando: false, creditos: r.creditos, precio: r.precio, error: null }))
        .catch((e) => setCosto({ cargando: false, creditos: null, precio: null, error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [modelo?.id, aspecto, duracion, JSON.stringify(opciones), !!imagen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sin imagen no hay prompt automatico.
  useEffect(() => { if (!imagen && modoPrompt === 'auto') setModoPrompt('manual'); }, [imagen, modoPrompt]);

  const elegirArchivo = async (f) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setSubida({ error: 'Usa una imagen PNG, JPG o WEBP.' }); return; }
    if (f.size > 20 * 1024 * 1024) { setSubida({ error: 'La imagen pesa más de 20 MB.' }); return; }
    const local = URL.createObjectURL(f);
    setImagen(null);
    setSubida({ progreso: 0, nombre: f.name });
    try {
      const r = await subirImagen(f, (p) => setSubida({ progreso: p, nombre: f.name }));
      setImagen({ ...r, nombre: f.name, local });
      setSubida(null);
    } catch (e) { setSubida({ error: e.message }); }
  };

  const generarPrompt = async () => {
    setGenerandoPrompt(true);
    setMsg(null);
    try {
      const r = await autoPrompt({ imagen: { media_id: imagen.media_id, url: imagen.url }, modelo: modelo.id, tipo, duracion: duracion ? Number(duracion) : null, aspecto, opciones, producto, instrucciones: indicaciones });
      setPrompt(r.prompt || '');
      setAvisos(r.avisos || []);
    } catch (e) { setMsg({ error: e.message }); } finally { setGenerandoPrompt(false); }
  };

  const sinSaldo = rol !== 'super_admin' && costo.creditos != null && saldo != null && saldo < costo.creditos;
  const faltan = [
    !modelo && 'Elige un modelo.',
    modelo?.pideImagen && !imagen && `${modelo.nombre} necesita una imagen.`,
    !prompt.trim() && (modoPrompt === 'auto' ? 'Genera el prompt desde la imagen (o escríbelo).' : 'Escribe qué quieres generar.'),
    sinSaldo && `Saldo insuficiente: tienes ${cred(saldo)} créditos y esto usa ${cred(costo.creditos)}.`,
  ].filter(Boolean);

  const generar = async () => {
    if (faltan.length || enviando) return;
    setEnviando(true);
    setMsg(null);
    try {
      const g = await crearLibre(datos());
      setMsg({ ok: `Enviada (${g.preset_nombre}). La verás en Generaciones.` });
      onEnviada?.(g);
    } catch (e) { setMsg({ error: e.message }); } finally { setEnviando(false); }
  };

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>No se pudieron cargar los modelos: {error}</div>;

  return (
    <div className="card lb">
      <div className="lb-head">
        <div className="ms-chips">
          {[['video', '🎬 Video'], ['imagen', '🖼️ Imagen']].map(([k, l]) => (
            <button key={k} className={`dr-preset ${tipo === k ? 'active' : ''}`} onClick={() => { setTipo(k); setModeloId(''); }}>{l}</button>
          ))}
        </div>
        <select className="search select lb-modelo" value={modelo?.id || ''} onChange={(e) => setModeloId(e.target.value)} disabled={!modelos}>
          {!modelos && <option>Cargando modelos…</option>}
          {[...new Set(deTipo.map((m) => m.familia))].map((f) => (
            <optgroup key={f} label={f}>
              {deTipo.filter((m) => m.familia === f).map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
            </optgroup>
          ))}
        </select>
        {modelo?.descripcion && <span className="ms-cost lb-desc">{modelo.descripcion}</span>}
      </div>

      <div className="lb-cuerpo">
        <div className="lb-img">
          <button type="button" className={`ms-tile ${imagen ? 'filled' : ''}`} disabled={!modelo?.aceptaImagen || enviando}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (modelo?.aceptaImagen) elegirArchivo(e.dataTransfer.files?.[0]); }}
            title={modelo && !modelo.aceptaImagen ? `${modelo.nombre} no usa imagen` : ''}>
            {imagen ? (
              <>
                <img src={imagen.local || imagen.url} alt={imagen.nombre} />
                <span className="ms-tile-cap"><span>{imagen.nombre}</span>
                  <span role="button" tabIndex={0} style={{ fontWeight: 700 }} onClick={(e) => { e.stopPropagation(); setImagen(null); }}>Quitar</span>
                </span>
              </>
            ) : subida?.progreso != null ? (
              <>
                <span className="ms-tile-txt">Subiendo…</span>
                <div className="ms-progress"><div style={{ width: `${Math.round(subida.progreso * 100)}%` }} /></div>
              </>
            ) : (
              <>
                <span className="ms-tile-ic">🖼️</span>
                <span className="ms-tile-txt">{modelo?.aceptaImagen ? 'Imagen (opcional)' : 'Este modelo no usa imagen'}</span>
                <span className="ms-tile-sub">{modelo?.aceptaImagen ? (modelo.pideImagen ? 'Obligatoria para este modelo' : 'Arrastra o haz clic') : ''}</span>
              </>
            )}
          </button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { elegirArchivo(e.target.files?.[0]); e.target.value = ''; }} />
          {subida?.error && <div className="ms-gen-err">{subida.error}</div>}
        </div>

        <div className="lb-prompt">
          <div className="ms-chips" style={{ marginBottom: 8 }}>
            <button className={`mini-btn ${modoPrompt === 'manual' ? 'active' : ''}`} onClick={() => setModoPrompt('manual')}>✍️ Prompt manual</button>
            <button className={`mini-btn ${modoPrompt === 'auto' ? 'active' : ''}`} disabled={!imagen} onClick={() => setModoPrompt('auto')}
              title={imagen ? '' : 'Sube una imagen para autogenerar el prompt'}>✨ Autogenerar desde la imagen</button>
            {modoPrompt === 'auto' && (
              <button className="mini-btn" onClick={generarPrompt} disabled={generandoPrompt}>{generandoPrompt ? 'Generando…' : prompt ? '↻ Regenerar' : 'Generar prompt'}</button>
            )}
          </div>
          {modoPrompt === 'auto' && (
            <div className="lb-auto">
              <input className="ms-input" maxLength={120} placeholder="Producto (opcional): Breaker Siemens 2P 40A" value={producto} onChange={(e) => setProducto(e.target.value)} />
              <input className="ms-input" maxLength={1000} placeholder="Indicaciones (opcional): fondo de obra, destacar el amperaje, con mano…" value={indicaciones} onChange={(e) => setIndicaciones(e.target.value)} />
            </div>
          )}
          {avisos.length > 0 && (
            <div className="lb-avisos">
              <strong>Revisa antes de generar:</strong>
              <ul>{avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}
          <textarea className="ms-textarea lb-textarea" maxLength={5000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={modoPrompt === 'auto' ? 'El prompt se generará desde la imagen; podrás revisarlo y editarlo aquí.' : tipo === 'video'
              ? 'Ej.: breaker Siemens girando lento sobre fondo negro, luz de estudio, cámara que se acerca…'
              : 'Ej.: foto de producto de una lámpara LED sobre mesa de madera, luz cálida, estilo catálogo…'} />
        </div>
      </div>

      {modelo && (
        <div className="lb-opciones">
          {modelo.aspectos.length > 0 && (
            <label className="filter-field"><span>Formato</span>
              <select className="search select" value={aspecto} onChange={(e) => setAspecto(e.target.value)}>
                {modelo.aspectos.map((a) => <option key={a} value={a}>{ASPECTOS_ES[a] || a}</option>)}
              </select>
            </label>
          )}
          {modelo.tipo === 'video' && modelo.duracion && (
            <label className="filter-field"><span>Duración{duracion ? `: ${duracion} s` : ''}</span>
              {modelo.duracion.opciones ? (
                <select className="search select" value={duracion} onChange={(e) => setDuracion(e.target.value)}>
                  {modelo.duracion.opciones.map((d) => <option key={d} value={d}>{d} s</option>)}
                </select>
              ) : (
                <input type="range" min={modelo.duracion.min} max={modelo.duracion.max} step="1" value={duracion || modelo.duracion.min} onChange={(e) => setDuracion(e.target.value)} />
              )}
            </label>
          )}
          {modelo.params.map((p) => (
            <label key={p.nombre} className="filter-field"><span>{p.etiqueta}</span>
              {p.tipo === 'bool' ? (
                <select className="search select" value={String(!!opciones[p.nombre])} onChange={(e) => setOpciones({ ...opciones, [p.nombre]: e.target.value === 'true' })}>
                  <option value="true">Sí</option><option value="false">No</option>
                </select>
              ) : (
                <select className="search select" value={opciones[p.nombre] ?? p.def} onChange={(e) => setOpciones({ ...opciones, [p.nombre]: e.target.value })}>
                  {p.opciones.map((o) => <option key={o} value={o}>{etiqueta(o)}</option>)}
                </select>
              )}
            </label>
          ))}
        </div>
      )}

      {msg && <div className={msg.ok ? 'ms-ok' : 'ms-errors'} style={{ marginTop: 12 }}>{msg.ok || msg.error}</div>}
      <div className="ms-submit">
        <span className="ms-cost">
          {costo.cargando ? 'Calculando costo…' : costo.error ? costo.error : costo.creditos != null ? (
            <>Usa <strong>{cred(costo.creditos)} créditos</strong>{costo.precio != null && <> · <strong>{usd(costo.precio)}</strong></>}{rol !== 'super_admin' && saldo != null && ` · saldo ${cred(saldo)}`}</>
          ) : ''}
          {faltan.length > 0 && !costo.cargando && <><br />{faltan[0]}</>}
        </span>
        <button className="btn" onClick={generar} disabled={faltan.length > 0 || enviando || costo.cargando}>{enviando ? 'Enviando…' : '✨ Generar'}</button>
      </div>
    </div>
  );
}
