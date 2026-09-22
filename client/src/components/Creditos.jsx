import { useEffect, useState } from 'react';
import { fetchCreditos, pedirRecarga, aprobarRecarga, rechazarRecarga, resolverRecarga, fijarSaldoMarketing } from '../api';
import { usd, usdFino, cred } from '../precio';

const TIPOS = { recarga: 'Recarga', consumo: 'Generación', reembolso: 'Devolución', ajuste: 'Ajuste', ia: 'Ayuda de IA' };
const CLASES_IA = { descripcion: 'Descripción automática', ficha: 'Lectura de ficha técnica', caption: 'Texto para redes', camila: 'Búsqueda con Camila', clasificar: 'Clasificación de plantillas' };
const EST_SOL = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', revisar: 'En revisión' };
const MONTOS = [25, 50, 100, 250];
// Referencias de consumo (creditos aproximados; el costo exacto se ve antes de crear).
const EJEMPLOS = [
  ['📦', 'Foto de producto (plantilla)', 1.5], ['🪧', 'Anuncio o póster', 7.5],
  ['🎬', 'Video de 5 s (Kling 3.0)', 10], ['🎥', 'Video de 5 s calidad cine (Cinema Studio 4.0)', 35],
];
const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const ESTADOS = { pendiente: 'En cola', enviando: 'Enviando', en_proceso: 'Creando', completado: 'Lista', fallido: 'No salió' };

