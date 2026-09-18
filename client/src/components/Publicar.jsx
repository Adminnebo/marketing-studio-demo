import { useEffect, useMemo, useState } from 'react';
import { publicar, fetchInfoTiktok } from '../api';
import { REDES, tipoMedio, limiteDe, validarPublicacion } from '@shared/redes.mjs';
import { Cuenta } from './Redes';

const ZONA = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Santo_Domingo';
const dosDig = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${dosDig(d.getMonth() + 1)}-${dosDig(d.getDate())}T${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`;

// Modal para publicar (o programar) un resultado en las cuentas conectadas.
export default function Publicar({ generacion, indice = 0, cuentas, onCerrar, onPublicada }) {
  const ok = (generacion.resultados || []).filter((r) => r.url);
  const medio = ok[Math.min(indice, ok.length - 1)];
  const tipo = tipoMedio(medio?.url);

  const [texto, setTexto] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [modo, setModo] = useState('ahora');
  const [fecha, setFecha] = useState(() => localInput(new Date(Date.now() + 60 * 60e3)));
  const [ig, setIg] = useState({ formato: 'feed' });
  const [yt, setYt] = useState({ titulo: (generacion.preset_nombre || '').slice(0, 100) });
  const [tk, setTk] = useState({ privacidad: '', comentarios: false, duo: false, stitch: false, consentimiento: false });
  const [tkInfo, setTkInfo] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [hecha, setHecha] = useState(null);

  const elegidas = (cuentas || []).filter((c) => sel.has(c.id));
  const cuentaTk = elegidas.find((c) => c.plataforma === 'tiktok');

  // Opciones de TikTok salen del creador (privacidades permitidas, toggles).
  useEffect(() => {
    if (!cuentaTk) { setTkInfo(null); return; }
    let vivo = true;
    fetchInfoTiktok(cuentaTk.id, tipo).then((d) => {
      if (!vivo) return;
      setTkInfo(d);
      setTk((t) => ({ ...t, privacidad: '' })); // TikTok exige que el usuario lo elija, sin valor por defecto
    }).catch((e) => vivo && setTkInfo({ error: e.message }));
    return () => { vivo = false; };
  }, [cuentaTk?.id, tipo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && !enviando && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [enviando, onCerrar]);

  // Lo desactivado por el creador en la app de TikTok nunca se manda como permitido.
  const tkOn = (api) => tkInfo?.interacciones?.[api]?.enabled !== false;
  const tkEfectivo = { ...tk, comentarios: tk.comentarios && tkOn('allow_comment'), duo: tk.duo && tkOn('allow_duet'), stitch: tk.stitch && tkOn('allow_stitch') };
  const opciones = { instagram: ig, youtube: yt, tiktok: tkEfectivo };
  const fechaIso = modo === 'programar' && fecha ? new Date(fecha).toISOString() : null;
  const errores = useMemo(
    () => validarPublicacion({ texto, tipo, cuentas: elegidas, opciones, modo, fecha: fechaIso }),
    [texto, tipo, elegidas, ig, yt, tk, tkInfo, modo, fechaIso] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const limite = elegidas.length ? Math.min(...elegidas.map((c) => limiteDe(c.plataforma, tipo))) : null;

  const alternar = (c) => setSel((s) => {
    const n = new Set(s);
    if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
    return n;
  });

  const enviar = async () => {
    if (errores.length || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const p = await publicar({
        generacion_id: generacion.id, indice, texto, cuentas: [...sel], opciones, modo,
        fechaLocal: modo === 'programar' ? fecha : null, fechaIso, zona: ZONA,
      });
      setHecha(p);
      onPublicada?.(p);
    } catch (e) {
      setError(e.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="ms-modal" onMouseDown={(e) => e.target === e.currentTarget && !enviando && onCerrar()}>
      <div className="ms-modal__box" role="dialog" aria-label="Publicar en redes">
        <div className="ms-modal__media">
          {tipo === 'video' ? <video src={medio?.url} controls playsInline /> : <img src={medio?.url} alt="" />}
        </div>
        <div className="ms-modal__body">
          <div className="ms-modal__head">
            <div>
              <h2>Publicar en redes</h2>
              <span className="pill">{tipo === 'video' ? 'Video' : 'Imagen'} · {generacion.preset_nombre}</span>
            </div>
            <button type="button" className="ms-x" onClick={onCerrar} disabled={enviando} aria-label="Cerrar">✕</button>
          </div>

          {hecha ? (
            <div className="ms-ok">
              <span>✅ {hecha.estado === 'programada' ? 'Programada.' : 'Enviada a las redes.'} Sigue su estado en <strong>Redes</strong>.</span>
              <button className="btn" onClick={() => onCerrar('redes')}>Ver en Redes</button>
            </div>
          ) : !cuentas?.length ? (
            <div className="banner-off">No hay cuentas conectadas. Conéctalas en la pestaña <strong>Redes</strong>.</div>
          ) : (
            <>
              <div>
                <span className="ms-label">Cuentas</span>
                <div className="rs-elegir">
                  {cuentas.map((c) => {
                    const r = REDES[c.plataforma];
                    const incompatible = !r || (tipo === 'video' ? !r.video : !r.imagen) || c.reconectar;
                    return (
                      <label key={c.id} className={`rs-check ${sel.has(c.id) ? 'on' : ''} ${incompatible ? 'off' : ''}`}
                        title={c.reconectar ? 'Hay que reconectar esta cuenta' : incompatible ? `${r?.nombre} no acepta ${tipo === 'video' ? 'videos' : 'imágenes'}` : ''}>
                        <input type="checkbox" checked={sel.has(c.id)} disabled={incompatible || enviando} onChange={() => alternar(c)} />
                        <Cuenta c={c} />
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <span className="ms-label">Texto de la publicación
                  {limite != null && <span style={{ float: 'right', textTransform: 'none', color: texto.length > limite ? 'var(--critical)' : undefined }}>{texto.length} / {limite.toLocaleString('es')}</span>}
                </span>
                <textarea className="ms-textarea" value={texto} onChange={(e) => setTexto(e.target.value)} disabled={enviando}
                  placeholder="Escribe el copy, hashtags, llamada a la acción…" />
              </div>

              {elegidas.some((c) => c.plataforma === 'instagram') && (
                <div>
                  <span className="ms-label">Instagram</span>
                  <div className="ms-chips">
                    {[['feed', tipo === 'video' ? 'Reel' : 'Feed'], ['story', 'Historia']].map(([k, l]) => (
                      <button key={k} type="button" className={`mini-btn ${ig.formato === k ? 'active' : ''}`} onClick={() => setIg({ formato: k })}>{l}</button>
                    ))}
                  </div>
                </div>
              )}

              {elegidas.some((c) => c.plataforma === 'youtube') && (
                <div>
                  <span className="ms-label">Título en YouTube<span className="req">*</span></span>
                  <input className="ms-input" maxLength={100} value={yt.titulo} onChange={(e) => setYt({ titulo: e.target.value })} />
                </div>
              )}

              {cuentaTk && (
                <div className="rs-tiktok">
                  <span className="ms-label">TikTok</span>
                  {!tkInfo ? <div className="spinner sm" /> : tkInfo.error ? <div className="ms-gen-err">{tkInfo.error}</div> : (
                    <>
                      {!tkInfo.puedePublicar && <div className="ms-gen-err">Esta cuenta llegó a su límite de publicaciones por hoy.</div>}
                      <select className="ms-input" value={tk.privacidad} onChange={(e) => setTk({ ...tk, privacidad: e.target.value })}>
                        <option value="">¿Quién puede verlo?</option>
                        {tkInfo.privacidades.map((p) => <option key={p.valor} value={p.valor}>{p.etiqueta}</option>)}
                      </select>
                      <div className="rs-toggles">
                        {[['comentarios', 'allow_comment', 'Permitir comentarios'], ...(tipo === 'video' ? [['duo', 'allow_duet', 'Permitir dúos'], ['stitch', 'allow_stitch', 'Permitir stitch']] : [])].map(([k, api, l]) => {
                          const desactivado = tkInfo.interacciones?.[api]?.enabled === false;
                          return (
                            <label key={k} className="user-admin-check" title={desactivado ? 'Desactivado en la app de TikTok' : ''}>
                              <input type="checkbox" checked={!desactivado && tk[k]} disabled={desactivado} onChange={(e) => setTk({ ...tk, [k]: e.target.checked })} /> {l}
                            </label>
                          );
                        })}
                      </div>
                      <label className="rs-consent">
                        <input type="checkbox" checked={tk.consentimiento} onChange={(e) => setTk({ ...tk, consentimiento: e.target.checked })} />
                        <span>Revisé el contenido y acepto la <a className="a-link" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Confirmación de uso de música</a> de TikTok.</span>
                      </label>
                    </>
                  )}
                </div>
              )}

              <div>
                <span className="ms-label">Cuándo</span>
                <div className="ms-chips" style={{ alignItems: 'center' }}>
                  <button type="button" className={`mini-btn ${modo === 'ahora' ? 'active' : ''}`} onClick={() => setModo('ahora')}>Publicar ahora</button>
                  <button type="button" className={`mini-btn ${modo === 'programar' ? 'active' : ''}`} onClick={() => setModo('programar')}>Programar</button>
                  {modo === 'programar' && (
                    <input type="datetime-local" className="dr-date" value={fecha} min={localInput(new Date())} onChange={(e) => setFecha(e.target.value)} />
                  )}
                </div>
                {modo === 'programar' && <div className="ms-cost" style={{ marginTop: 6 }}>Hora de {ZONA.replace('_', ' ')}</div>}
              </div>

              {error && <div className="ms-errors">{error}</div>}
              <div className="ms-submit">
                <span className="ms-cost">{errores[0] || (elegidas.length ? `${elegidas.length} cuenta${elegidas.length > 1 ? 's' : ''}` : '')}</span>
                <button className="btn" onClick={enviar} disabled={errores.length > 0 || enviando}>
                  {enviando ? 'Enviando…' : modo === 'programar' ? '🗓️ Programar' : '📣 Publicar'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
