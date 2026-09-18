import { useState } from 'react';
import { TIPOS } from '@shared/reglas.mjs';
import Portada from './Portada';
import { descargar } from '../api';

const ESTADOS = {
  pendiente: 'En cola', enviando: 'Enviando', en_proceso: 'Generando', completado: 'Lista', fallido: 'Falló',
};
export const EN_CURSO = new Set(['pendiente', 'enviando', 'en_proceso']);
const FILTROS = [['', 'Todas'], ['curso', 'En curso'], ['completado', 'Listas'], ['fallido', 'Fallidas']];

const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const esVideoUrl = (u) => /\.(mp4|mov|webm)($|\?)/i.test(u || '');

function Tarjeta({ g, onRepetir }) {
  const ok = (g.resultados || []).filter((r) => r.url);
  const [i, setI] = useState(0);
  const r = ok[Math.min(i, ok.length - 1)];
  const [bajando, setBajando] = useState(false);
  const [errBaja, setErrBaja] = useState(null);
  const bajar = async () => {
    setBajando(true);
    setErrBaja(null);
    try { await descargar(g.id, Math.min(i, ok.length - 1)); } catch (e) { setErrBaja(e.message); } finally { setBajando(false); }
  };
  return (
    <div className="ms-gen">
      <div className={`ms-gen-media ${g.estado === 'completado' && r ? 'done' : ''}`}>
        {g.estado === 'completado' && r ? (
          esVideoUrl(r.url)
            ? <video src={r.url} controls playsInline preload="metadata" />
            : <a href={r.url} target="_blank" rel="noreferrer"><img src={r.miniatura || r.url} alt={g.preset_nombre} loading="lazy" /></a>
        ) : (
          <>
            {g.portada && <Portada cover={g.portada} alt={g.preset_nombre} />}
            {EN_CURSO.has(g.estado) && (
              <div className="ms-gen-overlay"><div className="spinner" />{ESTADOS[g.estado]}…</div>
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
          {g.creditos_estimados != null && ` · ≈${Number(g.creditos_estimados).toLocaleString('es-MX', { maximumFractionDigits: 1 })} cr`}
        </div>
        <div className="ms-gen-meta">{g.creado_por}</div>
        {g.entrada?.args?.prompt && <div className="ms-gen-prompt" title={g.entrada.args.prompt}>“{g.entrada.args.prompt}”</div>}
        {g.error && <div className="ms-gen-err">{g.error}</div>}
        {errBaja && <div className="ms-gen-err">{errBaja}</div>}
        <div className="ms-gen-actions">
          {r && <button className="mini-btn" onClick={bajar} disabled={bajando}>{bajando ? 'Descargando…' : '⬇ Descargar'}</button>}
          {g.entrada?.preset && <button className="mini-btn" onClick={() => onRepetir(g)}>↻ Usar de nuevo</button>}
        </div>
      </div>
    </div>
  );
}

export default function Generaciones({ items, cargando, error, hayMas, onMas, onRepetir }) {
  const [filtro, setFiltro] = useState('');
  const visibles = items.filter((g) => !filtro || (filtro === 'curso' ? EN_CURSO.has(g.estado) : g.estado === filtro));
  return (
    <>
      <div className="ms-bar">
        <div className="ms-chips">
          {FILTROS.map(([k, l]) => (
            <button key={k} className={`dr-preset ${filtro === k ? 'active' : ''}`} onClick={() => setFiltro(k)}>{l}</button>
          ))}
        </div>
        <span className="ms-count">Se actualiza sola mientras haya generaciones en curso</span>
      </div>
      {error && <div className="banner-off">{error}</div>}
      {!items.length && cargando ? (
        <div className="loading"><div className="spinner" />Cargando generaciones…</div>
      ) : !visibles.length ? (
        <div className="empty-state">
          {items.length ? 'Nada con este filtro.' : <>Todavía no hay generaciones.<br />Elige una plantilla en <strong>Plantillas</strong> para empezar.</>}
        </div>
      ) : (
        <div className="ms-gens">
          {visibles.map((g) => <Tarjeta key={g.id} g={g} onRepetir={onRepetir} />)}
        </div>
      )}
      {hayMas && (
        <div className="ms-more"><button className="btn secondary" onClick={onMas} disabled={cargando}>Cargar más</button></div>
      )}
    </>
  );
}
