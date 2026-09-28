import { useEffect, useState } from 'react';
import { fetchZernioSetup, elegirPerfilZernio, registrarWebhookRedes, limpiarWebhooksRedes } from '../api';
import { REDES } from '@shared/redes.mjs';

const nombreRed = (p) => REDES[p]?.nombre || p;

/**
 * Setup de redes (Zernio) en Super Admin: clave, perfil de la cuenta de Zernio que usa el
 * panel, redes de ese perfil y webhook. La cuenta de Zernio es compartida con otros
 * proyectos: aqui solo se elige cual perfil es el de JH; los demas no se tocan.
 */
export default function RedesSetup() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const [msg, setMsg] = useState(null);
  const [verTodos, setVerTodos] = useState(false);

  const cargar = () => { setError(null); fetchZernioSetup().then(setD).catch((e) => setError(e.message)); };
  useEffect(cargar, []);

  const elegir = async (id) => {
    setOcupado(id); setMsg(null);
    try { const r = await elegirPerfilZernio(id); setMsg(`Perfil elegido: ${r.perfil.nombre}.`); cargar(); } catch (e) { setMsg(e.message); } finally { setOcupado(null); }
  };
  const webhook = async () => {
    setOcupado('webhook'); setMsg(null);
    try {
      const r = await registrarWebhookRedes();
      setMsg(`Webhook ${r.creado ? 'registrado' : 'actualizado'}${r.prueba?.success ? ' y probado ✅' : r.prueba?.error ? `; la prueba falló: ${r.prueba.error}` : ''}.`);
      cargar();
    } catch (e) { setMsg(e.message); } finally { setOcupado(null); }
  };

  const limpiar = async () => {
    setOcupado('limpiar'); setMsg(null);
    try {
      const r = await limpiarWebhooksRedes();
      setMsg(r.borrados.length ? `Borrado${r.borrados.length > 1 ? 's' : ''} ${r.borrados.length} webhook de más.` : 'No había ninguno de más.');
      cargar();
    } catch (e) { setMsg(e.message); } finally { setOcupado(null); }
  };

  if (error) return <div className="card"><h3>Redes (Zernio)</h3><div className="ms-errors">{error}</div><button className="mini-btn" onClick={cargar}>Reintentar</button></div>;
  if (!d) return <div className="card"><h3>Redes (Zernio)</h3><div className="loading"><div className="spinner" />Revisando Zernio…</div></div>;

  const perfil = (d.perfiles || []).find((p) => p.id === d.perfilId) || null;
  const deJH = perfil ? perfil.cuentas.filter((c) => REDES[c.plataforma]) : [];
  const otras = perfil ? perfil.cuentas.filter((c) => !REDES[c.plataforma]) : [];
  const pasos = [
    { ok: d.configurado, t: 'Clave de Zernio', s: d.configurado ? 'Cargada en el panel y el worker.' : 'Falta ZERNIO_API_KEY en Railway (panel y worker).' },
    { ok: !!perfil, t: 'Perfil de JH en Zernio', s: perfil ? perfil.nombre : 'Elige cuál perfil de la cuenta de Zernio es el de JH.' },
    { ok: deJH.length > 0, t: 'Redes conectadas', s: deJH.length ? deJH.map((c) => `${nombreRed(c.plataforma)} @${c.usuario || '—'}`).join(' · ') : 'Todavía no hay Instagram, Facebook, TikTok… en ese perfil.' },
    { ok: !!d.webhookId, t: 'Avisos al momento (webhook)', s: d.webhookId ? 'Registrado: las publicaciones se actualizan solas.' : d.webhookListo ? 'Falta registrarlo.' : 'Falta ZERNIO_WEBHOOK_SECRET.' },
  ];
  // Webhooks nuestros que sobran: quedan si el panel cambió de dominio y el
  // registro viejo siguió activo. Cada evento llega dos veces (se descarta el
  // repetido, pero es basura en una cuenta compartida).
  const nuestros = d.webhooks || [];
  const deMas = nuestros.filter((w) => !w.enUso);
  const listo = pasos.every((p) => p.ok);
  // Primero el elegido y los que se parecen a JH; el resto detras de "ver todos".
  const ordenados = [...(d.perfiles || [])].sort((a, b) => (b.id === d.perfilId) - (a.id === d.perfilId) || /\bJH\b/i.test(b.nombre) - /\bJH\b/i.test(a.nombre) || b.cuentas.length - a.cuentas.length);
  const visibles = verTodos ? ordenados : ordenados.filter((p) => p.id === d.perfilId || /\bJH\b/i.test(p.nombre));

  return (
    <div className="card rs-setup">
      <div className="rs-setup-cab">
        <h3>Redes (Zernio)</h3>
        <span className={`rs-estado ${listo ? 'ok' : ''}`}>{listo ? '✓ Listo para publicar' : 'Falta completar'}</span>
        <button className="mini-btn" onClick={cargar}>↻ Revisar</button>
      </div>
      <ol className="rs-pasos">
        {pasos.map((p) => (
          <li key={p.t} className={p.ok ? 'ok' : ''}><span className="rs-marca">{p.ok ? '✓' : ''}</span><div><b>{p.t}</b><span>{p.s}</span></div></li>
        ))}
      </ol>

      {d.configurado && (
        <>
          <div className="rs-sub">Perfil que usa el panel <span className="ms-cost">· la cuenta de Zernio tiene {d.perfiles.length} perfiles de distintos proyectos; solo se usa el elegido</span></div>
          <div className="rs-perfiles">
            {visibles.map((p) => (
              <div key={p.id} className={`rs-perfil ${p.id === d.perfilId ? 'on' : ''}`}>
                <div className="rs-perfil-t"><b>{p.nombre}</b>
                  {p.id === d.perfilId ? <span className="rs-usado">En uso</span>
                    : <button className="mini-btn" disabled={!!ocupado} onClick={() => elegir(p.id)}>{ocupado === p.id ? 'Guardando…' : 'Usar este'}</button>}
                </div>
                <div className="rs-perfil-c">{p.cuentas.length ? p.cuentas.map((c, i) => (
                  <span key={i} className={`rs-chip ${REDES[c.plataforma] ? '' : 'no'} ${c.reconectar ? 'rec' : ''}`} title={REDES[c.plataforma] ? '' : 'El panel no publica en esta red'}>
                    {REDES[c.plataforma]?.icono || '•'} {nombreRed(c.plataforma)}{c.usuario ? ` @${c.usuario}` : ''}{c.reconectar ? ' · reconectar' : ''}
                  </span>
                )) : <span className="ms-cost">Sin redes todavía</span>}</div>
              </div>
            ))}
          </div>
          {ordenados.length > visibles.length && (() => { const n = ordenados.length - visibles.length; return (
            <button className="linklike" onClick={() => setVerTodos(true)}>{n === 1 ? 'Ver el otro perfil' : `Ver los otros ${n} perfiles`}</button>
          ); })()}
          {otras.length > 0 && <div className="ms-cost">En este perfil también hay {otras.map((c) => nombreRed(c.plataforma)).join(', ')}: el panel no publica ahí, así que no aparece en Redes.</div>}
          {perfil && !deJH.length && <div className="rs-nota">Conecten Instagram, Facebook o TikTok en este perfil (desde Zernio o desde la pestaña Redes del panel) y toquen ↻ Revisar.</div>}
          {nuestros.length > 0 && (
            <>
              <div className="rs-sub">Webhooks del panel
                <span className="ms-cost"> · a dónde le avisa Zernio</span></div>
              <div className="rs-perfiles">
                {nuestros.map((w) => (
                  <div key={w.id} className={`rs-perfil ${w.enUso ? 'on' : ''}`}>
                    <div className="rs-perfil-t">
                      <b style={{ fontWeight: 600, wordBreak: 'break-all' }}>{w.url}</b>
                      {w.enUso ? <span className="rs-usado">En uso</span> : <span className="rs-chip rec">De más</span>}
                    </div>
                    <div className="rs-perfil-c">
                      <span className="ms-cost">
                        {w.eventos} evento{w.eventos === 1 ? '' : 's'}
                        {w.activo ? '' : ' · desactivado'}
                        {w.ultimo ? ` · último aviso ${new Date(w.ultimo).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}` : ' · nunca disparó'}
                        {w.fallos ? ` · ${w.fallos} fallo${w.fallos === 1 ? '' : 's'}` : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {deMas.length > 0 && (
                <div className="rs-nota">
                  Hay {deMas.length} registro{deMas.length > 1 ? 's' : ''} de una URL vieja del panel, todavía activo{deMas.length > 1 ? 's' : ''}:
                  cada aviso de Zernio llega dos veces. El panel descarta el repetido, así que nada se procesa doble,
                  pero conviene quitarlo.{' '}
                  <button className="mini-btn" disabled={!!ocupado || !deMas.some((w) => w.borrable)} onClick={limpiar}>
                    {ocupado === 'limpiar' ? 'Borrando…' : 'Quitar los de más'}
                  </button>
                  {!deMas.some((w) => w.borrable) && <span className="ms-cost"> No se pueden borrar desde aquí: no llevan el nombre y la ruta del panel, así que podrían ser de otro proyecto.</span>}
                </div>
              )}
            </>
          )}
          {d.panelUrl && <div className="ms-cost">PANEL_URL: {d.panelUrl}</div>}
          {!d.panelUrl && <div className="rs-nota">Falta <b>PANEL_URL</b> en Railway (panel y worker): sin ella el webhook no se registra al arrancar.</div>}
          <div className="ms-submit">
            <span className="ms-cost">{msg}</span>
            <button className="mini-btn" disabled={!d.webhookListo || !!ocupado} onClick={webhook}>{ocupado === 'webhook' ? 'Registrando…' : d.webhookId ? '🔗 Volver a registrar y probar webhook' : '🔗 Registrar y probar webhook'}</button>
          </div>
        </>
      )}
    </div>
  );
}
