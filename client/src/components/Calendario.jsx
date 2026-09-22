import { useEffect, useMemo, useState } from 'react';
import { fetchCalGeneraciones, fetchCalPublicaciones, reprogramarPublicacion, cancelarPublicacion, descargar } from '../api';
import { REDES, ESTADOS_PUB } from '@shared/redes.mjs';
import { TIPOS } from '@shared/reglas.mjs';

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MODOS = [['ambos', 'Ambos'], ['generadas', 'Creadas'], ['agendadas', 'Agendadas']];
const VISTAS = [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']];
const ES_VIDEO = /\.(mp4|mov|webm)($|\?)/i;

// ── Fechas (en la hora local del navegador) ──
const inicioDia = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sumarDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const lunes = (d) => sumarDias(inicioDia(d), -((d.getDay() + 6) % 7));
const clave = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mismoDia = (a, b) => clave(a) === clave(b);
const hora = (d) => d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const fechaLarga = (d) => d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
const aLocalInput = (d) => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60e3); return x.toISOString().slice(0, 16); };

function rango(vista, ancla) {
  if (vista === 'dia') { const a = inicioDia(ancla); return [a, sumarDias(a, 1)]; }
  if (vista === 'semana') { const a = lunes(ancla); return [a, sumarDias(a, 7)]; }
  const a = lunes(new Date(ancla.getFullYear(), ancla.getMonth(), 1));
  return [a, sumarDias(a, 42)];
}

