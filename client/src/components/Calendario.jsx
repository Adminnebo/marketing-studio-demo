import { useEffect, useMemo, useState } from 'react';
import { fetchCalGeneraciones, fetchCalPublicaciones, reprogramarPublicacion, cancelarPublicacion, descargar } from '../api';
import { REDES, ESTADOS_PUB, PUB_AGENDADA, PUB_HECHA } from '@shared/redes.mjs';
import { TIPOS } from '@shared/reglas.mjs';

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MODOS = [['ambos', 'Todo'], ['publicadas', 'Publicadas'], ['agendadas', 'Agendadas'], ['generadas', 'Creadas']];
const VISTAS = [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']];
// En la semana: con la foto de cada cosa, o solo el título (lista compacta).
const DETALLES = [['previa', '🖼️ Con previa'], ['titulo', '📝 Solo título']];
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
      redes: [...new Set((p.cuentas || []).map((c) => c.plataforma))], cuentas: p.cuentas || [], estado: p.estado,
      hecha: PUB_HECHA.has(p.estado), enlaces: (p.plataformas || []).filter((x) => x.platformPostUrl), p,
    });
  }
  return items.sort((a, b) => a.fecha - b.fecha);
}

// Vista previa cuadrada de un item, con su estado y (si es publicación) su hora y redes.
function Vista({ it, size = 'sm' }) {
  const et = it.tipo === 'pub' ? `${ESTADOS_PUB[it.estado] || it.estado} · ${hora(it.fecha)}` : 'Creada';
  return (
    <span className={`cal-v cal-v-${size} ${it.tipo === 'gen' ? 'gen' : `est-${it.estado}`}`} title={`${et}: ${it.titulo}`}>
      {it.thumb ? <img src={it.thumb} alt="" loading="lazy" /> : <span className="cal-v-ph">{it.video ? '🎬' : '🖼️'}</span>}
      {it.video && <i className="cal-v-play">▶</i>}
      {it.tipo === 'pub' && <i className="cal-v-h">{it.hecha ? '✓' : '🕒'} {hora(it.fecha)}</i>}
      {it.tipo === 'pub' && <i className="cal-v-redes">{it.redes.map((r) => REDES[r]?.icono || '•').join('')}</i>}
    </span>
  );
}

