import { useState } from 'react';
import { conectarRed, desconectarCuenta, cancelarPublicacion } from '../api';
import { REDES, ESTADOS_PUB, PUB_EN_CURSO } from '@shared/redes.mjs';

const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const ESTADO_RED = { pending: 'Pendiente', publishing: 'Publicando', published: 'Publicada', failed: 'Falló', cancelled: 'Cancelada' };

export function Cuenta({ c, children }) {
  const r = REDES[c.plataforma] || { nombre: c.plataforma, icono: '🌐' };
  return (
    <div className="rs-cuenta">
      <span className={`rs-foto ${c.reconectar ? 'mal' : 'bien'}`} title={c.reconectar ? 'Hay que reconectar' : 'Activa'}>
        {c.foto ? <img src={c.foto} alt="" /> : <span className="rs-cuenta-ic">{r.icono}</span>}
      </span>
      <div className="rs-cuenta-txt">
        <strong>{c.nombre || c.usuario || r.nombre}</strong>
        <span>{r.icono} {r.nombre}{c.usuario ? ` · @${c.usuario}` : ''}</span>
      </div>
      {children}
    </div>
  );
}

function Publicacion({ p, onCambio }) {
  const [cancelando, setCancelando] = useState(false);
  const [err, setErr] = useState(null);
  const porRed = new Map((p.plataformas || []).map((x) => [x.accountId || x.platform, x]));
  const cancelar = async () => {
    if (!window.confirm('¿Cancelar esta publicación programada?')) return;
    setCancelando(true);
    try { await cancelarPublicacion(p.id); onCambio(); } catch (e) { setErr(e.message); } finally { setCancelando(false); }
  };
  return (
    <div className="rs-pub">
      <div className="rs-pub-media">
        {p.medio?.tipo === 'video' ? <video src={p.medio.url} muted playsInline preload="metadata" /> : <img src={p.medio?.url} alt="" loading="lazy" />}
      </div>
      <div className="rs-pub-body">
        <div className="ms-gen-top">
          <span className="ms-gen-meta">
            {p.programada_para ? `Programada para ${fecha(p.programada_para)}` : `Publicada el ${fecha(p.creado)}`} · {p.creado_por}
          </span>
          <span className={`pill pub-${p.estado}`}>{ESTADOS_PUB[p.estado] || p.estado}</span>
        </div>
        {p.texto && <div className="rs-pub-texto">{p.texto}</div>}
        <div className="rs-pub-redes">
          {(p.cuentas || []).map((c) => {
            const x = porRed.get(c.id) || (p.plataformas || []).find((y) => y.platform === c.plataforma);
            const r = REDES[c.plataforma] || { nombre: c.plataforma, icono: '🌐' };
            return (
              <span key={c.id} className={`rs-red st-${x?.status || 'pending'}`} title={x?.errorMessage || ''}>
                {r.icono} {c.usuario ? `@${c.usuario}` : r.nombre}
                {x?.platformPostUrl
                  ? <a href={x.platformPostUrl} target="_blank" rel="noreferrer">ver ↗</a>
                  : <em>{p.estado === 'cancelada' ? 'Cancelada' : ESTADO_RED[x?.status] || ''}</em>}
              </span>
            );
          })}
        </div>
        {p.error && <div className="ms-gen-err">{p.error}</div>}
        {err && <div className="ms-gen-err">{err}</div>}
        {p.estado === 'programada' && (
          <div className="ms-gen-actions">
            <button className="mini-btn danger" onClick={cancelar} disabled={cancelando}>{cancelando ? 'Cancelando…' : 'Cancelar'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Redes({ estado, cuentas, errorCuentas, publicaciones, aviso, onRecargar }) {
  const [conectando, setConectando] = useState(null);
  const [error, setError] = useState(null);

  const conectar = async (plataforma) => {
    setConectando(plataforma);
    setError(null);
    try {
      const { url } = await conectarRed(plataforma);
      window.location.href = url; // vuelve al panel con ?redes=1 al terminar
    } catch (e) {
      setError(e.message);
      setConectando(null);
    }
  };
  const quitar = async (c) => {
    const r = REDES[c.plataforma]?.nombre || c.plataforma;
    if (!window.confirm(`¿Desconectar ${r}${c.usuario ? ` @${c.usuario}` : ''} del panel?`)) return;
    try { await desconectarCuenta(c.id); onRecargar(); } catch (e) { setError(e.message); }
  };

  if (estado && !estado.configurado) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Redes sociales</h3>
        <div className="card-sub">La conexión con redes todavía no está configurada. Avísale al administrador.</div>
      </div>
    );
  }

  const conectadas = new Set((cuentas || []).map((c) => c.plataforma));
  return (
    <>
      {aviso && <div className={aviso.ok ? 'ms-ok' : 'banner-off'} style={{ marginTop: 16 }}>{aviso.texto}</div>}
      <div className="section-title">Cuentas conectadas</div>
      <div className="card">
        {errorCuentas && <div className="ms-errors">{errorCuentas}</div>}
        {error && <div className="ms-errors" style={{ marginBottom: 12 }}>{error}</div>}
        {cuentas === null ? (
          <div className="loading" style={{ padding: 24 }}><div className="spinner" /></div>
        ) : cuentas.length ? (
          <div className="rs-cuentas">
            {cuentas.map((c) => (
              <Cuenta key={c.id} c={c}>
                {c.reconectar && <button className="mini-btn danger" onClick={() => conectar(c.plataforma)}>Reconectar</button>}
                <button className="mini-btn rs-quitar" onClick={() => quitar(c)} title="Desconectar" aria-label="Desconectar">✕</button>
              </Cuenta>
            ))}
          </div>
        ) : (
          <div className="card-sub">Todavía no hay cuentas conectadas. Conecta una para poder publicar.</div>
        )}
        <div className="rs-conectar">
          <span className="filter-lbl">Conectar:</span>
          {Object.entries(REDES).map(([k, r]) => (
            <button key={k} className="chip sm" disabled={!!conectando} onClick={() => conectar(k)} title={r.nota || ''}>
              {conectando === k ? '…' : r.icono} {r.nombre}{conectadas.has(k) ? ' +' : ''}
            </button>
          ))}
        </div>
        <div className="card-sub" style={{ margin: '10px 0 0' }}>
          Se abre el inicio de sesión de la red. Al aceptar vuelves aquí con la cuenta conectada. Facebook pide elegir la Página; Instagram debe ser una cuenta profesional.
        </div>
      </div>

      <div className="section-title">Publicaciones</div>
      {publicaciones === null ? (
        <div className="loading"><div className="spinner" /></div>
      ) : publicaciones.length ? (
        <div className="rs-pubs">
          {publicaciones.map((p) => <Publicacion key={p.id} p={p} onCambio={onRecargar} />)}
        </div>
      ) : (
        <div className="empty-state">Todavía no hay publicaciones.<br />En <strong>Generaciones</strong>, usa <strong>📣 Publicar</strong> en un resultado.</div>
      )}
      {(publicaciones || []).some((p) => PUB_EN_CURSO.has(p.estado)) && (
        <div className="ms-count" style={{ textAlign: 'center', marginTop: 10 }}>Se actualiza sola mientras haya publicaciones en curso</div>
      )}
    </>
  );
}