function titulo(vista, ancla) {
  if (vista === 'dia') return fechaLarga(ancla);
  if (vista === 'semana') {
    const a = lunes(ancla); const b = sumarDias(a, 6);
    return `${a.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return ancla.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
}

// Miniatura de una creacion (sin cargar videos en el calendario).
function miniatura(g) {
  const r = (g?.resultados || []).find((x) => x.url);
  if (r?.miniatura) return r.miniatura;
  if (r && !ES_VIDEO.test(r.url)) return r.url;
  const pc = g?.portada;
  if (pc?.poster_url) return pc.poster_url;
  if (pc?.url && !ES_VIDEO.test(pc.url)) return pc.url;
  return g?.entrada?.producto?.url || null;
}
const esVideoGen = (g) => ES_VIDEO.test((g?.resultados || []).find((x) => x.url)?.url || '') || g?.preset_tipo === 'libre_video';

function normalizar(gens, pubs) {
  const items = [];
  for (const g of gens) {
    items.push({ tipo: 'gen', id: `g${g.id}`, fecha: new Date(g.fecha), titulo: g.preset_nombre || 'Creación', thumb: miniatura(g), video: esVideoGen(g), g });
  }
  for (const p of pubs) {
    const g = { id: p.generacion_id, preset_nombre: p.preset_nombre, preset_tipo: p.preset_tipo, portada: p.portada, resultados: p.resultados };
    items.push({
      tipo: 'pub', id: `p${p.id}`, fecha: new Date(p.fecha), titulo: p.preset_nombre || 'Publicación', thumb: miniatura(g), video: p.medio?.tipo === 'video',
      redes: [...new Set((p.cuentas || []).map((c) => c.plataforma))], estado: p.estado, p,
    });
  }
  return items.sort((a, b) => a.fecha - b.fecha);
}

function Chip({ it }) {
  return it.tipo === 'gen'
    ? <span className="cal-chip gen" title={`Creada: ${it.titulo}`}><span className="cal-chip-ic">{it.video ? '🎬' : '🖼️'}</span>{it.titulo}</span>
    : (
      <span className={`cal-chip pub est-${it.estado}`} title={`${ESTADOS_PUB[it.estado] || it.estado}: ${it.titulo}`}>
        <span className="cal-chip-h">{hora(it.fecha)}</span>{it.redes.map((r) => REDES[r]?.icono || '•').join('')} {it.titulo}
      </span>
    );
}

// Lista del dia: publicaciones (programadas o hechas) y creaciones, con sus acciones.
function ListaDia({ dia, items, puedePublicar, onPublicar, onCambio }) {
  const pubs = items.filter((i) => i.tipo === 'pub');
  const gens = items.filter((i) => i.tipo === 'gen');
  const [moviendo, setMoviendo] = useState(null); // { id, valor }
  const [msg, setMsg] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const mover = async (it) => {
    const fecha = new Date(moviendo.valor);
    if (Number.isNaN(+fecha)) return setMsg({ error: 'Elige una fecha y hora.' });
    setOcupado(true); setMsg(null);
    try {
      await reprogramarPublicacion(it.p.id, { fechaLocal: moviendo.valor, fechaIso: fecha.toISOString(), zona: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setMsg({ ok: `Movida al ${fechaLarga(fecha)}, ${hora(fecha)}.` }); setMoviendo(null); onCambio();
    } catch (e) { setMsg({ error: e.message }); } finally { setOcupado(false); }
  };
  const cancelar = async (it) => {
    if (!window.confirm(`¿Cancelar la publicación de "${it.titulo}" programada para el ${fechaLarga(it.fecha)} a las ${hora(it.fecha)}? No saldrá en ninguna red.`)) return;
    setOcupado(true); setMsg(null);
    try { await cancelarPublicacion(it.p.id); setMsg({ ok: 'Publicación cancelada.' }); onCambio(); } catch (e) { setMsg({ error: e.message }); } finally { setOcupado(false); }
  };

  const Tarjeta = ({ it, children, meta }) => (
    <div className="cal-item">
      <div className="cal-item-img">{it.thumb ? <img src={it.thumb} alt="" loading="lazy" /> : <span>{it.video ? '🎬' : '🖼️'}</span>}{it.video && it.thumb && <i className="cal-item-play">▶</i>}</div>
      <div className="cal-item-cuerpo">
        <div className="cal-item-t">{it.titulo}</div>
        <div className="cal-item-m">{meta}</div>
        {children}
      </div>
    </div>
  );

  return (
    <div className="cal-lista">
      {msg?.ok && <div className="ms-ok">{msg.ok}</div>}
      {msg?.error && <div className="ms-errors">{msg.error}</div>}
      {pubs.length > 0 && (
        <section>
          <div className="cal-sec">📅 Publicaciones ({pubs.length})</div>
          {pubs.map((it) => (
            <Tarjeta key={it.id} it={it} meta={<>
              <span className={`pill est-${it.estado}`}>{ESTADOS_PUB[it.estado] || it.estado}</span>
              <span>{hora(it.fecha)}</span>
              <span>{it.redes.map((r) => `${REDES[r]?.icono || ''} ${REDES[r]?.nombre || r}`).join(' · ')}</span>
            </>}>
              {it.p.texto && <div className="cal-item-texto">{it.p.texto}</div>}
              {it.p.error && <div className="ms-gen-err">{it.p.error}</div>}
              {it.estado === 'programada' && puedePublicar && (
                moviendo?.id === it.id ? (
                  <div className="cal-mover">
                    <input type="datetime-local" className="search" value={moviendo.valor} min={aLocalInput(new Date(Date.now() + 6 * 60e3))} onChange={(e) => setMoviendo({ id: it.id, valor: e.target.value })} />
                    <button className="btn" disabled={ocupado} onClick={() => mover(it)}>Guardar</button>
                    <button className="btn secondary" disabled={ocupado} onClick={() => setMoviendo(null)}>Cancelar</button>
                  </div>
                ) : (
                  <div className="cal-acc">
                    <button className="mini-btn" disabled={ocupado} onClick={() => setMoviendo({ id: it.id, valor: aLocalInput(it.fecha) })}>🗓️ Mover fecha</button>
                    <button className="mini-btn danger" disabled={ocupado} onClick={() => cancelar(it)}>✕ Cancelar publicación</button>
                  </div>
                )
              )}
            </Tarjeta>
          ))}
        </section>
      )}
      {gens.length > 0 && (
        <section>
          <div className="cal-sec">🎨 Creadas este día ({gens.length})</div>
          {gens.map((it) => (
            <Tarjeta key={it.id} it={it} meta={<>
              <span>{TIPOS[it.g.preset_tipo] || it.g.preset_tipo}</span><span>{hora(it.fecha)}</span><span>{it.g.creado_por}</span>
            </>}>
              <div className="cal-acc">
                {puedePublicar && onPublicar && <button className="mini-btn" onClick={() => onPublicar(it.g, 0)}>📣 Publicar</button>}
                <button className="mini-btn" onClick={() => descargar(it.g.id, 0).catch((e) => setMsg({ error: e.message }))}>⬇ Descargar</button>
              </div>
            </Tarjeta>
          ))}
        </section>
      )}
      {!items.length && <div className="empty-state" style={{ padding: 28 }}>Nada este día{dia ? ` (${fechaLarga(dia)})` : ''}.</div>}
    </div>
  );
}

// Pestaña Calendario: lo creado y lo agendado por dia, semana o mes.
export default function Calendario({ puedeVerPublicaciones, puedePublicar, onPublicar, version = 0 }) {
  const [modo, setModo] = useState(() => { try { return localStorage.getItem('cal_modo') || 'ambos'; } catch { return 'ambos'; } });
  const [vista, setVista] = useState(() => { try { return localStorage.getItem('cal_vista') || 'mes'; } catch { return 'mes'; } });
  const [ancla, setAncla] = useState(() => new Date());
  const [dia, setDia] = useState(null);
  const [datos, setDatos] = useState({ gens: [], pubs: [], cargando: true, error: null });
  const [recarga, setRecarga] = useState(0);
  const modoEf = puedeVerPublicaciones ? modo : 'generadas';
  useEffect(() => { try { localStorage.setItem('cal_modo', modo); localStorage.setItem('cal_vista', vista); } catch { /* sin storage */ } }, [modo, vista]);

  const [desde, hasta] = useMemo(() => rango(vista, ancla), [vista, ancla]);
  useEffect(() => {
    let vivo = true;
    setDatos((d) => ({ ...d, cargando: true, error: null }));
    Promise.all([
      modoEf !== 'agendadas' ? fetchCalGeneraciones(desde.toISOString(), hasta.toISOString()).then((r) => r.items) : [],
      modoEf !== 'generadas' ? fetchCalPublicaciones(desde.toISOString(), hasta.toISOString()).then((r) => r.items) : [],
    ]).then(([gens, pubs]) => vivo && setDatos({ gens, pubs, cargando: false, error: null }))
      .catch((e) => vivo && setDatos((d) => ({ ...d, cargando: false, error: e.message })));
    return () => { vivo = false; };
  }, [desde.getTime(), hasta.getTime(), modoEf, recarga, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => normalizar(datos.gens, datos.pubs), [datos]);
  const porDia = useMemo(() => {
    const m = new Map();
    for (const it of items) { const k = clave(it.fecha); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m;
  }, [items]);
  const delDia = (d) => porDia.get(clave(d)) || [];
  const hoy = new Date();

  const mover = (n) => setAncla((a) => (vista === 'dia' ? sumarDias(a, n) : vista === 'semana' ? sumarDias(a, 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1)));
  const recargar = () => setRecarga((x) => x + 1);
  const resumen = (arr) => ({ g: arr.filter((i) => i.tipo === 'gen').length, p: arr.filter((i) => i.tipo === 'pub').length });

  return (
    <div className="cal">
      <div className="cal-barra">
        <div className="cal-nav">
          <button className="mini-btn" onClick={() => mover(-1)} aria-label="Anterior">‹</button>
          <button className="mini-btn" onClick={() => setAncla(new Date())}>Hoy</button>
          <button className="mini-btn" onClick={() => mover(1)} aria-label="Siguiente">›</button>
          <h2 className="cal-titulo">{titulo(vista, ancla)}</h2>
          {datos.cargando && <span className="spinner cal-spin" />}
        </div>
        <div className="cal-ctrl">
          {puedeVerPublicaciones && (
            <div className="seg seg-sm">{MODOS.map(([k, l]) => <button key={k} className={modo === k ? 'on' : ''} onClick={() => setModo(k)}>{l}</button>)}</div>
          )}
          <div className="seg seg-sm">{VISTAS.map(([k, l]) => <button key={k} className={vista === k ? 'on' : ''} onClick={() => setVista(k)}>{l}</button>)}</div>
        </div>
      </div>
      <div className="cal-leyenda">
        {modoEf !== 'agendadas' && <span><i className="cal-dot gen" /> Creada</span>}
        {modoEf !== 'generadas' && <><span><i className="cal-dot est-programada" /> Programada</span><span><i className="cal-dot est-publicada" /> Publicada</span><span><i className="cal-dot est-fallida" /> Falló</span></>}
      </div>
      {datos.error && <div className="banner-off">{datos.error}</div>}

      {vista === 'mes' && (
        <div className="cal-mes">
          {DIAS.map((d) => <div key={d} className="cal-cab">{d}</div>)}
          {Array.from({ length: 42 }, (_, i) => sumarDias(desde, i)).map((d) => {
            const arr = delDia(d);
            const fuera = d.getMonth() !== ancla.getMonth();
            return (
              <button key={clave(d)} className={`cal-celda ${fuera ? 'fuera' : ''} ${mismoDia(d, hoy) ? 'hoy' : ''} ${arr.length ? 'con' : ''}`} onClick={() => setDia(d)}>
                <span className="cal-num">{d.getDate()}</span>
                <span className="cal-chips">{arr.slice(0, 3).map((it) => <Chip key={it.id} it={it} />)}</span>
                {arr.length > 3 && <span className="cal-mas">+{arr.length - 3} más</span>}
              </button>
            );
          })}
        </div>
      )}

      {vista === 'semana' && (
        <div className="cal-semana">
          {Array.from({ length: 7 }, (_, i) => sumarDias(desde, i)).map((d, i) => {
            const arr = delDia(d); const r = resumen(arr);
            return (
              <div key={clave(d)} className={`cal-col ${mismoDia(d, hoy) ? 'hoy' : ''}`}>
                <button className="cal-col-cab" onClick={() => setDia(d)}>
                  <span>{DIAS[i]}</span><b>{d.getDate()}</b>
                  {(r.g || r.p) ? <span className="cal-col-res">{r.p ? `📅${r.p}` : ''} {r.g ? `🎨${r.g}` : ''}</span> : null}
                </button>
                <div className="cal-col-items">
                  {arr.map((it) => (
                    <button key={it.id} className="cal-col-item" onClick={() => setDia(d)}>
                      {it.thumb ? <img src={it.thumb} alt="" loading="lazy" /> : <span className="cal-col-ph">{it.video ? '🎬' : '🖼️'}</span>}
                      <Chip it={it} />
                    </button>
                  ))}
                  {!arr.length && <span className="cal-vacio">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {vista === 'dia' && (
        <div className="card"><ListaDia dia={ancla} items={delDia(ancla)} puedePublicar={puedePublicar} onPublicar={onPublicar} onCambio={recargar} /></div>
      )}

      {dia && vista !== 'dia' && (
        <div className="ms-modal" onMouseDown={(e) => e.target === e.currentTarget && setDia(null)}>
          <div className="ms-modal__box cal-panel" role="dialog" aria-label={fechaLarga(dia)}>
            <div className="ms-modal__body">
              <div className="ms-modal__head">
                <div>
                  <h2 style={{ textTransform: 'capitalize' }}>{fechaLarga(dia)}</h2>
                  <span className="ms-cost">{(() => { const r = resumen(delDia(dia)); return [r.p && `${r.p} publicación(es)`, r.g && `${r.g} creación(es)`].filter(Boolean).join(' · ') || 'Sin actividad'; })()}</span>
                </div>
                <div className="rc-cerrar">
                  <button className="mini-btn" onClick={() => setDia(sumarDias(dia, -1))} aria-label="Día anterior">‹</button>
                  <button className="mini-btn" onClick={() => setDia(sumarDias(dia, 1))} aria-label="Día siguiente">›</button>
                  <button className="ms-x" onClick={() => setDia(null)} aria-label="Cerrar">✕</button>
                </div>
              </div>
              <ListaDia dia={dia} items={delDia(dia)} puedePublicar={puedePublicar}
                onPublicar={onPublicar && ((g, i) => { setDia(null); onPublicar(g, i); })} onCambio={recargar} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
