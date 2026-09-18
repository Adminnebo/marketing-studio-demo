import { useEffect, useState } from 'react';
import { fetchCreditos } from '../api';
import { usd, cred } from '../precio';

const TIPOS = { recarga: 'Recarga', consumo: 'Generación', reembolso: 'Devolución', ajuste: 'Ajuste' };
const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// Billetera de JH: saldo, precio por credito, paquetes para recargar (pago en linea en standby) y movimientos.
export default function Creditos({ recarga }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [elegido, setElegido] = useState(null);
  const cargar = () => fetchCreditos().then(setD).catch((e) => setError(e.message));
  useEffect(() => { cargar(); }, [recarga]);

  if (error) return <div className="ms-errors" style={{ marginTop: 16 }}>{error}</div>;
  if (!d) return <div className="loading"><div className="spinner" /></div>;

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

      <div className="section-title">Recargar créditos</div>
      <div className="card">
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
            {d.pagoEnLinea ? '' : 'El pago en línea estará disponible pronto. Por ahora, para recargar escríbele a Nebo y lo cargamos a tu saldo.'}
          </span>
          <button className="btn" disabled={!d.pagoEnLinea || !elegido} title={d.pagoEnLinea ? '' : 'Próximamente'}>💳 Pagar y recargar</button>
        </div>
      </div>

      <div className="section-title">Movimientos</div>
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
