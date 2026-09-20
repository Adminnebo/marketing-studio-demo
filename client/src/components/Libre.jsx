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
const nombreFormato = (a) => (FORMATOS[a] ? FORMATOS[a][1] : a);

const pasosDe = (tipo) => [
  ['Qué crear', '🎬'], [tipo === 'video' ? 'Formato y duración' : 'Formato', '📐'], ['Tu foto', '📦'], ['Descripción', '✍️'], ['Revisar y crear', '✅'],
];

// Crear desde cero, paso a paso. El orden importa: el formato y la duracion van ANTES de la
// descripcion, porque la que escribe la IA se arma para esa duracion (tramos y ritmo), ese
// formato y el sonido. Si despues se cambia alguno, se avisa y se ofrece reescribirla.
export default function Libre({ saldo, rolReal, inicial, onEnviada, onVer, onRecargar }) {
  const [modelos, setModelos] = useState(null);
  const [error, setError] = useState(null);
  const [paso, setPaso] = useState(inicial ? 5 : 1); // 'Usar de nuevo' trae todo lleno: se abre en Revisar
  const [tipo, setTipo] = useState(inicial?.tipo || 'video');
  const [modeloId, setModeloId] = useState(inicial?.modelo || '');
  const [verModelos, setVerModelos] = useState(false);
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
  const [base, setBase] = useState(null); // ajustes con los que se escribió la descripción
  const inputRef = useRef(null);
  const caja = useRef(null);

  useEffect(() => { fetchModelos().then((d) => setModelos(d.modelos)).catch((e) => setError(e.message)); }, []);

  const deTipo = useMemo(() => (modelos || []).filter((m) => m.tipo === tipo), [modelos, tipo]);
  const modelo = (modelos || []).find((m) => m.id === modeloId) || deTipo[0] || null;
  const recomendado = deTipo[0] || null;

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

  const paramAudio = (modelo?.params || []).find(esAudio);
  const conAudio = paramAudio ? !!opciones[paramAudio.nombre] && opciones[paramAudio.nombre] !== 'off' : false;
  const ajustesActuales = { duracion: String(duracion || ''), aspecto, conAudio, imagen: imagen?.media_id || null };

  // La descripcion queda "al dia" con los ajustes cada vez que se escribe o edita.
  useEffect(() => { if (prompt.trim()) setBase(ajustesActuales); }, [prompt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Qué cambió después de escribir la descripción (lo que el usuario podría pasar por alto).
  const desajuste = !prompt.trim() || !base ? [] : [
    tipo === 'video' && base.duracion !== ajustesActuales.duracion && `la duración (estaba pensada para ${base.duracion} s y ahora son ${duracion} s)`,
    base.aspecto !== aspecto && `el formato (estaba pensada para ${nombreFormato(base.aspecto)} y ahora es ${nombreFormato(aspecto)})`,
    tipo === 'video' && base.conAudio !== conAudio && (conAudio ? 'el sonido (ahora lleva audio y la descripción no lo incluye)' : 'el sonido (ahora va sin audio y la descripción describe sonidos)'),
    base.imagen !== ajustesActuales.imagen && 'la foto del producto',
  ].filter(Boolean);

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
      setBase(ajustesActuales);
    } catch (e) { setMsg({ error: e.message }); } finally { setGenerandoPrompt(false); }
  };

  const cobra = rolReal !== 'super_admin';
  const sinSaldo = cobra && costo.creditos != null && saldo != null && saldo < costo.creditos;
  const usaIa = modoPrompt === 'auto' && modelo?.aceptaImagen;
  const nombreTipo = tipo === 'video' ? 'video' : 'foto';
  const elTipo = tipo === 'video' ? 'el video' : 'la foto';

  // Lo que falta, con el paso al que hay que volver.
  const faltan = [
    !modelo && [1, 'Elige un modelo.'],
    modelo?.pideImagen && !imagen && [3, 'Sube la foto del producto: este modelo la necesita.'],
    !prompt.trim() && [4, usaIa ? 'Falta la descripción: deja que la IA la escriba o escríbela tú.' : `Escribe qué quieres ver en ${elTipo}.`],
    sinSaldo && [5, `No te alcanza el saldo: tienes ${cred(saldo)} créditos y esto usa ${cred(costo.creditos)}.`],
  ].filter(Boolean);

  // Un paso esta listo cuando de verdad tiene lo que necesita (no solo por haber pasado).
  const listo = (n) => (n === 1 ? !!modelo : n === 2 ? !!modelo && (tipo !== 'video' || !modelo.duracion || !!duracion)
    : n === 3 ? (!modelo?.aceptaImagen || !!imagen) : n === 4 ? !!prompt.trim() : false);

  const ir = (n) => { setPaso(n); caja.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

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

  const subiendo = subida?.progreso != null;

  const reiniciar = () => { setMsg(null); setPrompt(''); setAvisos([]); setBase(null); setPaso(1); };

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>No se pudieron cargar los modelos: {error}</div>;

  const principales = (modelo?.params || []).filter((p) => PRINCIPALES.has(p.nombre));
  const avanzados = (modelo?.params || []).filter((p) => !PRINCIPALES.has(p.nombre));
  const hayQuality = principales.some((p) => p.nombre === 'quality');
  const formatos = [...(modelo?.aspectos || [])].sort((a, b) => ordenFormato(a) - ordenFormato(b));
  const verFormatos = masFormatos || formatos.indexOf(aspecto) >= 4 ? formatos : formatos.slice(0, 4);
  const calidadActual = principales.filter((p) => !esAudio(p)).map((p) => nombreCalidad(opciones[p.nombre] ?? p.def)).join(' · ');

  if (msg?.ok) {
    return (
      <div className="card lb" ref={caja}>
        <div className="lb-fin">
          <div className="lb-fin-ic">🎉</div>
          <h3>¡Listo! Tu {nombreTipo} se está creando</h3>
          <p>Tarda {tipo === 'video' ? 'de 2 a 10 minutos' : 'menos de un minuto'} y no hace falta esperar aquí: lo encuentras en <strong>Mis creaciones</strong>, que se actualiza solo.</p>
          <div className="ms-ok-acc">
            <button className="btn secondary" onClick={reiniciar}>Crear otro</button>
            <button className="btn" onClick={onVer}>Ver en Mis creaciones</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card lb" ref={caja}>
      {/* Barra de pasos: siempre se puede volver a cualquiera y cambiar lo que sea. */}
      <nav className="lb-barra" aria-label="Pasos">
        {pasosDe(tipo).map(([nom, ic], i) => {
          const n = i + 1;
          return (
            <button key={n} className={`lb-tab ${paso === n ? 'on' : ''} ${listo(n) ? 'hecho' : ''}`} onClick={() => ir(n)}>
              <span className="lb-tab-n">{listo(n) ? '✓' : n}</span>
              <span className="lb-tab-t">{ic} {nom}</span>
            </button>
          );
        })}
      </nav>

      {paso === 1 && (
        <section className="lb-cuerpo-paso">
          <div className="lb-pasoN">Paso {paso} de 5</div>
          <h3 className="lb-h">¿Qué quieres crear?</h3>
          <div className="seg">
            {[['video', '🎬', 'Un video'], ['imagen', '🖼️', 'Una foto']].map(([k, ic, l]) => (
              <button key={k} className={tipo === k ? 'on' : ''} onClick={() => { setTipo(k); setModeloId(''); }}><span>{ic}</span>{l}</button>
            ))}
          </div>
          {modelo && (
            <div className="lb-grupo">
              <div className="lb-lbl">Modelo de IA</div>
              {!verModelos ? (
                <div className="lb-modelo-elegido">
                  <div>
                    <strong>{modelo.nombre}</strong>{modelo.id === recomendado?.id && <span className="modo-tag">Recomendado</span>}
                    <div className="ms-cost">{modelo.descripcion || 'Cada modelo tiene su estilo y su precio.'}</div>
                  </div>
                  <button className="linklike" onClick={() => setVerModelos(true)}>Cambiar modelo</button>
                </div>
              ) : (
                <div className="lb-modelo-fila">
                  <select className="search select lb-modelo" value={modelo.id} onChange={(e) => setModeloId(e.target.value)} disabled={!modelos}>
                    {[...new Set(deTipo.map((m) => m.familia))].map((f) => (
                      <optgroup key={f} label={f}>
                        {deTipo.filter((m) => m.familia === f).map((m) => <option key={m.id} value={m.id}>{m.nombre}{m.id === recomendado?.id ? ' (recomendado)' : ''}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <span className="ms-cost lb-desc">{modelo.descripcion}</span>
                  <button className="linklike" onClick={() => setVerModelos(false)}>Listo</button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {paso === 2 && modelo && (
        <section className="lb-cuerpo-paso">
          <div className="lb-pasoN">Paso {paso} de 5</div>
          <h3 className="lb-h">Formato{tipo === 'video' ? ', duración' : ''} y calidad</h3>
          <p className="lb-porque">
            {tipo === 'video'
              ? 'Se elige antes que la descripción: la que escribe la IA se arma para esta duración (reparte la escena en tres tramos), este formato y el sonido.'
              : 'Se elige antes que la descripción: la que escribe la IA se arma para este formato y encuadre.'}
          </p>
          {formatos.length > 0 && (
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
        </section>
      )}

      {paso === 3 && (
        <section className="lb-cuerpo-paso">
          <div className="lb-pasoN">Paso {paso} de 5</div>
          <h3 className="lb-h">Foto de tu producto</h3>
          <p className="lb-porque">
            {modelo?.pideImagen ? 'Este modelo necesita la foto.'
              : modelo?.aceptaImagen ? 'Con foto, la IA copia tu producto tal como se ve y puede escribir la descripción por ti. Sin foto, tendrás que escribirla tú y el producto será inventado.'
                : 'Este modelo no usa foto: pasa al siguiente paso y escribe la descripción.'}
          </p>
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
                  <span className="ms-tile-sub">{modelo?.aceptaImagen ? 'Arrastra o haz clic · PNG, JPG, WEBP' : ''}</span>
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
        </section>
      )}

      {paso === 4 && (
        <section className="lb-cuerpo-paso">
          <div className="lb-pasoN">Paso {paso} de 5</div>
          <h3 className="lb-h">Descripción {tipo === 'video' ? 'del video' : 'de la foto'}</h3>
          <p className="lb-porque">
            Se escribirá para {tipo === 'video' ? <>un video <strong>{nombreFormato(aspecto)}</strong> de <strong>{duracion} s</strong> {conAudio ? 'con sonido' : 'sin sonido'}</> : <>una foto <strong>{nombreFormato(aspecto)}</strong></>}.
            <button className="linklike" style={{ marginLeft: 8 }} onClick={() => ir(2)}>Cambiar esto</button>
          </p>
          {modelo?.aceptaImagen && (
            <div className="seg seg-sm">
              <button className={usaIa ? 'on' : ''} onClick={() => setModoPrompt('auto')}><span>✨</span>Que la IA la escriba desde mi foto</button>
              <button className={!usaIa ? 'on' : ''} onClick={() => setModoPrompt('manual')}><span>✍️</span>La escribo yo</button>
            </div>
          )}
          {usaIa && (
            <div className="lb-ia">
              {!imagen && (
                <div className="lb-avisos">
                  Para que la IA la escriba hace falta la foto del producto.
                  <button className="linklike" onClick={() => ir(3)}>Subir la foto (paso 3) →</button>
                </div>
              )}
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
              <strong>Revisa esto antes de crear:</strong>
              <ul>{avisos.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          )}
          {(!usaIa || prompt) && (
            <>
              <textarea className="ms-textarea lb-textarea" maxLength={5000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder={tipo === 'video'
                  ? 'Ej.: breaker Siemens sobre fondo negro, luz de estudio, la cámara se acerca despacio hasta la etiqueta…'
                  : 'Ej.: lámpara LED sobre mesa de madera, luz cálida, estilo catálogo…'} />
              {usaIa && prompt && <div className="lb-nota">Está en inglés porque así la entiende mejor el modelo. Puedes editarla.</div>}
            </>
          )}
        </section>
      )}

      {paso === 5 && (
        <section className="lb-cuerpo-paso">
          <div className="lb-pasoN">Paso {paso} de 5</div>
          <h3 className="lb-h">Revisar y crear</h3>
          <p className="lb-porque">Repasa todo antes de gastar créditos. Puedes editar cualquier cosa.</p>
          <div className="lb-revisar">
            {[
              [1, tipo === 'video' ? 'Video' : 'Foto', modelo?.nombre],
              [2, 'Formato' + (tipo === 'video' ? ' y duración' : ''), [nombreFormato(aspecto), tipo === 'video' && duracion ? `${duracion} s` : null, calidadActual, tipo === 'video' && paramAudio ? (conAudio ? 'con sonido' : 'sin sonido') : null].filter(Boolean).join(' · ')],
              [3, 'Tu foto', imagen ? imagen.nombre : 'Sin foto'],
              [4, 'Descripción', prompt.trim() ? `${prompt.trim().slice(0, 150)}${prompt.trim().length > 150 ? '…' : ''}` : 'Falta escribirla'],
            ].map(([n, k, v]) => (
              <div key={n} className={`lb-rev ${!v || v === 'Falta escribirla' ? 'falta' : ''}`}>
                <span className="lb-rev-k">{k}</span>
                <span className="lb-rev-v">{v || '—'}</span>
                <button className="linklike" onClick={() => ir(n)}>Editar</button>
              </div>
            ))}
          </div>
          {desajuste.length > 0 && (
            <div className="lb-avisos">
              <strong>Ojo:</strong> después de escribir la descripción cambiaste {desajuste.join(' y ')}.
              {usaIa && imagen
                ? <> Conviene reescribirla para que cuadre. <button className="linklike" onClick={generarPrompt} disabled={generandoPrompt}>{generandoPrompt ? 'Escribiendo…' : '↻ Reescribir descripción'}</button></>
                : <> Revísala para que cuadre. <button className="linklike" onClick={() => ir(4)}>Editar descripción</button></>}
            </div>
          )}
          {msg?.error && <div className="ms-errors">{msg.error}</div>}
        </section>
      )}

      {/* Pie fijo: costo, lo que falta y navegación entre pasos */}
      <div className="lb-resumen">
        <div className="lb-costo">
          {costo.cargando ? <span className="ms-cost">Calculando costo…</span> : costo.error ? <span className="ms-cost">{costo.error}</span> : costo.creditos != null && (
            <>
              <span className="lb-costo-n">{nCred(costo.creditos)}{costo.precio != null && <span> · {usd(costo.precio)}</span>}</span>
              <span className="ms-cost">{cobra ? (saldo != null ? `Tu saldo: ${cred(saldo)} créditos` : '') : 'Super admin: no se descuenta del saldo de JH'}</span>
            </>
          )}
          {paso === 5 && faltan.length > 0 && (
            <span className="lb-falta">👉 {faltan[0][1]} <button className="linklike" onClick={() => ir(faltan[0][0])}>Ir al paso {faltan[0][0]}</button></span>
          )}
          {sinSaldo && <button className="linklike" onClick={onRecargar}>Ver cómo recargar →</button>}
        </div>
        <div className="lb-nav">
          {paso > 1 && <button className="btn secondary" onClick={() => ir(paso - 1)}>← Atrás</button>}
          {paso < 5 ? (
            <button className="btn" onClick={() => ir(paso + 1)} disabled={subiendo} title={subiendo ? 'Espera a que termine de subir la foto' : ''}>
              {subiendo ? 'Subiendo foto…' : 'Siguiente →'}
            </button>
          ) : (
            <button className="btn lb-generar" onClick={generar} disabled={faltan.length > 0 || enviando || costo.cargando}>
              {enviando ? 'Enviando…' : `✨ Crear ${nombreTipo}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