// Lista del dia: lo que ya salio, lo que esta agendado y lo que se creo, cada cosa por su lado.
function ListaDia({ dia, items, puedePublicar, onPublicar, onCambio }) {
  const hechas = items.filter((i) => i.tipo === 'pub' && i.hecha);
  const agendadas = items.filter((i) => i.tipo === 'pub' && !i.hecha);
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

  // En que cuentas salio, con arroba, y el enlace a la publicacion real cuando lo hay.
  const Cuentas = ({ it }) => (
    <span className="cal-cuentas">
      {(it.cuentas || []).map((c) => {
        const enlace = (it.enlaces || []).find((x) => x.platform === c.plataforma);
        const nombre = `${REDES[c.plataforma]?.icono || ''} ${c.usuario ? `@${c.usuario}` : REDES[c.plataforma]?.nombre || c.plataforma}`;
        return enlace
          ? <a key={c.id} className="cal-red enlace" href={enlace.platformPostUrl} target="_blank" rel="noreferrer" title="Ver la publicación en la red">{nombre} ↗</a>
          : <span key={c.id} className="cal-red">{nombre}</span>;
      })}
    </span>
  );

  const Tarjeta = ({ it, children, meta }) => {
    const r = (it.g?.resultados || it.p?.resultados || []).find((x) => x.url);
    const ver = r?.url || it.thumb;
    return (
      <div className="cal-item">
        <a className="cal-item-img" href={ver || undefined} target="_blank" rel="noreferrer" title="Ver en grande">
          {it.thumb ? <img src={it.thumb} alt="" loading="lazy" /> : <span>{it.video ? '🎬' : '🖼️'}</span>}
          {it.video && <i className="cal-item-play">▶</i>}
        </a>
        <div className="cal-item-cuerpo">
          <div className="cal-item-t">{it.titulo}</div>
          <div className="cal-item-m">{meta}</div>
          {children}
        </div>
      </div>
    );
  };

  return (
    <div className="cal-lista">
      {msg?.ok && <div className="ms-ok">{msg.ok}</div>}
      {msg?.error && <div className="ms-errors">{msg.error}</div>}
      {hechas.length > 0 && (
        <section>
          <div className="cal-sec">📣 Publicadas ({hechas.length})</div>
          {hechas.map((it) => (
            <Tarjeta key={it.id} it={it} meta={<>
              <span className={`pill est-${it.estado}`}>{ESTADOS_PUB[it.estado] || it.estado}</span>
              <span>{hora(it.fecha)}</span>
              <Cuentas it={it} />
            </>}>
              {it.p.texto && <div className="cal-item-texto">{it.p.texto}</div>}
              {it.p.error && <div className="ms-gen-err">{it.p.error}</div>}
            </Tarjeta>
          ))}
        </section>
      )}
      {agendadas.length > 0 && (
        <section>
          <div className="cal-sec">🗓️ Agendadas ({agendadas.length})</div>
          {agendadas.map((it) => (
            <Tarjeta key={it.id} it={it} meta={<>
              <span className={`pill est-${it.estado}`}>{ESTADOS_PUB[it.estado] || it.estado}</span>
              <span>{hora(it.fecha)}</span>
              <Cuentas it={it} />
            </>}>
              {it.p.texto && <div className="cal-item-texto">{it.p.texto}</div>}
              {it.p.error && <div className="ms-gen-err">{it.p.error}</div>}
              {it.estado === 'programada' && puedePublicar && (
                moviendo?.id === it.id ? (
                  <div className="cal-mover">
                    <label className="filter-field"><span>Nueva fecha y hora</span>
                      <input type="datetime-local" className="search" value={moviendo.valor} min={aLocalInput(new Date(Date.now() + 6 * 60e3))} onChange={(e) => setMoviendo({ id: it.id, valor: e.target.value })} />
                    </label>
                    <div className="cal-acc">
                      <button className="btn" disabled={ocupado} onClick={() => mover(it)}>{ocupado ? 'Guardando…' : 'Guardar fecha'}</button>
                      <button className="btn secondary" disabled={ocupado} onClick={() => setMoviendo(null)}>Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div className="cal-acc">
                    <button className="btn secondary cal-b" disabled={ocupado} onClick={() => setMoviendo({ id: it.id, valor: aLocalInput(it.fecha) })}>🗓️ Mover fecha</button>
                    <button className="btn secondary cal-b cal-b-danger" disabled={ocupado} onClick={() => cancelar(it)}>✕ Cancelar</button>
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
                {puedePublicar && onPublicar && <button className="btn cal-b" onClick={() => onPublicar(it.g, 0)}>📣 Publicar</button>}
                <button className="btn secondary cal-b" onClick={() => descargar(it.g.id, 0).catch((e) => setMsg({ error: e.message }))}>⬇ Descargar</button>
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
  const [detalle, setDetalle] = useState(() => { try { return localStorage.getItem('cal_detalle') || 'previa'; } catch { return 'previa'; } });
  const [ancla, setAncla] = useState(() => new Date());
  const [dia, setDia] = useState(null);
  const [datos, setDatos] = useState({ gens: [], pubs: [], cargando: true, error: null, aviso: null });
  const [recarga, setRecarga] = useState(0);
  const modoEf = puedeVerPublicaciones ? modo : 'generadas';
  useEffect(() => { try { localStorage.setItem('cal_modo', modo); localStorage.setItem('cal_vista', vista); localStorage.setItem('cal_detalle', detalle); } catch { /* sin storage */ } }, [modo, vista, detalle]);

  const [desde, hasta] = useMemo(() => rango(vista, ancla), [vista, ancla]);
  useEffect(() => {
    let vivo = true;
    setDatos((d) => ({ ...d, cargando: true, error: null }));
    const conGens = modoEf === 'ambos' || modoEf === 'generadas';
    const conPubs = modoEf !== 'generadas';
    Promise.all([
      conGens ? fetchCalGeneraciones(desde.toISOString(), hasta.toISOString()).then((r) => r.items) : [],
      conPubs ? fetchCalPublicaciones(desde.toISOString(), hasta.toISOString()) : { items: [] },
    ]).then(([gens, rp]) => vivo && setDatos({
      gens, pubs: rp.items, cargando: false, error: null,
      aviso: !conPubs ? null
        : !rp.filtrado ? 'No se pudieron leer las cuentas conectadas: se muestran todas las publicaciones.'
        : rp.ocultas > 0 ? `${rp.ocultas} publicación(es) de cuentas ya desconectadas no se muestran.` : null,
    }))
      .catch((e) => vivo && setDatos((d) => ({ ...d, cargando: false, error: e.message })));
    return () => { vivo = false; };
  }, [desde.getTime(), hasta.getTime(), modoEf, recarga, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const todos = useMemo(() => normalizar(datos.gens, datos.pubs), [datos]);
  const items = useMemo(() => todos.filter((it) => (
    modoEf === 'publicadas' ? it.tipo === 'pub' && it.hecha
      : modoEf === 'agendadas' ? it.tipo === 'pub' && !it.hecha
        : modoEf === 'generadas' ? it.tipo === 'gen'
          : true
  )), [todos, modoEf]);
  const porDia = useMemo(() => {
    const m = new Map();
    for (const it of items) { const k = clave(it.fecha); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m;
  }, [items]);
  const delDia = (d) => porDia.get(clave(d)) || [];
  const hoy = new Date();

  const mover = (n) => setAncla((a) => (vista === 'dia' ? sumarDias(a, n) : vista === 'semana' ? sumarDias(a, 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1)));
  const recargar = () => setRecarga((x) => x + 1);
  const resumen = (arr) => ({
    g: arr.filter((i) => i.tipo === 'gen').length,
    pub: arr.filter((i) => i.tipo === 'pub' && i.hecha).length,
    ag: arr.filter((i) => i.tipo === 'pub' && !i.hecha).length,
  });

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
          {vista === 'semana' && (
            <div className="seg seg-sm">{DETALLES.map(([k, l]) => <button key={k} className={detalle === k ? 'on' : ''} onClick={() => setDetalle(k)}>{l}</button>)}</div>
          )}
        </div>
      </div>
      <div className="cal-leyenda">
        {(modoEf === 'ambos' || modoEf === 'generadas') && <span><i className="cal-dot gen" /> Creada</span>}
        {(modoEf === 'ambos' || modoEf === 'agendadas') && <span><i className="cal-dot est-programada" /> Agendada</span>}
        {(modoEf === 'ambos' || modoEf === 'publicadas') && <><span><i className="cal-dot est-publicada" /> Publicada</span><span><i className="cal-dot est-fallida" /> No salió</span></>}
        {modoEf !== 'generadas' && <span className="cal-leyenda-n">Solo de las cuentas conectadas</span>}
      </div>
      {datos.error && <div className="banner-off">{datos.error}</div>}
      {datos.aviso && <div className="cal-aviso">{datos.aviso}</div>}

      {vista === 'mes' && (
        <div className="cal-mes">
          {DIAS.map((d) => <div key={d} className="cal-cab">{d}</div>)}
          {Array.from({ length: 42 }, (_, i) => sumarDias(desde, i)).map((d) => {
            const arr = delDia(d);
            const fuera = d.getMonth() !== ancla.getMonth();
            return (
              <button key={clave(d)} className={`cal-celda ${fuera ? 'fuera' : ''} ${mismoDia(d, hoy) ? 'hoy' : ''} ${arr.length ? 'con' : ''}`} onClick={() => setDia(d)}>
                <span className="cal-celda-top">
                  <span className="cal-num">{d.getDate()}</span>
                  {arr.length > 0 && (() => { const r = resumen(arr); return (
                    <span className="cal-cuenta">
                      {r.pub ? <i title={`${r.pub} publicada(s)`}>📣{r.pub}</i> : null}
                      {r.ag ? <i title={`${r.ag} agendada(s)`}>🕒{r.ag}</i> : null}
                      {r.g ? <i title={`${r.g} creación(es)`}>🎨{r.g}</i> : null}
                    </span>
                  ); })()}
                </span>
                <span className="cal-vistas">
                  {arr.slice(0, 3).map((it) => <Vista key={it.id} it={it} />)}
                  {arr.length > 3 && <span className="cal-v cal-v-sm cal-mas">+{arr.length - 3}</span>}
                </span>
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
                  {(r.g || r.pub || r.ag) ? <span className="cal-col-res">{r.pub ? `📣${r.pub}` : ''} {r.ag ? `🕒${r.ag}` : ''} {r.g ? `🎨${r.g}` : ''}</span> : null}
                </button>
                <div className={`cal-col-items ${detalle === 'titulo' ? 'solo-t' : ''}`}>
                  {arr.map((it) => {
                    const sub = it.tipo === 'pub'
                      ? `${it.hecha ? 'Publicada' : 'Agendada'} ${hora(it.fecha)} · ${(it.cuentas || []).map((c) => (c.usuario ? `@${c.usuario}` : REDES[c.plataforma]?.nombre || c.plataforma)).join(', ')}`
                      : TIPOS[it.g.preset_tipo] || 'Creada';
                    return detalle === 'titulo' ? (
                      <button key={it.id} className="cal-col-fila" onClick={() => setDia(d)} title={`${sub}: ${it.titulo}`}>
                        <i className={`cal-dot ${it.tipo === 'gen' ? 'gen' : `est-${it.estado}`}`} />
                        <span className="cal-col-t">{it.titulo}</span>
                        {it.tipo === 'pub' && <span className="cal-col-h">{hora(it.fecha)}</span>}
                      </button>
                    ) : (
                      <button key={it.id} className="cal-col-item" onClick={() => setDia(d)} title={it.titulo}>
                        <Vista it={it} size="md" />
                        <span className="cal-col-t">{it.titulo}</span>
                        <span className="cal-col-sub">{sub}</span>
                      </button>
                    );
                  })}
                  {!arr.length && <span className="cal-vacio">Sin nada</span>}
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
                  <span className="ms-cost">{(() => { const r = resumen(delDia(dia)); return [r.pub && `${r.pub} publicada(s)`, r.ag && `${r.ag} agendada(s)`, r.g && `${r.g} creación(es)`].filter(Boolean).join(' · ') || 'Sin actividad'; })()}</span>
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