// Saldo de la plataforma de pagos de Nebo (USD): es el saldo con el que se crea. Se recarga con la
// pagina de pago embebida; lo creado se descuenta alla (lo que aun no se descontó se resta aca).
function CreditosExterno({ d, onActualizar, actualizando }) {
  const negativo = d.disponibleUsd != null && d.disponibleUsd < 0;
  return (
    <>
      {d.error && <div className="banner-off" style={{ marginTop: 16 }}>{d.error}</div>}
      <div className="grid kpis cr-kpis" style={{ marginTop: 16 }}>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: 'var(--series-1)' }} />
          <div className="kpi-label">Saldo total</div>
          <div className="kpi-value">{d.saldoUsd != null ? usd(d.saldoUsd) : '—'}</div>
          <div className="kpi-foot">{d.cuenta?.nombre || 'Tu cuenta Nebo'}{d.leido ? ` · actualizado ${new Date(d.leido).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: 'var(--series-3)' }} />
          <div className="kpi-label">Por descontar</div>
          <div className="kpi-value">{d.pendienteUsd != null ? usd(d.pendienteUsd) : '—'}</div>
          <div className="kpi-foot">Creaciones de Marketing que todavía no se restaron del saldo total.</div>
        </div>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: negativo ? 'var(--critical)' : 'var(--series-2)' }} />
          <div className="kpi-label">Disponible para crear</div>
          <div className="kpi-value" style={negativo ? { color: 'var(--critical)' } : undefined}>{d.disponibleUsd != null ? usd(d.disponibleUsd) : '—'}</div>
          <div className="kpi-foot">{negativo ? 'Recarga para volver a crear.' : 'Saldo total menos lo que falta descontar.'}</div>
        </div>
      </div>
      <div className="ms-submit" style={{ marginTop: 8 }}>
        <span className="ms-cost">{d.autoRecarga ? `Recarga automática: ${d.autoRecarga.activa ? 'activada' : 'desactivada'}${d.autoRecarga.umbralUsd != null ? ` (cuando baja de ${usd(d.autoRecarga.umbralUsd)})` : ''}` : ''}</span>
        <button className="mini-btn" onClick={onActualizar} disabled={actualizando}>{actualizando ? 'Actualizando…' : '↻ Actualizar saldo'}</button>
      </div>

      <div className="section-title">Recargar saldo</div>
      <div className="card cr-pago">
        <iframe src={d.pagoUrl} title="Pagar · Nebo AI" className="cr-pago-frame" />
        <div className="cr-pago-txt">
          <h3>Paga aquí y se suma a tu saldo</h3>
          <p>El pago se hace en la plataforma de pagos de Nebo, la misma de tus otros servicios. Lo que recargues queda en tu saldo total y se usa también aquí.</p>
          <p>Cuando termines de pagar, toca <strong>Actualizar saldo</strong> para verlo reflejado.</p>
          <button className="btn secondary" onClick={onActualizar} disabled={actualizando}>{actualizando ? 'Actualizando…' : '↻ Ya pagué: actualizar saldo'}</button>
        </div>
      </div>

      <div className="section-title">¿Qué puedo hacer con mi saldo?</div>
      <div className="cr-ejemplos">
        {EJEMPLOS.map(([ic, l, cr]) => (
          <div key={l} className="cr-ej">
            <span className="cr-ej-ic">{ic}</span>
            <span className="cr-ej-l">{l}</span>
            <span className="cr-ej-v"><strong>≈ {d.precioCredito ? usd(cr * d.precioCredito) : '—'}</strong></span>
          </div>
        ))}
      </div>
      <div className="ms-cost" style={{ margin: '8px 2px 0' }}>Son referencias: antes de crear siempre ves el costo exacto. Si una creación falla, no se cobra.</div>

      <div className="section-title">Historial de consumo</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Creación</th><th>Estado</th><th className="num">Costo</th><th>Descontado del saldo</th></tr></thead>
            <tbody>
              {d.consumos.length ? d.consumos.map((c) => (
                <tr key={c.id}>
                  <td>{fecha(c.creado)}</td>
                  <td className="trunc">{c.preset_nombre} #{c.id} · {c.creado_por}</td>
                  <td><span className={`pill st-${c.estado}`}>{ESTADOS[c.estado] || c.estado}</span></td>
                  <td className="num">{c.estado === 'fallido' ? <s>{usd(c.precio_usd)}</s> : usd(c.precio_usd)}</td>
                  <td>{c.estado === 'fallido' ? 'No se cobra' : c.gasto_informado ? 'Sí' : 'Pendiente'}</td>
                </tr>
              )) : <tr><td colSpan={5} className="trunc">Todavía no hay consumos.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Saldo propio de Marketing: se recarga desde el saldo general de JH por solicitud. Quien
// pide solo ve el saldo de Marketing; el saldo general lo ve solo quien puede aprobar.
function PedirRecarga({ onPedida }) {
  const [monto, setMonto] = useState(50);
  const [otro, setOtro] = useState('');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [msg, setMsg] = useState(null);
  const valor = otro !== '' ? Number(otro) : monto;
  const enviar = async () => {
    setEnviando(true); setMsg(null);
    try {
      await pedirRecarga(valor, motivo.trim());
      setMsg({ ok: true, t: `Listo: pediste ${usd(valor)}. Te avisamos aquí cuando se apruebe.` });
      setMotivo(''); setOtro('');
      onPedida();
    } catch (e) { setMsg({ ok: false, t: e.message }); }
    setEnviando(false);
  };
  return (
    <div className="card cr-pedir">
      <div className="cr-montos" role="group" aria-label="Monto a pedir">
        {MONTOS.map((m) => (
          <button key={m} className={`cr-monto ${otro === '' && monto === m ? 'on' : ''}`} onClick={() => { setMonto(m); setOtro(''); }}>{usd(m)}</button>
        ))}
        <label className="cr-otro-l">
          <span>Otro</span>
          <input id="cr-otro" type="number" min="1" max="5000" step="1" inputMode="decimal" className="cr-otro" placeholder="USD" value={otro} onChange={(e) => setOtro(e.target.value)} />
        </label>
      </div>
      <label className="cr-motivo-l" htmlFor="cr-motivo">Para qué es <span className="ms-cost">(opcional, ayuda a que lo aprueben rápido)</span></label>
      <input id="cr-motivo" className="cr-motivo" maxLength={300} placeholder="Ej. videos de la campaña de breakers de octubre" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      <div className="ms-submit">
        <span className={msg ? (msg.ok ? 'cr-ok' : 'cr-err') : 'ms-cost'}>{msg ? msg.t : 'Lo aprueba una persona autorizada de JH y se suma al saldo de Marketing.'}</span>
        <button className="btn" onClick={enviar} disabled={enviando || !(valor >= 1 && valor <= 5000)}>{enviando ? 'Enviando…' : `Pedir ${valor >= 1 ? usd(valor) : 'recarga'}`}</button>
      </div>
    </div>
  );
}

function SolicitudAbierta({ s, onHecho }) {
  const [nota, setNota] = useState('');
  const [ocupado, setOcupado] = useState(null);
  const [error, setError] = useState(null);
  const hacer = async (que, fn) => {
    setOcupado(que); setError(null);
    try { const r = await fn(); if (r?.error) setError(r.error); onHecho(); } catch (e) { setError(e.message); }
    setOcupado(null);
  };
  const revisar = s.estado === 'revisar';
  return (
    <div className={`cr-sol ${revisar ? 'revisar' : ''}`}>
      <div className="cr-sol-top">
        <b className="num cr-sol-monto">{usd(s.monto_usd)}</b>
        <span className="cr-sol-quien">{s.pedido_por} · {fecha(s.creado)}</span>
        <span className={`pill sol-${s.estado}`}>{EST_SOL[s.estado]}</span>
      </div>
      {s.motivo && <div className="cr-sol-motivo">“{s.motivo}”</div>}
      {revisar ? (
        <>
          <div className="cr-sol-aviso">No se pudo confirmar si la plataforma de pagos descontó este monto del saldo general. Revisa el historial de la cuenta JH en la plataforma y confirma lo que pasó.</div>
          <div className="cr-sol-acc">
            <button className="btn" disabled={!!ocupado} onClick={() => hacer('si', () => resolverRecarga(s.id, true))}>{ocupado === 'si' ? '…' : 'Sí se descontó: sumar a Marketing'}</button>
            <button className="btn secondary" disabled={!!ocupado} onClick={() => hacer('no', () => resolverRecarga(s.id, false))}>{ocupado === 'no' ? '…' : 'No se descontó: volver a pendiente'}</button>
          </div>
        </>
      ) : (
        <div className="cr-sol-acc">
          <input id={`cr-nota-${s.id}`} className="cr-motivo" maxLength={300} placeholder="Nota (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Nota para quien pidió" />
          <button className="btn" disabled={!!ocupado} onClick={() => hacer('ok', () => aprobarRecarga(s.id, nota.trim()))}>{ocupado === 'ok' ? 'Aprobando…' : 'Aprobar'}</button>
          <button className="btn secondary" disabled={!!ocupado} onClick={() => hacer('no', () => rechazarRecarga(s.id, nota.trim()))}>{ocupado === 'no' ? '…' : 'Rechazar'}</button>
        </div>
      )}
      {error && <div className="cr-err">{error}</div>}
    </div>
  );
}

function detalleMov(m) {
  if (m.tipo === 'ia') return `${CLASES_IA[m.clase] || 'Ayuda de IA'}${m.concepto && m.concepto !== CLASES_IA[m.clase] ? ` · ${m.concepto}` : ''}${m.generacion_id ? ` → ${m.preset_nombre || 'creación'} #${m.generacion_id}` : ''} · ${m.por}`;
  if (m.generacion_id) return `${m.preset_nombre || m.concepto || 'Creación'} #${m.generacion_id}${m.tipo === 'consumo' ? ` · ${m.por}` : ''}`;
  return `${m.concepto || ''}${m.por && m.por !== 'sistema' ? ` · ${m.por}` : ''}`;
}

