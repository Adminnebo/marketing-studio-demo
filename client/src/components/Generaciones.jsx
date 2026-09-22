import { useEffect, useRef, useState } from 'react';
import { TIPOS, TIPOS_VIDEO } from '@shared/reglas.mjs';
import Portada from './Portada';
import { descargar, fetchGeneraciones, fetchAutores } from '../api';
import { usd, usdFino, sinClausula } from '../precio';
import Tamano, { useTamano } from './Tamano';

const ESTADOS = {
  pendiente: 'En cola', enviando: 'Enviando', en_proceso: 'Creando', completado: 'Lista', fallido: 'No salió',
};
export const EN_CURSO = new Set(['pendiente', 'enviando', 'en_proceso']);
const FILTROS = [['', 'Todas'], ['curso', 'Creándose'], ['completado', 'Listas'], ['fallido', 'No salieron']];
const esVideoGen = (g) => g.preset_tipo === 'libre_video' || TIPOS_VIDEO.has(g.preset_tipo);

const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const esVideoUrl = (u) => /\.(mp4|mov|webm)($|\?)/i.test(u || '');

function Tarjeta({ g, rol, onRepetir, onPublicar, onBase, onBorrar }) {
  const ok = (g.resultados || []).filter((r) => r.url);
  const [i, setI] = useState(0);
  const r = ok[Math.min(i, ok.length - 1)];
  const [bajando, setBajando] = useState(false);
  const [errBaja, setErrBaja] = useState(null);
  const [base, setBase] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const bajar = async () => {
    setBajando(true);
    setErrBaja(null);
    try { await descargar(g.id, Math.min(i, ok.length - 1)); } catch (e) { setErrBaja(e.message); } finally { setBajando(false); }
  };
  return (
    <div className="ms-gen">
      <div className={`ms-gen-media ${g.estado === 'completado' && r ? 'done' : ''}`}>
        {g.estado === 'completado' && r ? (
          <>
            {esVideoUrl(r.url)
              ? <video src={r.url} controls playsInline preload="metadata" />
              : onPublicar
                // Clic en la foto: abre Publicar con esta foto (quien no puede publicar la ve grande).
                ? <button className="ms-gen-pub" onClick={() => onPublicar(g, Math.min(i, ok.length - 1))} title="Publicar esta foto"><img src={r.miniatura || r.url} alt={g.preset_nombre} loading="lazy" /></button>
                : <a href={r.url} target="_blank" rel="noreferrer"><img src={r.miniatura || r.url} alt={g.preset_nombre} loading="lazy" /></a>}
            <a className="ms-gen-abrir" href={r.url} target="_blank" rel="noreferrer" title="Ver en otra pestaña" aria-label="Ver en otra pestaña">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
            </a>
          </>
        ) : (
          <>
            {g.portada && <Portada cover={g.portada} alt={g.preset_nombre} />}
            {EN_CURSO.has(g.estado) && (
              <div className="ms-gen-overlay"><div className="spinner" />{ESTADOS[g.estado]}…
                <span className="ms-gen-eta">{esVideoGen(g) ? 'Un video tarda de 2 a 10 min' : 'Menos de un minuto'}</span>
              </div>
            )}
            {g.estado === 'fallido' && <div className="ms-gen-overlay err">⚠️ No se generó</div>}
          </>
        )}
      </div>
      {ok.length > 1 && (
        <div className="ms-thumbs">
          {ok.map((_, k) => <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)}>{k + 1}</button>)}
        </div>
      )}
      <div className="ms-gen-body">
        <div className="ms-gen-top">
          <span className="ms-gen-name" title={g.preset_nombre}>{g.preset_nombre || 'Plantilla'}</span>
          <span className={`pill st-${g.estado}`}>{ESTADOS[g.estado] || g.estado}</span>
        </div>
        <div className="ms-gen-meta">
          {TIPOS[g.preset_tipo] || g.preset_tipo} · {fecha(g.creado)}
          {g.precio_usd != null && ` · ≈${usd(Number(g.precio_usd) + Number(g.ia_usd || 0))}`}
          {Number(g.ia_usd) > 0 && <span title="Ayudas de IA (descripción automática, ficha técnica, Camila, textos para redes) incluidas en el total"> (incluye {usdFino(g.ia_usd)} de IA)</span>}
          {g.creditos_estimados != null && (g.precio_usd == null || rol === 'super_admin') && ` · ≈${Number(g.creditos_estimados).toLocaleString('es-MX', { maximumFractionDigits: 1 })} cr`}
        </div>
        {rol !== 'usuario' && <div className="ms-gen-meta">Por {g.creado_por}</div>}
        {sinClausula(g.entrada?.args?.prompt || g.entrada?.params?.prompt) && (
          <div className="ms-gen-prompt" title={sinClausula(g.entrada.args?.prompt || g.entrada.params?.prompt)}>“{sinClausula(g.entrada.args?.prompt || g.entrada.params?.prompt)}”</div>
        )}
        {g.entrada?.reintento && (
          <div className="ms-gen-nota">
            ↻ Reintento de la creación #{g.entrada.reintento.de}: el filtro de contenido la rechazó
            {g.entrada.reintento.motivo === 'copyright' ? ' por marcas' : ' por contenido sensible'} y la descripción se corrigió sola.
            {g.entrada.reintento.avisos?.[0] && <> <span className="ms-gen-nota-q">{g.entrada.reintento.avisos[0]}</span></>}
          </div>
        )}
        {g.error && <div className="ms-gen-err">{g.error}{g.estado === 'fallido' && g.precio_usd != null && !/administrador/.test(g.error) && ' Los créditos se devolvieron a tu saldo.'}</div>}
        {errBaja && <div className="ms-gen-err">{errBaja}</div>}
        <div className="ms-gen-actions">
          {r && <button className="mini-btn" onClick={bajar} disabled={bajando}>{bajando ? 'Descargando…' : '⬇ Descargar'}</button>}
          {r && onPublicar && <button className="mini-btn" onClick={() => onPublicar(g, Math.min(i, ok.length - 1))}>📣 Publicar</button>}
          {r && !esVideoUrl(r.url) && onBase && (
            <button className="mini-btn" disabled={base} title="Crear otra foto o un video partiendo de esta imagen, para darle más detalles o cambiarle cosas"
              onClick={async () => { setBase(true); setErrBaja(null); try { await onBase(g, Math.min(i, ok.length - 1)); } catch (e) { setErrBaja(e.message); } finally { setBase(false); } }}>
              {base ? 'Preparando…' : '✨ Usar como base'}
            </button>
          )}
          {onBorrar && !EN_CURSO.has(g.estado) && (
            <button className="mini-btn ms-gen-borrar" disabled={borrando} title="Quitarla de Mis creaciones (el gasto ya hecho no se devuelve)"
              onClick={async () => {
                if (!window.confirm(`¿Quitar "${g.preset_nombre || 'esta creación'}" de Mis creaciones? Se deja de ver para todos y no se puede deshacer desde aquí. Lo que costó no se devuelve.`)) return;
                setBorrando(true); setErrBaja(null);
                try { await onBorrar(g); } catch (e) { setErrBaja(e.message); setBorrando(false); }
              }}>
              {borrando ? 'Borrando…' : '🗑 Borrar'}
            </button>
          )}
          {(g.entrada?.preset || g.entrada?.libre) && <button className="mini-btn" onClick={() => onRepetir(g)} title="Abrir de nuevo con la misma foto y descripción para repetir o ajustar">↻ Usar de nuevo</button>}
        </div>
      </div>
    </div>
  );
}

