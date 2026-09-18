import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchModelos, costoLibre, crearLibre, autoPrompt, subirImagen } from '../api';
import { usd, cred, creditos as nCred } from '../precio';

// Formatos con nombre y para que sirve cada uno (los demas se muestran tal cual).
const FORMATOS = {
  '9:16': ['📱', 'Vertical', 'Reels, TikTok, historias'], '16:9': ['🖥️', 'Horizontal', 'YouTube, web'],
  '1:1': ['⬜', 'Cuadrado', 'Feed'], '4:5': ['📱', 'Vertical 4:5', 'Feed de Instagram'], '3:4': ['📱', 'Vertical 3:4', 'Feed'],
  '4:3': ['🖥️', 'Horizontal 4:3', 'Presentaciones'], '21:9': ['🎞️', 'Cine 21:9', 'Banners anchos'],
  '2:3': ['📱', 'Vertical 2:3', 'Pósters'], '3:2': ['🖥️', 'Horizontal 3:2', 'Fotos'], '5:4': ['🖥️', 'Horizontal 5:4', ''],
};
// Calidad (resolucion) con nombres que se entienden.
const CALIDAD = { '480p': 'Básica', '720p': 'HD', '1080p': 'Full HD', '2k': '2K', '4k': '4K', '1k': '1K', std: 'Estándar', pro: 'Pro', low: 'Baja', medium: 'Media', high: 'Alta', basic: 'Básica', ultra: 'Ultra', max: 'Máxima', xhigh: 'Muy alta' };
const VALOR_ES = { true: 'Sí', false: 'No', on: 'Sí', off: 'No', std: 'Estándar', pro: 'Pro', fast: 'Rápido', auto: 'Auto', standard: 'Normal', high: 'Alto', low: 'Baja', medium: 'Media', basic: 'Básica', ultra: 'Ultra', max: 'Máxima', xhigh: 'Muy alta' };
const etiqueta = (v) => VALOR_ES[String(v)] || String(v);
const PRINCIPALES = new Set(['resolution', 'quality', 'generate_audio', 'sound']); // el resto va en "Opciones avanzadas"
const esAudio = (p) => p.nombre === 'generate_audio' || p.nombre === 'sound';
// Los formatos mas usados primero; el resto queda detras de "Más formatos".
const ORDEN_FORMATOS = ['9:16', '16:9', '1:1', '4:5', '3:4', '4:3', '21:9', '2:3', '3:2', '5:4'];
const ordenFormato = (a) => { const i = ORDEN_FORMATOS.indexOf(a); return i === -1 ? 99 : i; };
const nombreCalidad = (o) => (CALIDAD[o] ? `${CALIDAD[o]}${/^\d+p$/.test(o) ? ` · ${o}` : ''}` : etiqueta(o));

function Paso({ n, titulo, sub, children }) {
  return (
    <section className="lb-paso">
      <div className="lb-paso-h"><span className="paso-num">{n}</span><div><div className="lb-paso-t">{titulo}</div>{sub && <div className="lb-paso-s">{sub}</div>}</div></div>
      {children}
    </section>
  );
}