// Solo super admin: fija el saldo de Marketing sin mover plata del saldo general (pruebas, demos, correcciones).
function FijarSaldo({ actual, onHecho }) {
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [msg, setMsg] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const n = Number(valor);
  const fijar = async () => {
    if (!window.confirm(`¿Fijar el saldo de Marketing en ${usd(n)}? No se descuenta nada del saldo general de JH.`)) return;
    setOcupado(true); setMsg(null);
    try { const r = await fijarSaldoMarketing(n, motivo.trim()); setMsg({ ok: true, t: `Listo: ${usd(r.antes)} → ${usd(r.saldoUsd)}.` }); setValor(''); setMotivo(''); onHecho(); }
    catch (e) { setMsg({ ok: false, t: e.message }); }
    setOcupado(false);
  };
  return (
    <details className="card cr-pago-det">
      <summary>Fijar saldo de Marketing a mano (solo super admin)</summary>
      <div className="cr-pedir" style={{ paddingTop: 12 }}>
        <div className="ms-cost">Deja el saldo de Marketing en el monto que pongas (hoy {usd(actual)}). Queda como “Ajuste” en los movimientos. No mueve plata del saldo general de JH.</div>
        <div className="cr-sol-acc">
          <input id="cr-fijar" type="number" min="0" max="10000" step="0.01" className="cr-otro" placeholder="USD" value={valor} onChange={(e) => setValor(e.target.value)} aria-label="Nuevo saldo en USD" />
          <input id="cr-fijar-motivo" className="cr-motivo" maxLength={200} placeholder="Motivo (ej. saldo para la demo al equipo)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <button className="btn" disabled={ocupado || valor === '' || !(n >= 0 && n <= 10000)} onClick={fijar}>{ocupado ? 'Guardando…' : 'Fijar saldo'}</button>
        </div>
        {msg && <span className={msg.ok ? 'cr-ok' : 'cr-err'}>{msg.t}</span>}
      </div>
    </details>
  );
}

