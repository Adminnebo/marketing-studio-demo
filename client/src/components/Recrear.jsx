import { useEffect, useMemo, useRef, useState } from 'react';
import { crearGeneracion, subirImagen } from '../api';
import { TIPOS, TIPOS_VIDEO, entradasDe, faltantes, formatoDe, creditosDe } from '@shared/reglas.mjs';
import Portada from './Portada';
import Avatares from './Avatares';
import { precioDe, usd, cred } from '../precio';

const fmtCred = (n) => (n == null ? null : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 }));

// Modal para recrear una plantilla con el producto (y avatar) del usuario.
export default function Recrear({ preset, categoria, categorias, costos, precios, saldo, rol, inicial, onCerrar, onEnviada, onRecargar }) {
  const { formatSlug, formato } = useMemo(() => formatoDe(preset, categorias, categoria), [preset, categorias, categoria]);
  const req = useMemo(() => entradasDe(preset, { formatSlug, formato }), [preset, formatSlug, formato]);

  const [producto, setProducto] = useState(inicial?.producto || null); // { media_id, url, nombre, local }
  const [subida, setSubida] = useState(null); // { progreso, nombre, error }
  const [avatar, setAvatar] = useState(inicial?.avatar || null);
  const [eligiendoAvatar, setEligiendoAvatar] = useState(false);
  const [prompt, setPrompt] = useState(inicial?.prompt || '');
  const [url, setUrl] = useState(inicial?.url || '');
  const [duracion, setDuracion] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState(null);
  const [enviada, setEnviada] = useState(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && !enviando && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [enviando, onCerrar]);

  const creditos = creditosDe(preset.type, costos, duracion);
  const pr = precioDe(precios, preset.type, creditos);
  const sinSaldo = rol !== 'super_admin' && creditos != null && saldo != null && saldo < creditos;
  const pendientes = [...faltantes(req, { producto, avatar, prompt, url }), ...(sinSaldo ? [`Saldo insuficiente: tienes ${cred(saldo)} créditos y esta generación usa ${cred(creditos)}.`] : [])];
  const ocupado = enviando || subida?.progreso != null;

  const elegirArchivo = async (f) => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setSubida({ error: 'Usa una imagen PNG, JPG o WEBP.' }); return; }
    if (f.size > 20 * 1024 * 1024) { setSubida({ error: 'La imagen pesa más de 20 MB.' }); return; }
    const local = URL.createObjectURL(f);
    setProducto(null);
    setSubida({ progreso: 0, nombre: f.name });
    try {
      const r = await subirImagen(f, (p) => setSubida({ progreso: p, nombre: f.name }));
      setProducto({ ...r, nombre: f.name, local });
      setSubida(null);
    } catch (e) {
      setSubida({ error: e.message });
    }
  };

  const enviar = async (e) => {
    e.preventDefault();
    if (pendientes.length || ocupado || enviada) return;
    setEnviando(true);
    setError(null);
    try {
      const g = await crearGeneracion({
        preset, categoria,
        producto: producto && { media_id: producto.media_id, url: producto.url, nombre: producto.nombre },
        avatar, prompt, url, duracion,
      });
      setEnviada(g);
      onEnviada?.(g);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="ms-modal" onMouseDown={(e) => e.target === e.currentTarget && !ocupado && onCerrar()}>
      <div className="ms-modal__box" role="dialog" aria-label={preset.name}>
        <div className="ms-modal__media">
          <Portada cover={preset.cover_image} alt={preset.name} autoPlay onDuracion={setDuracion} />
        </div>
        <div className="ms-modal__body">
          {eligiendoAvatar ? (
            <Avatares seleccionado={avatar} onVolver={() => setEligiendoAvatar(false)}
              onElegir={(a) => { setAvatar(a); setEligiendoAvatar(false); }} />
          ) : (
            <form onSubmit={enviar} style={{ display: 'contents' }}>
              <div className="ms-modal__head">
                <div>
                  <h2>{preset.name}</h2>
                  <span className="pill">{TIPOS[preset.type] || preset.type}{formato?.name ? ` · ${formato.name}` : ''}</span>
                </div>
                <button type="button" className="ms-x" onClick={onCerrar} disabled={ocupado} aria-label="Cerrar">✕</button>
              </div>

              {(req.producto || req.avatar) && (
                <div className="ms-tiles">
                  {req.producto && (
                    <div>
                      <span className="ms-label">Imagen del producto{req.productoObligatorio && <span className="req">*</span>}</span>
                      <button type="button"
                        className={`ms-tile ${producto ? 'filled' : ''} ${drag ? 'drag' : ''}`}
                        disabled={ocupado || !!enviada}
                        onClick={() => inputRef.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => { e.preventDefault(); setDrag(false); elegirArchivo(e.dataTransfer.files?.[0]); }}>
                        {producto ? (
                          <>
                            <img src={producto.local || producto.url} alt={producto.nombre} />
                            <span className="ms-tile-cap"><span>{producto.nombre}</span>{!enviada && <span>Cambiar</span>}</span>
                          </>
                        ) : subida?.progreso != null ? (
                          <>
                            <span className="ms-tile-txt">Subiendo…</span>
                            <div className="ms-progress"><div style={{ width: `${Math.round(subida.progreso * 100)}%` }} /></div>
                            <span className="ms-tile-sub">{subida.nombre}</span>
                          </>
                        ) : (
                          <>
                            <span className="ms-tile-ic">📦</span>
                            <span className="ms-tile-txt">Subir producto</span>
                            <span className="ms-tile-sub">Arrastra o haz clic · PNG, JPG, WEBP</span>
                          </>
                        )}
                      </button>
                      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
                        onChange={(e) => { elegirArchivo(e.target.files?.[0]); e.target.value = ''; }} />
                      {subida?.error && <div className="ms-gen-err" style={{ marginTop: 6 }}>{subida.error}</div>}
                    </div>
                  )}
                  {req.avatar && (
                    <div>
                      <span className="ms-label">Avatar{req.avatarObligatorio ? <span className="req">*</span> : <span style={{ textTransform: 'none', fontWeight: 500 }}> (opcional)</span>}</span>
                      <button type="button" className={`ms-tile ${avatar ? 'filled' : ''}`} disabled={ocupado || !!enviada} onClick={() => setEligiendoAvatar(true)}>
                        {avatar ? (
                          <>
                            <img src={avatar.preview_url} alt={avatar.name} />
                            <span className="ms-tile-cap"><span>{avatar.name}</span>
                              {!enviada && (
                                <span role="button" tabIndex={0} style={{ fontWeight: 700 }}
                                  onClick={(e) => { e.stopPropagation(); setAvatar(null); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); setAvatar(null); } }}>
                                  Quitar
                                </span>
                              )}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="ms-tile-ic">🧑</span>
                            <span className="ms-tile-txt">Elegir avatar</span>
                            <span className="ms-tile-sub">{req.avatarObligatorio ? 'Obligatorio' : 'Si no eliges, se usa uno automático'}</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {req.aceptaUrl && (
                <div>
                  <span className="ms-label">URL de la marca o producto{req.urlObligatoria && <span className="req">*</span>}</span>
                  <input className="ms-input" type="url" placeholder="https://ejemplo.com" value={url} disabled={!!enviada} onChange={(e) => setUrl(e.target.value)} />
                </div>
              )}

              <div>
                <span className="ms-label">Describe tu edición{req.promptObligatorio ? <span className="req">*</span> : <span style={{ textTransform: 'none', fontWeight: 500 }}> (opcional)</span>}</span>
                <textarea className="ms-textarea" maxLength={5000} value={prompt} disabled={!!enviada}
                  placeholder="Ej.: fondo azul JH, texto “Oferta de temporada”, tono profesional…"
                  onChange={(e) => setPrompt(e.target.value)} />
              </div>

              {error && <div className="ms-errors">{error}</div>}

              {enviada ? (
                <div className="ms-ok">
                  <span>✅ Enviada. Se está generando; la verás en <strong>Generaciones</strong>.</span>
                  <button type="button" className="btn" onClick={() => onCerrar('generaciones')}>Ver generaciones</button>
                </div>
              ) : (
                <div className="ms-submit">
                  <span className="ms-cost">
                    {creditos != null ? <>Usa <strong>{fmtCred(creditos)} créditos</strong>{pr && <> · <strong>{usd(pr.precio)}</strong></>}{rol === 'super_admin' && pr?.costo != null && ` · costo ${usd(pr.costo)} · margen ${pr.margen} %`}{rol !== 'super_admin' && saldo != null && ` · saldo ${cred(saldo)}`}</>
                      : TIPOS_VIDEO.has(preset.type) ? 'Calculando costo según duración…' : ''}
                    {pendientes.length > 0 && <><br />{pendientes[0]}</>}
                    {sinSaldo && onRecargar && <><br /><button type="button" className="mini-btn" onClick={() => onCerrar('creditos')}>💳 Ver créditos</button></>}
                  </span>
                  <button className="btn" type="submit" disabled={pendientes.length > 0 || ocupado}>
                    {enviando ? 'Enviando…' : '✨ Generar'}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
