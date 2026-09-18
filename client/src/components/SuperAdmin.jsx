import { useEffect, useMemo, useState } from 'react';
import { fetchAjustes, guardarAjustes, fetchUsuarios, cambiarAcceso, fetchConsumo } from '../api';
import { TIPOS } from '@shared/reglas.mjs';
import { usd } from '../precio';

const num = (n, d = 1) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: d });
const ROLES_PANELES = { super_admin: 'Super admin', admin: 'Admin', agent: 'Agente' };
// Tipos de plantilla agrupados como se cobran (los de animacion comparten nombre).
const TIPOS_MARGEN = ['product_shots', 'product_shots_people', 'ads', 'poster', 'marketplace', 'ugc', 'hypermotion', '2d_motion', 'mixed_media', 'saas_motion'];
const EJEMPLOS = [['product_shots', 1.5, 'Foto de producto'], ['ads', 7.5, 'Anuncio'], ['ugc', 65, 'Video UGC de 10 s']];
const mesActual = () => new Date().toISOString().slice(0, 7);

function Ajustes({ onGuardado }) {
  const [datos, setDatos] = useState(null);
  const [f, setF] = useState(null);
  const [calc, setCalc] = useState({ plan: '', creditos: '' });
  const [estado, setEstado] = useState(null);

  const cargar = () => fetchAjustes().then((d) => { setDatos(d); setF({ ...d.ajustes, margen_por_tipo: { ...d.ajustes.margen_por_tipo } }); })
    .catch((e) => setEstado({ error: e.message }));
  useEffect(() => { cargar(); }, []);
  if (!f) return <div className="card">{estado?.error ? <div className="ms-errors">{estado.error}</div> : <div className="spinner" />}</div>;

  const margenDe = (t) => (f.margen_por_tipo[t] !== undefined && f.margen_por_tipo[t] !== '' ? Number(f.margen_por_tipo[t]) : Number(f.margen_pct));
  const guardar = async () => {
    setEstado({ guardando: true });
    try {
      await guardarAjustes(f);
      setEstado({ ok: 'Guardado. Aplica a las generaciones nuevas; las anteriores conservan su precio.' });
      cargar();
      onGuardado?.();
    } catch (e) { setEstado({ error: e.message }); }
  };
  const calcUsd = Number(calc.plan) > 0 && Number(calc.creditos) > 0 ? Number(calc.plan) / Number(calc.creditos) : null;

  return (
    <div className="grid sa-grid">
      <div className="card">
        <h3>Costo y ganancia</h3>
        <div className="card-sub">El precio al cliente = créditos × costo por crédito × (1 + % de ganancia).</div>
        <div className="sa-form">
          <label className="filter-field"><span>Costo por crédito (USD)</span>
            <input className="search" type="number" min="0" step="0.0001" value={f.usd_por_credito} onChange={(e) => setF({ ...f, usd_por_credito: e.target.value })} />
          </label>
          <label className="filter-field"><span>% de ganancia (general)</span>
            <input className="search" type="number" min="0" step="1" value={f.margen_pct} onChange={(e) => setF({ ...f, margen_pct: e.target.value })} />
          </label>
          <label className="filter-field"><span>Tope diario por usuario (créditos, 0 = sin tope)</span>
            <input className="search" type="number" min="0" step="1" value={f.limite_diario_creditos} onChange={(e) => setF({ ...f, limite_diario_creditos: e.target.value })} />
          </label>
          <label className="user-admin-check" style={{ alignSelf: 'end', paddingBottom: 8 }}>
            <input type="checkbox" checked={Number(f.mostrar_precio) === 1} onChange={(e) => setF({ ...f, mostrar_precio: e.target.checked ? 1 : 0 })} />
            Los usuarios ven el precio en USD al generar
          </label>
        </div>
        <div className="sa-calc">
          <span className="filter-lbl">Calcular costo por crédito:</span>
          <input className="search" type="number" min="0" placeholder="Precio del plan (USD/mes)" value={calc.plan} onChange={(e) => setCalc({ ...calc, plan: e.target.value })} />
          <span>÷</span>
          <input className="search" type="number" min="0" placeholder="Créditos del plan" value={calc.creditos} onChange={(e) => setCalc({ ...calc, creditos: e.target.value })} />
          <span>=</span>
          <strong>{calcUsd ? `$${calcUsd.toFixed(4)}` : '—'}</strong>
          {calcUsd && <button className="mini-btn" onClick={() => setF({ ...f, usd_por_credito: Number(calcUsd.toFixed(6)) })}>Usar</button>}
        </div>

        <div className="section-title">% de ganancia por tipo (vacío = el general)</div>
        <div className="sa-tipos">
          {TIPOS_MARGEN.map((t) => (
            <label key={t} className="filter-field"><span>{TIPOS[t]}{['hypermotion', '2d_motion', 'mixed_media', 'saas_motion'].includes(t) ? ` (${t.replace('_', ' ')})` : ''}</span>
              <input className="search" type="number" min="0" step="1" placeholder={String(f.margen_pct)} value={f.margen_por_tipo[t] ?? ''}
                onChange={(e) => setF({ ...f, margen_por_tipo: { ...f.margen_por_tipo, [t]: e.target.value } })} />
            </label>
          ))}
        </div>

        {Number(f.usd_por_credito) > 0 && (
          <div className="sa-ejemplos">
            {EJEMPLOS.map(([t, cr, l]) => {
              const costo = cr * Number(f.usd_por_credito);
              const precio = costo * (1 + margenDe(t) / 100);
              return <span key={t} className="pill">{l} ({cr} cr): costo {usd(costo)} → precio <strong>{usd(precio)}</strong> · ganancia {usd(precio - costo)}</span>;
            })}
          </div>
        )}
        {!Number(f.usd_por_credito) && <div className="banner-off" style={{ marginTop: 12 }}>Sin costo por crédito no se calcula precio ni ganancia: los usuarios ven créditos.</div>}

        <div className="ms-submit">
          <span className="ms-cost">{estado?.ok && <span style={{ color: 'var(--good-ink)' }}>{estado.ok}</span>}{estado?.error && <span style={{ color: 'var(--critical)' }}>{estado.error}</span>}</span>
          <button className="btn" onClick={guardar} disabled={estado?.guardando}>{estado?.guardando ? 'Guardando…' : 'Guardar ajustes'}</button>
        </div>
      </div>

      <div className="card">
        <h3>Estado</h3>
        <div className="card-sub">Solo lo ven los super admin.</div>
        <div className="kpi">
          <div className="kpi-label">Créditos disponibles</div>
          <div className="kpi-value">{datos.saldo ? num(datos.saldo.creditos) : '—'}</div>
          <div className="kpi-foot">{datos.saldo ? `Plan ${datos.saldo.plan}` : 'No se pudo leer el saldo'}</div>
        </div>
        <div className="sa-conex">
          <span className={`badge ${datos.conexiones.generador ? 'live' : 'hf-off'}`}><span className="dot" />Generador {datos.conexiones.generador ? 'conectado' : 'desconectado'}</span>
          <span className={`badge ${datos.conexiones.redes ? 'live' : 'hf-off'}`}><span className="dot" />Redes {datos.conexiones.redes ? 'configuradas' : 'sin configurar'}</span>
        </div>
      </div>
    </div>
  );
}

