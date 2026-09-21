import { useEffect, useState } from 'react';
import { fetchCreditos, fetchSaldoGeneral, recargarDesdeGeneral } from '../api';
import { usd, cred } from '../precio';

const TIPOS = { recarga: 'Recarga', consumo: 'Generación', reembolso: 'Devolución', ajuste: 'Ajuste' };
// Referencias de consumo (creditos aproximados; el costo exacto se ve antes de crear).
const EJEMPLOS = [
  ['📦', 'Foto de producto (plantilla)', 1.5], ['🪧', 'Anuncio o póster', 7.5],
  ['🎬', 'Video de 5 s (Kling 3.0)', 10], ['🎥', 'Video de 5 s calidad cine (Cinema Studio 4.0)', 35],
];
const fecha = (s) => new Date(s).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const MONTOS = [10, 25, 50, 100];

// Pasar saldo del balance general (plataforma central de pagos de Nebo) a Marketing.
function RecargaGeneral({ precioCredito, onRecargada }) {
  const [general, setGeneral] = useState(null); // { saldoUsd } | { error }
  const [monto, setMonto] = useState(25);
  const [otro, setOtro] = useState('');
  const [estado, setEstado] = useState(null);
  const leer = () => fetchSaldoGeneral().then(setGeneral).catch((e) => setGeneral({ error: e.message }));
  useEffect(() => { leer(); }, []);
  const valor = otro !== '' ? Number(otro) : monto;
  const creditos = precioCredito && valor > 0 ? Math.floor((valor / precioCredito) * 10) / 10 : null;
  const alcanza = general?.saldoUsd == null || valor <= general.saldoUsd;
  const valido = valor >= 1 && valor <= 10000 && alcanza && creditos != null;
  const recargar = async () => {
    if (!valido || estado?.cargando) return;
    if (!window.confirm(`Se pasarán ${usd(valor)} de tu saldo general a Marketing (${cred(creditos)} créditos). ¿Continuar?`)) return;
    setEstado({ cargando: true });
    try {
      const r = await recargarDesdeGeneral(valor);
      if (r.pendiente) setEstado({ aviso: r.error });
      else setEstado({ ok: `Listo: se sumaron ${cred(r.creditos)} créditos. Saldo de Marketing: ${cred(r.saldo)} créditos.` });
      setOtro(''); leer(); onRecargada?.();
    } catch (e) { setEstado({ error: e.message }); }
  };
  return (
    <div className="card">
      <div className="cr-general">
        <div>
          <div className="kpi-label">Tu saldo general en Nebo</div>
          <div className="cr-general-v">{general == null ? '…' : general.error ? '—' : usd(general.saldoUsd)}</div>
          {general?.error && <div className="ms-cost" style={{ color: 'var(--critical)' }}>{general.error}</div>}
        </div>
        <div className="cr-general-flecha">→</div>
        <div>
          <div className="kpi-label">Pasar a Marketing</div>
          <div className="ms-chips" style={{ marginTop: 6 }}>
            {MONTOS.map((m) => <button key={m} className={`dr-preset ${otro === '' && monto === m ? 'active' : ''}`} onClick={() => { setMonto(m); setOtro(''); }}>{usd(m)}</button>)}
            <input className="search cr-otro" type="number" min="1" max="10000" step="1" placeholder="Otro monto" value={otro} onChange={(e) => setOtro(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="ms-submit">
        <span className="ms-cost">
          {creditos != null && valor > 0 ? <>Recibes <strong>{cred(creditos)} créditos</strong> por {usd(valor)} ({usd(precioCredito)} por crédito).</> : 'Elige cuánto pasar.'}
          {!alcanza && <><br /><span style={{ color: 'var(--critical)' }}>Tu saldo general no alcanza para ese monto.</span></>}
        </span>
        <button className="btn" onClick={recargar} disabled={!valido || estado?.cargando}>{estado?.cargando ? 'Recargando…' : `💳 Pasar ${valor > 0 ? usd(valor) : ''} a Marketing`}</button>
      </div>
      {estado?.ok && <div className="ms-ok" style={{ marginTop: 10 }}>✅ {estado.ok}</div>}
      {estado?.aviso && <div className="lb-avisos" style={{ marginTop: 10 }}>{estado.aviso}</div>}
      {estado?.error && <div className="ms-errors" style={{ marginTop: 10 }}>{estado.error}</div>}
    </div>
  );
}

// Billetera de JH: saldo, precio por credito, paquetes para recargar (pago en linea en standby) y movimientos.
export default function Creditos({ recarga, onRecargada }) {
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
      {d.central?.puedeRecargar ? (
        <RecargaGeneral precioCredito={d.precioCredito} onRecargada={() => { cargar(); onRecargada?.(); }} />
      ) : d.central?.configurado ? (
        <div className="card"><div className="card-sub" style={{ margin: 0 }}>Las recargas se hacen desde el saldo general de tu cuenta Nebo. Pídele a un administrador de Marketing que pase saldo.</div></div>
      ) : (
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
      )}

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