const FILTROS_VACIOS = { q: '', medio: '', dias: '', autor: '', publicadas: '' };

// Busqueda en el servidor (todas las creaciones, no solo las cargadas): se pide sola al escribir o cambiar un filtro.
function useBusqueda(f) {
  const activa = Object.values(f).some(Boolean);
  const [r, setR] = useState({ items: [], cargando: false, error: null, siguiente: null });
  const pedido = useRef(0);
  useEffect(() => {
    if (!activa) return undefined;
    const n = ++pedido.current;
    setR((x) => ({ ...x, cargando: true }));
    const t = setTimeout(() => {
      fetchGeneraciones(null, f)
        .then((d) => n === pedido.current && setR({ items: d.items, cargando: false, error: null, siguiente: d.siguiente }))
        .catch((e) => n === pedido.current && setR((x) => ({ ...x, cargando: false, error: e.message })));
    }, f.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [activa, f.q, f.medio, f.dias, f.autor, f.publicadas]); // eslint-disable-line react-hooks/exhaustive-deps
  const mas = async () => {
    if (!r.siguiente) return;
    setR((x) => ({ ...x, cargando: true }));
    try { const d = await fetchGeneraciones(r.siguiente, f); setR((x) => ({ items: [...x.items, ...d.items], cargando: false, error: null, siguiente: d.siguiente })); }
    catch (e) { setR((x) => ({ ...x, cargando: false, error: e.message })); }
  };
  const quitar = (id) => setR((x) => ({ ...x, items: x.items.filter((g) => g.id !== id) }));
  return { activa, ...r, mas, quitar };
}

export default function Generaciones({ items: todas, cargando: cargandoTodas, error: errorTodas, hayMas: hayMasTodas, onMas, onRepetir, onPublicar, onBase, onBorrar, rol, onCrear }) {
  const [filtro, setFiltro] = useState('');
  const [f, setF] = useState(FILTROS_VACIOS);
  const [autores, setAutores] = useState([]);
  const [tam, setTam] = useTamano('ms_tam_creaciones', 250);
  const b = useBusqueda(f);
  const borrar = onBorrar && (async (g) => { await onBorrar(g); b.quitar(g.id); });
  useEffect(() => { if (rol !== 'usuario') fetchAutores().then((d) => setAutores(d.autores)).catch(() => {}); }, [rol]);
  // Lo que esta en curso se actualiza en la lista general; en la busqueda se toma de ahi.
  const frescas = new Map(todas.map((g) => [g.id, g]));
  const items = b.activa ? b.items.map((g) => frescas.get(g.id) || g) : todas;
  const cargando = b.activa ? b.cargando : cargandoTodas;
  const error = b.activa ? b.error : errorTodas;
  const hayMas = b.activa ? !!b.siguiente : hayMasTodas;
  const visibles = items.filter((g) => !filtro || (filtro === 'curso' ? EN_CURSO.has(g.estado) : g.estado === filtro));
  const cambiar = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="gn-filtros" role="search">
        <div className="gn-buscar">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input id="gn-q" type="search" value={f.q} onChange={(e) => cambiar('q', e.target.value)} maxLength={80}
            placeholder="Buscar por producto, código, descripción, plantilla o #número…" aria-label="Buscar creaciones" />
          {f.q && <button className="gn-x" onClick={() => cambiar('q', '')} aria-label="Borrar búsqueda">✕</button>}
        </div>
        <select id="gn-medio" className="gn-sel" value={f.medio} onChange={(e) => cambiar('medio', e.target.value)} aria-label="Tipo">
          <option value="">Fotos y videos</option><option value="foto">Solo fotos</option><option value="video">Solo videos</option>
        </select>
        <select id="gn-dias" className="gn-sel" value={f.dias} onChange={(e) => cambiar('dias', e.target.value)} aria-label="Fecha">
          <option value="">Cualquier fecha</option><option value="1">Últimas 24 h</option><option value="7">Últimos 7 días</option><option value="30">Últimos 30 días</option>
        </select>
        <select id="gn-autor" className="gn-sel" value={f.autor} onChange={(e) => cambiar('autor', e.target.value)} aria-label="Quién la creó">
          <option value="">De todos</option><option value="yo">Solo mías</option>
          {autores.map((a) => <option key={a.email} value={a.email}>{a.email} ({a.n})</option>)}
        </select>
        <label className="gn-check"><input id="gn-pub" type="checkbox" checked={f.publicadas === '1'} onChange={(e) => cambiar('publicadas', e.target.checked ? '1' : '')} /> Publicadas</label>
        {b.activa && <button className="linklike gn-limpiar" onClick={() => setF(FILTROS_VACIOS)}>Quitar filtros</button>}
      </div>
      <div className="pl-barra">
        <div className="pl-cats">
          {FILTROS.map(([k, l]) => {
            const n = items.filter((g) => !k || (k === 'curso' ? EN_CURSO.has(g.estado) : g.estado === k)).length;
            return <button key={k} className={`pl-cat ${filtro === k ? 'on' : ''}`} onClick={() => setFiltro(k)}>{l} <span className="pl-cat-n">{n}</span></button>;
          })}
        </div>
        <Tamano valor={tam} onCambio={setTam} min={180} max={400} />
      </div>
      {error && <div className="banner-off">{error}</div>}
      {!items.length && cargando ? (
        <div className="loading"><div className="spinner" />Cargando generaciones…</div>
      ) : !visibles.length ? (
        <div className="empty-state">
          {items.length || b.activa ? (b.activa && !items.length ? 'No hay creaciones que coincidan con la búsqueda.' : 'Nada con este filtro.') : (
            <>
              <div style={{ fontSize: '2rem' }}>🎨</div>
              <strong>Todavía no has creado nada.</strong><br />Lo que crees aparece aquí para verlo y descargarlo.
              {onCrear && <><br /><button className="btn" style={{ marginTop: 14 }} onClick={onCrear}>Crear mi primera foto o video</button></>}
            </>
          )}
        </div>
      ) : (
        <div className="ms-gens" style={{ '--tam': `${tam}px` }}>
          {visibles.map((g) => <Tarjeta key={g.id} g={g} rol={rol} onRepetir={onRepetir} onPublicar={onPublicar} onBase={onBase} onBorrar={borrar} />)}
        </div>
      )}
      {hayMas && (
        <div className="ms-more"><button className="btn secondary" onClick={b.activa ? b.mas : onMas} disabled={cargando}>Cargar más</button></div>
      )}
    </>
  );
}