// Crear desde cero: cualquier modelo de video o imagen, con descripcion escrita a mano o
// escrita por la IA desde la foto, formato, duracion, calidad y costo en creditos.
export default function Libre({ saldo, rol, rolReal, inicial, onEnviada, onVer, onRecargar }) {
  const [modelos, setModelos] = useState(null);
  const [error, setError] = useState(null);
  const [tipo, setTipo] = useState(inicial?.tipo || 'video');
  const [modeloId, setModeloId] = useState(inicial?.modelo || '');
  const [prompt, setPrompt] = useState(inicial?.prompt || '');
  const [modoPrompt, setModoPrompt] = useState(inicial?.prompt ? 'manual' : 'auto');
  const [imagen, setImagen] = useState(inicial?.imagen || null); // { media_id, url, nombre, local }
  const [subida, setSubida] = useState(null);
  const [aspecto, setAspecto] = useState(inicial?.aspecto || '');
  const [duracion, setDuracion] = useState(inicial?.duracion || '');
  const [opciones, setOpciones] = useState(inicial?.opciones || {});
  const [avanzado, setAvanzado] = useState(false);
  const [masFormatos, setMasFormatos] = useState(false);
  const [costo, setCosto] = useState({ cargando: false, creditos: null, precio: null, error: null });
  const [enviando, setEnviando] = useState(false);
  const [generandoPrompt, setGenerandoPrompt] = useState(false);
  const [producto, setProducto] = useState('');
  const [indicaciones, setIndicaciones] = useState('');
  const [avisos, setAvisos] = useState([]);
  const [msg, setMsg] = useState(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { fetchModelos().then((d) => setModelos(d.modelos)).catch((e) => setError(e.message)); }, []);

  const deTipo = useMemo(() => (modelos || []).filter((m) => m.tipo === tipo), [modelos, tipo]);
  const modelo = (modelos || []).find((m) => m.id === modeloId) || deTipo[0] || null;
  const recomendado = deTipo[0]?.id;

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

  // Costo en vivo (sin generar), con pausa para no pedirlo en cada cambio.
  useEffect(() => {
    if (!modelo) return undefined;
    setCosto((c) => ({ ...c, cargando: true, error: null }));
    const t = setTimeout(() => {
      costoLibre(datos()).then((r) => setCosto({ cargando: false, creditos: r.creditos, precio: r.precio, error: null }))
        .catch((e) => setCosto({ cargando: false, creditos: null, precio: null, error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [modelo?.id, aspecto, duracion, JSON.stringify(opciones), !!imagen]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const cobra = rolReal !== 'super_admin';
  const sinSaldo = cobra && costo.creditos != null && saldo != null && saldo < costo.creditos;
  const usaIa = modoPrompt === 'auto' && modelo?.aceptaImagen;
  const faltan = [
    !modelo && 'Elige un modelo.',
    modelo?.pideImagen && !imagen && 'Sube la foto del producto (este modelo la necesita).',
    usaIa && !imagen && 'Sube la foto del producto para que la IA escriba la descripción.',
    !prompt.trim() && (usaIa ? (imagen ? 'Toca "Escribir descripción" para que la IA la prepare.' : null) : 'Escribe qué quieres ver.'),
    sinSaldo && `No te alcanza el saldo: tienes ${cred(saldo)} créditos y esto usa ${cred(costo.creditos)}.`,
  ].filter(Boolean);

  const generar = async () => {
    if (faltan.length || enviando) return;
    setEnviando(true);
    setMsg(null);
    try {
      const g = await crearLibre(datos());
      setMsg({ ok: true, nombre: g.preset_nombre });
      onEnviada?.(g);
    } catch (e) { setMsg({ error: e.message }); } finally { setEnviando(false); }
  };

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>No se pudieron cargar los modelos: {error}</div>;

  const principales = (modelo?.params || []).filter((p) => PRINCIPALES.has(p.nombre));
  const avanzados = (modelo?.params || []).filter((p) => !PRINCIPALES.has(p.nombre));
  const nombreTipo = tipo === 'video' ? 'video' : 'foto';
  const elTipo = tipo === 'video' ? 'el video' : 'la foto';
  const formatos = [...(modelo?.aspectos || [])].sort((a, b) => ordenFormato(a) - ordenFormato(b));
  const verFormatos = masFormatos || formatos.indexOf(aspecto) >= 4 ? formatos : formatos.slice(0, 4);
  const hayQuality = principales.some((p) => p.nombre === 'quality');

  return (
    <div className="card lb">
      <Paso n="1" titulo="¿Qué quieres crear?">
        <div className="seg">
          {[['video', '🎬', 'Video'], ['imagen', '🖼️', 'Foto']].map(([k, ic, l]) => (
            <button key={k} className={tipo === k ? 'on' : ''} onClick={() => { setTipo(k); setModeloId(''); }}><span>{ic}</span>{l}</button>
          ))}
        </div>
      </Paso>

      <Paso n="2" titulo="Foto de tu producto" sub={modelo?.pideImagen ? 'Obligatoria para este modelo.' : 'Recomendada: la IA copia el producto tal como se ve en la foto.'}>
        <div className="lb-foto">
          <button type="button" className={`ms-tile ${imagen ? 'filled' : ''} ${drag ? 'drag' : ''}`} disabled={!modelo?.aceptaImagen || enviando}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (modelo?.aceptaImagen) elegirArchivo(e.dataTransfer.files?.[0]); }}>
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
                <span className="ms-tile-ic">📦</span>
                <span className="ms-tile-txt">{modelo?.aceptaImagen ? 'Subir foto' : 'Este modelo no usa foto'}</span>
                <span className="ms-tile-sub">{modelo?.aceptaImagen ? 'Arrastra o haz clic · PNG, JPG, WEBP' : 'Elige otro modelo en el paso 4 si quieres usar tu foto.'}</span>
              </>
            )}
          </button>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { elegirArchivo(e.target.files?.[0]); e.target.value = ''; }} />
          <ul className="lb-tips">
            <li>✅ Producto completo y nítido</li>
            <li>✅ Fondo blanco o liso</li>
            <li>✅ Sin otros objetos ni manos</li>
            <li>❌ Fotos borrosas, cortadas o con marcas de agua</li>
          </ul>
        </div>
        {subida?.error && <div className="ms-gen-err">{subida.error}</div>}
      </Paso>

      <Paso n="3" titulo={`Describe ${elTipo}`} sub={tipo === 'video' ? 'Qué pasa en la escena: fondo, luz, movimiento de cámara, ambiente.' : 'Cómo se ve: fondo, luz, ángulo, ambiente, textos.'}>
        {modelo?.aceptaImagen && (
          <div className="seg seg-sm">
            <button className={usaIa ? 'on' : ''} onClick={() => setModoPrompt('auto')}><span>✨</span>Que la IA la escriba desde mi foto</button>
            <button className={!usaIa ? 'on' : ''} onClick={() => setModoPrompt('manual')}><span>✍️</span>La escribo yo</button>
          </div>
        )}
        {usaIa && (
          <div className="lb-ia">
            {!imagen && <div className="lb-nota">Primero sube la foto del producto (paso 2). La IA la mira y escribe una descripción profesional que puedes revisar y editar.</div>}
            <div className="lb-auto">
              <label className="filter-field"><span>Nombre del producto (opcional)</span>
                <input className="ms-input" maxLength={120} placeholder="Ej.: Breaker Siemens 2P 40A" value={producto} onChange={(e) => setProducto(e.target.value)} />
              </label>
              <label className="filter-field"><span>¿Algo que quieras destacar? (opcional)</span>
                <input className="ms-input" maxLength={1000} placeholder="Ej.: fondo de obra, que se vea el amperaje, luz cálida…" value={indicaciones} onChange={(e) => setIndicaciones(e.target.value)} />
              </label>
            </div>
            <button className="btn secondary" onClick={generarPrompt} disabled={!imagen || generandoPrompt}>
              {generandoPrompt ? 'Escribiendo… (unos 20 s)' : prompt ? '↻ Escribir otra descripción' : '✨ Escribir descripción'}
            </button>
          </div>
        )}
        {avisos.length > 0 && (
          <div className="lb-avisos">
            <strong>Revisa esto antes de generar:</strong>
            <ul>{avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
        )}
        {(!usaIa || prompt) && (
          <textarea className="ms-textarea lb-textarea" maxLength={5000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={tipo === 'video'
              ? 'Ej.: breaker Siemens sobre fondo negro, luz de estudio, la cámara se acerca despacio hasta la etiqueta…'
              : 'Ej.: lámpara LED sobre mesa de madera, luz cálida, estilo catálogo…'} />
        )}
        {usaIa && prompt && <div className="lb-nota">La descripción está en inglés porque así la entiende mejor el modelo. Puedes editarla.</div>}
      </Paso>

      {modelo && (
        <Paso n="4" titulo="Formato y calidad">
          {modelo.aspectos.length > 0 && (
            <div className="lb-grupo">
              <div className="lb-lbl">Formato</div>
              <div className="lb-formatos">
                {verFormatos.map((a) => {
                  const [ic, nom, uso] = FORMATOS[a] || ['▭', a, ''];
                  return (
                    <button key={a} className={`lb-formato ${aspecto === a ? 'on' : ''}`} onClick={() => setAspecto(a)} title={uso}>
                      <span className="lb-f-ic">{ic}</span><span className="lb-f-n">{nom}</span>{uso && <span className="lb-f-u">{uso}</span>}
                    </button>
                  );
                })}
                {formatos.length > verFormatos.length && <button className="linklike" onClick={() => setMasFormatos(true)}>Más formatos ({formatos.length - verFormatos.length}) ▾</button>}
              </div>
            </div>
          )}

          <div className="lb-fila">
            {modelo.tipo === 'video' && modelo.duracion && (
              <label className="filter-field lb-dur"><span>Duración: <strong>{duracion || '—'} segundos</strong></span>
                {modelo.duracion.opciones ? (
                  <div className="seg seg-sm">
                    {modelo.duracion.opciones.map((d) => <button key={d} className={String(duracion) === String(d) ? 'on' : ''} onClick={() => setDuracion(String(d))}>{d} s</button>)}
                  </div>
                ) : (
                  <>
                    <input type="range" min={modelo.duracion.min} max={modelo.duracion.max} step="1" value={duracion || modelo.duracion.min} onChange={(e) => setDuracion(e.target.value)} />
                    <span className="lb-rango"><span>{modelo.duracion.min} s</span><span>{modelo.duracion.max} s</span></span>
                  </>
                )}
              </label>
            )}
            {principales.map((p) => (
              esAudio(p) ? (
                <label key={p.nombre} className="lb-check">
                  <input type="checkbox" checked={!!opciones[p.nombre] && opciones[p.nombre] !== 'off'}
                    onChange={(e) => setOpciones({ ...opciones, [p.nombre]: p.tipo === 'bool' ? e.target.checked : (e.target.checked ? (p.opciones.find((o) => o !== 'off') || p.def) : 'off') })} />
                  🔊 Con sonido
                </label>
              ) : p.tipo === 'opciones' && (
                <label key={p.nombre} className="filter-field"><span>{p.nombre === 'quality' || !hayQuality ? 'Calidad' : 'Resolución'}</span>
                  <div className="seg seg-sm">
                    {p.opciones.map((o) => <button key={o} className={(opciones[p.nombre] ?? p.def) === o ? 'on' : ''} onClick={() => setOpciones({ ...opciones, [p.nombre]: o })}>{nombreCalidad(o)}</button>)}
                  </div>
                </label>
              )
            ))}
          </div>

          <div className="lb-grupo">
            <div className="lb-lbl">Modelo de IA</div>
            <div className="lb-modelo-fila">
              <select className="search select lb-modelo" value={modelo.id} onChange={(e) => setModeloId(e.target.value)} disabled={!modelos}>
                {[...new Set(deTipo.map((m) => m.familia))].map((f) => (
                  <optgroup key={f} label={f}>
                    {deTipo.filter((m) => m.familia === f).map((m) => <option key={m.id} value={m.id}>{m.nombre}{m.id === recomendado ? ' (recomendado)' : ''}</option>)}
                  </optgroup>
                ))}
              </select>
              <span className="ms-cost lb-desc">{modelo.descripcion || 'Cada modelo tiene su estilo y su precio: el costo se actualiza abajo al cambiarlo.'}</span>
            </div>
          </div>

          {avanzados.length > 0 && (
            <>
              <button className="linklike" onClick={() => setAvanzado(!avanzado)}>{avanzado ? 'Ocultar opciones avanzadas ▲' : 'Opciones avanzadas ▼'}</button>
              {avanzado && (
                <div className="lb-opciones">
                  {avanzados.map((p) => (
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
            </>
          )}
        </Paso>
      )}

      {msg?.error && <div className="ms-errors">{msg.error}</div>}
      {msg?.ok ? (
        <div className="ms-ok">
          <span>✅ ¡Listo! Tu {nombreTipo} se está creando. Tarda {tipo === 'video' ? 'de 2 a 10 minutos' : 'menos de un minuto'}; no hace falta esperar aquí.</span>
          <span className="ms-ok-acc">
            <button className="btn secondary" onClick={() => setMsg(null)}>Crear otro</button>
            <button className="btn" onClick={onVer}>Ver en Mis creaciones</button>
          </span>
        </div>
      ) : (
        <div className="lb-resumen">
          <div className="lb-costo">
            {costo.cargando ? <span className="ms-cost">Calculando costo…</span> : costo.error ? <span className="ms-cost">{costo.error}</span> : costo.creditos != null && (
              <>
                <span className="lb-costo-n">{nCred(costo.creditos)}{costo.precio != null && <span> · {usd(costo.precio)}</span>}</span>
                <span className="ms-cost">{cobra ? (saldo != null ? `Tu saldo: ${cred(saldo)} créditos` : '') : 'Super admin: no se descuenta del saldo de JH'}</span>
              </>
            )}
            {faltan.length > 0 && !costo.cargando && <span className="lb-falta">👉 {faltan[0]}</span>}
            {sinSaldo && <button className="linklike" onClick={onRecargar}>Ver cómo recargar →</button>}
          </div>
          <button className="btn lb-generar" onClick={generar} disabled={faltan.length > 0 || enviando || costo.cargando}>
            {enviando ? 'Enviando…' : `✨ Crear ${nombreTipo}`}
          </button>
        </div>
      )}
    </div>
  );
}