function CreditosMarketing({ d, onActualizar, actualizando }) {
  const negativo = d.saldoUsd < 0;
  const g = d.general;
  return (
    <>
      <div className="grid kpis cr-kpis" style={{ marginTop: 16 }}>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: negativo ? 'var(--critical)' : 'var(--series-1)' }} />
          <div className="kpi-label">Saldo de Marketing</div>
          <div className="kpi-value" style={negativo ? { color: 'var(--critical)' } : undefined}>{usd(d.saldoUsd)}</div>
          <div className="kpi-foot">{negativo || d.saldoUsd === 0 ? 'Pide una recarga para volver a crear.' : 'Con esto se pagan las creaciones y las ayudas de IA.'}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: 'var(--series-3)' }} />
          <div className="kpi-label">Gastado este mes</div>
          <div className="kpi-value">{usd(d.gastoMes.gastoUsd)}</div>
          <div className="kpi-foot">{d.gastoMes.iaUsd > 0 ? `Incluye ${usd(d.gastoMes.iaUsd)} de ayudas de IA (descripciones, fichas, Camila).` : 'Creaciones y ayudas de IA, sin contar lo devuelto.'}
            {d.puedeFijar && d.gastoMes.jhUsd > 0 && ` Aparte, IA de super admins y del sistema cobrada a JH: ${usdFino(d.gastoMes.jhUsd)}.`}</div>
        </div>
      </div>

      {d.puedeFijar && <FijarSaldo actual={d.saldoUsd} onHecho={onActualizar} />}

      {d.puedeAprobar && (
        <>
          <div className="section-title">Solicitudes por aprobar {d.abiertas?.length > 0 && <span className="hd-n">{d.abiertas.length}</span>}</div>
          <div className="card cr-aprob">
            <div className="cr-general">
              <div>
                <div className="kpi-label">Saldo general de JH</div>
                <div className="cr-general-v num">{g?.disponibleUsd != null ? usd(g.disponibleUsd) : '—'}</div>
                <div className="ms-cost">{g?.error || `Disponible${g?.pendienteUsd ? ` · ${usd(g.pendienteUsd)} por descontar` : ''}. Solo lo ves tú.`}</div>
              </div>
              <span className="cr-general-flecha" aria-hidden="true">→</span>
              <div>
                <div className="kpi-label">Saldo de Marketing</div>
                <div className="cr-general-v num">{usd(d.saldoUsd)}</div>
                <div className="ms-cost">Al aprobar, el monto se resta del general y se suma aquí.</div>
              </div>
              <button className="mini-btn cr-general-act" onClick={onActualizar} disabled={actualizando}>{actualizando ? 'Actualizando…' : '↻ Actualizar'}</button>
            </div>
            <div className="cr-sols">
              {d.abiertas?.length ? d.abiertas.map((s) => <SolicitudAbierta key={s.id} s={s} onHecho={onActualizar} />)
                : <div className="ms-cost">No hay solicitudes esperando.</div>}
            </div>
          </div>
          {d.pagoUrl && (
            <details className="card cr-pago-det">
              <summary>Recargar el saldo general de JH</summary>
              <div className="cr-pago">
                <iframe src={d.pagoUrl} title="Pagar · Nebo AI" className="cr-pago-frame" />
                <div className="cr-pago-txt">
                  <p>El pago se hace en la plataforma de pagos de Nebo y entra al saldo general de JH. Después apruebas lo que Marketing necesite.</p>
                  <button className="btn secondary" onClick={onActualizar} disabled={actualizando}>{actualizando ? 'Actualizando…' : '↻ Ya pagué: actualizar'}</button>
                </div>
              </div>
            </details>
          )}
        </>
      )}

      <div className="section-title">Pedir recarga</div>
      <PedirRecarga onPedida={onActualizar} />
      {d.misSolicitudes.length > 0 && (
        <div className="cr-mias">
          {d.misSolicitudes.map((s) => (
            <div key={s.id} className="cr-mia">
              <span className="num">{usd(s.monto_usd)}</span>
              <span className="cr-mia-f">{fecha(s.creado)}</span>
              <span className={`pill sol-${s.estado}`}>{EST_SOL[s.estado]}</span>
              {s.nota && <span className="cr-mia-n">{s.resuelto_por ? `${s.resuelto_por}: ` : ''}{s.nota}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="section-title">¿Qué puedo hacer con el saldo?</div>
      <div className="cr-ejemplos">
        {EJEMPLOS.map(([ic, l, cr]) => (
          <div key={l} className="cr-ej">
            <span className="cr-ej-ic">{ic}</span>
            <span className="cr-ej-l">{l}</span>
            <span className="cr-ej-v"><strong>≈ {d.precioCredito ? usd(cr * d.precioCredito) : '—'}</strong></span>
          </div>
        ))}
      </div>
      <div className="ms-cost" style={{ margin: '8px 2px 0' }}>Son referencias: antes de crear siempre ves el costo exacto. Las ayudas de IA (descripción automática, leer la ficha técnica, textos para redes, Camila) cuestan centavos y se suman al total de la creación. Si una creación falla, se devuelve.</div>

      <div className="section-title">Movimientos</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th className="num">USD</th></tr></thead>
            <tbody>
              {d.movimientos.length ? d.movimientos.map((m) => (
                <tr key={m.id}>
                  <td>{fecha(m.creado)}</td>
                  <td><span className={`pill mov-${m.tipo}`}>{TIPOS[m.tipo] || m.tipo}</span>{m.a_jh && <span className="pill mov-jh" title="No sale del saldo de Marketing: se descuenta del saldo general de JH">{m.lote_estado === 'enviado' ? 'Cobrado a JH' : m.lote_estado === 'revisar' ? 'A JH · revisar' : 'A JH · por enviar'}</span>}</td>
                  <td className="trunc">{detalleMov(m)}</td>
                  <td className="num" style={{ color: m.a_jh ? 'var(--text-muted)' : m.usd < 0 ? 'var(--critical)' : 'var(--good-ink)' }}>{m.usd > 0 ? '+' : '−'}{usdFino(Math.abs(m.usd))}</td>
                </tr>
              )) : <tr><td colSpan={4} className="trunc">Todavía no hay movimientos.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// Billetera de JH: saldo, precio por credito, paquetes para recargar (pago en linea en standby) y movimientos.
export default function Creditos({ recarga, onRecargada }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [elegido, setElegido] = useState(null);
  const [actualizando, setActualizando] = useState(false);
  const cargar = (fresco = false) => fetchCreditos({ fresco }).then(setD).catch((e) => setError(e.message));
  const actualizar = async () => { setActualizando(true); await cargar(true); setActualizando(false); onRecargada?.(); };
  useEffect(() => { cargar(); }, [recarga]); // eslint-disable-line react-hooks/exhaustive-deps
  // Con saldo externo: se refresca solo cada 30 s mientras la pestaña esta abierta (por si pagaron).
  useEffect(() => {
    if (d?.fuente !== 'externo' && d?.fuente !== 'marketing') return undefined;
    const id = setInterval(() => cargar(), 30000);
    return () => clearInterval(id);
  }, [d?.fuente]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>{error}</div>;
  if (!d) return <div className="loading"><div className="spinner" /></div>;
  if (d.fuente === 'externo') return <CreditosExterno d={d} onActualizar={actualizar} actualizando={actualizando} />;
  if (d.fuente === 'marketing') return <CreditosMarketing d={d} onActualizar={actualizar} actualizando={actualizando} />;

  return (
    <>
      <div className="grid kpis" style={{ marginTop: 16 }}>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: 'var(--series-1)' }} />
          <div className="kpi-label">Saldo disponible</div>
          <div className="kpi-value">{cred(d.saldo)} <span className="cr-unidad">créditos</span></div>
          <div className="kpi-foot">{d.precioCredito ? `≈ ${usd(d.saldo * d.precioCredito)}` : ''}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-accent" style={{ background: 'var(--series-2)' }} />
          <div className="kpi-label">Precio por crédito</div>
          <div className="kpi-value">{d.precioCredito ? usd(d.precioCredito) : '—'}</div>
          <div className="kpi-foot">{d.precioCredito ? `${cred(1 / d.precioCredito)} créditos por dólar` : 'Aún sin precio configurado'}</div>
        </div>
      </div>

      <div className="section-title">¿Qué puedo hacer con mis créditos?</div>
      <div className="cr-ejemplos">
        {EJEMPLOS.map(([ic, l, cr]) => (
          <div key={l} className="cr-ej">
            <span className="cr-ej-ic">{ic}</span>
            <span className="cr-ej-l">{l}</span>
            <span className="cr-ej-v"><strong>≈ {cred(cr)} créditos</strong>{d.precioCredito ? ` · ${usd(cr * d.precioCredito)}` : ''}</span>
          </div>
        ))}
      </div>
      <div className="ms-cost" style={{ margin: '8px 2px 0' }}>Son referencias: antes de crear siempre ves el costo exacto. Si una creación falla, los créditos se devuelven solos.</div>

      <div className="section-title">Recargar créditos</div>
      <div className="card">
        <div className="card-sub">Elige un paquete. Mientras llega el pago en línea, escríbele a Nebo con el paquete que quieres y lo cargamos a tu saldo.</div>
        <div className="cr-paquetes">
          {d.paquetes.map((p) => (
            <button key={p.creditos} className={`cr-paquete ${elegido === p.creditos ? 'on' : ''}`} onClick={() => setElegido(p.creditos)}>
              <span className="cr-cant">{cred(p.creditos)}</span>
              <span className="cr-lbl">créditos</span>
              <span className="cr-precio">{p.usd != null ? usd(p.usd) : '—'}</span>
            </button>
          ))}
        </div>
        <div className="ms-submit">
          <span className="ms-cost">
            {elegido ? <>Elegiste <strong>{cred(elegido)} créditos</strong>{d.paquetes.find((p) => p.creditos === elegido)?.usd != null && <> por <strong>{usd(d.paquetes.find((p) => p.creditos === elegido).usd)}</strong></>}.{!d.pagoEnLinea && ' Pídeselo a Nebo.'}</> : 'Toca un paquete para elegirlo.'}
          </span>
          <button className="btn" disabled={!d.pagoEnLinea || !elegido} title={d.pagoEnLinea ? '' : 'Próximamente'}>{d.pagoEnLinea ? '💳 Pagar y recargar' : '💳 Pago en línea (próximamente)'}</button>
        </div>
      </div>

      <div className="section-title">Historial de movimientos</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th className="num">Créditos</th><th className="num">USD</th></tr></thead>
            <tbody>
              {d.movimientos.length ? d.movimientos.map((m) => (
                <tr key={m.id}>
                  <td>{fecha(m.creado)}</td>
                  <td><span className={`pill mov-${m.tipo}`}>{TIPOS[m.tipo] || m.tipo}</span></td>
                  <td className="trunc">{m.preset_nombre ? `${m.preset_nombre} #${m.generacion_id}` : m.nota || ''}{m.tipo === 'recarga' || m.tipo === 'ajuste' ? ` · ${m.por}` : ''}</td>
                  <td className="num" style={{ color: m.creditos < 0 ? 'var(--critical)' : 'var(--good-ink)' }}>{m.creditos > 0 ? '+' : ''}{cred(m.creditos)}</td>
                  <td className="num">{m.usd != null ? usd(Math.abs(m.usd)) : ''}</td>
                </tr>
              )) : <tr><td colSpan={5} className="trunc">Todavía no hay movimientos.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
