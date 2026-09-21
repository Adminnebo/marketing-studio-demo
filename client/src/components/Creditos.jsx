import { useEffect, useState } from 'react';
import { fetchCreditos } from '../api';
import { usd, cred } from '../precio';

const TIPOS = { recarga: 'Recarga', consumo: 'Generación', reembolso: 'Devolución', ajuste: 'Ajuste' };
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
    if (d?.fuente !== 'externo') return undefined;
    const id = setInterval(() => cargar(), 30000);
    return () => clearInterval(id);
  }, [d?.fuente]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>{error}</div>;
  if (!d) return <div className="loading"><div className="spinner" /></div>;
  if (d.fuente === 'externo') return <CreditosExterno d={d} onActualizar={actualizar} actualizando={actualizando} />;

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