function Consumo() {
  const [mes, setMes] = useState(mesActual);
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setD(null); fetchConsumo(mes).then(setD).catch((e) => setError(e.message)); }, [mes]);
  const t = d?.total;
  return (
    <>
      <div className="ms-bar">
        <span className="filter-lbl">Mes:</span>
        <input type="month" className="dr-date" value={mes} max={mesActual()} onChange={(e) => setMes(e.target.value || mesActual())} />
        {d?.sinCosto > 0 && <span className="ms-count">{d.sinCosto} generación(es) sin costo configurado</span>}
      </div>
      {error && <div className="ms-errors">{error}</div>}
      {!d ? <div className="loading"><div className="spinner" /></div> : (
        <>
          <div className="grid kpis">
            {[['Generaciones', num(t.generaciones, 0), `${t.fallidas} fallidas · ${t.enCurso} en curso`, 'var(--series-1)'],
              ['Créditos', num(t.creditos), 'estimados', 'var(--series-5)'],
              ['Costo', usd(t.costo), 'lo que pagamos', 'var(--series-8)'],
              ['Precio al cliente', usd(t.precio), 'con el margen', 'var(--series-2)'],
              ['Ganancia', usd(t.ganancia), t.costo > 0 ? `${num((t.ganancia / t.costo) * 100)} % sobre costo` : '—', 'var(--good)']].map(([l, v, pie, c]) => (
              <div key={l} className="card kpi">
                <div className="kpi-accent" style={{ background: c }} />
                <div className="kpi-label">{l}</div>
                <div className="kpi-value">{v}</div>
                <div className="kpi-foot">{pie}</div>
              </div>
            ))}
          </div>
          <div className="grid charts" style={{ marginTop: 16 }}>
            {[['Por usuario', d.porUsuario, 'email', (x) => x], ['Por tipo', d.porTipo, 'tipo', (x) => TIPOS[x] || x]].map(([titulo, filas, k, fmt]) => (
              <div key={titulo} className="card">
                <h3>{titulo}</h3>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{k === 'email' ? 'Usuario' : 'Tipo'}</th><th className="num">Gen.</th><th className="num">Créditos</th><th className="num">Costo</th><th className="num">Precio</th><th className="num">Ganancia</th></tr></thead>
                    <tbody>
                      {filas.length ? filas.map((x) => (
                        <tr key={x[k]}><td className="trunc">{fmt(x[k])}</td><td className="num">{x.generaciones}</td><td className="num">{num(x.creditos)}</td>
                          <td className="num">{usd(x.costo)}</td><td className="num">{usd(x.precio)}</td><td className="num">{usd(x.ganancia)}</td></tr>
                      )) : <tr><td colSpan={6} className="trunc">Sin movimiento este mes.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Usuarios({ yo }) {
  const [lista, setLista] = useState(null);
  const [q, setQ] = useState('');
  const [solo, setSolo] = useState(false);
  const [msg, setMsg] = useState(null);
  const [guardando, setGuardando] = useState(null);
  const cargar = () => fetchUsuarios().then((d) => setLista(d.usuarios)).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { cargar(); }, []);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (lista || []).filter((u) => (!solo || u.acceso) && (!t || (u.email || '').toLowerCase().includes(t) || (u.nombre || '').toLowerCase().includes(t)));
  }, [lista, q, solo]);

  const cambiar = async (u, acceso) => {
    setGuardando(u.id);
    setMsg(null);
    try {
      await cambiarAcceso(u.id, acceso || null);
      setLista((l) => l.map((x) => (x.id === u.id ? { ...x, acceso: acceso || null, otorgadoPor: acceso ? yo : null } : x)));
      setMsg({ ok: `${u.nombre || u.email}: ${acceso ? (acceso === 'admin' ? 'Admin' : 'Usuario') : 'sin acceso'}.` });
    } catch (e) { setMsg({ error: e.message }); } finally { setGuardando(null); }
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="toolbar" style={{ paddingBottom: 14 }}>
        <input className="search" placeholder="Buscar por nombre o correo…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="user-admin-check"><input type="checkbox" checked={solo} onChange={(e) => setSolo(e.target.checked)} /> Solo con acceso</label>
      </div>
      <div className="card-sub" style={{ padding: '0 14px' }}>
        <strong>Usuario</strong>: genera y descarga. <strong>Admin</strong>: además publica en redes y conecta cuentas. Los super admin de los paneles entran siempre.
      </div>
      {msg && <div className={`bulk-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.ok || msg.error}</div>}
      {!lista ? <div className="loading"><div className="spinner" /></div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Usuario</th><th>Rol en los paneles</th><th>Acceso a Marketing</th><th>Dado por</th></tr></thead>
            <tbody>
              {visibles.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.nombre || '—'}</strong><div className="ms-gen-meta">{u.email}</div></td>
                  <td>{ROLES_PANELES[u.rolPaneles] || u.rolPaneles}</td>
                  <td>
                    {u.acceso === 'super_admin' ? <span className="pill st-completado">Super admin · siempre</span> : (
                      <select className="search select" value={u.acceso || ''} disabled={guardando === u.id} onChange={(e) => cambiar(u, e.target.value)}>
                        <option value="">Sin acceso</option>
                        <option value="usuario">Usuario</option>
                        <option value="admin">Admin</option>
                      </select>
                    )}
                  </td>
                  <td className="trunc">{u.otorgadoPor || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const SECCIONES = [['ajustes', 'Ganancia y ajustes'], ['consumo', 'Consumo'], ['usuarios', 'Usuarios y acceso']];

export default function SuperAdmin({ yo, onAjustes }) {
  const [sec, setSec] = useState('ajustes');
  return (
    <>
      <div className="ms-bar">
        <div className="ms-chips">
          {SECCIONES.map(([k, l]) => <button key={k} className={`dr-preset ${sec === k ? 'active' : ''}`} onClick={() => setSec(k)}>{l}</button>)}
        </div>
      </div>
      {sec === 'ajustes' && <Ajustes onGuardado={onAjustes} />}
      {sec === 'consumo' && <Consumo />}
      {sec === 'usuarios' && <Usuarios yo={yo} />}
    </>
  );
}
