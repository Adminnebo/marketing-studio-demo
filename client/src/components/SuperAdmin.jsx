import RedesSetup from './RedesSetup';
import { useEffect, useMemo, useState } from 'react';
import { fetchAjustes, guardarAjustes, fetchUsuarios, cambiarAcceso, fetchConsumo, actualizarCosto, recargaManual, reconectarGenerador, verificarCli, cargarSesionCli, fetchPagosAdmin, probarPagos, reintentarConsumo, marcarDescontado, clasificarPlantillas, registrarWebhookRedes } from '../api';
import { TIPOS } from '@shared/reglas.mjs';
import { usd, cred } from '../precio';

const num = (n, d = 1) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: d });
const ROLES_PANELES = { super_admin: 'Super admin', admin: 'Admin', agent: 'Agente' };
const EJEMPLOS = [['product_shots', 1.5, 'Foto de producto'], ['ads', 7.5, 'Anuncio'], ['ugc', 65, 'Video UGC de 10 s']];
const mesActual = () => new Date().toISOString().slice(0, 7);

// Segunda conexion (CLI) para los modelos que la principal no tiene, como Cinema Studio 4.0.
function SesionCli({ cli, onCambio }) {
  const [abierto, setAbierto] = useState(false);
  const [paquete, setPaquete] = useState('');
  const [msg, setMsg] = useState(null);
  if (!cli) return null;
  const ok = cli.cargada && !cli.desconectada;
  const correr = async (fn, texto) => {
    setMsg({ cargando: true });
    try { const r = await fn(); setMsg({ ok: `${texto} ${r.email} · ${cred(r.creditos)} créditos.` }); setPaquete(''); setAbierto(false); onCambio?.(); } catch (e) { setMsg({ error: e.message }); }
  };
  return (
    <div className="sa-cli">
      <div className="sa-conex">
        <span className={`badge ${ok ? 'live' : 'hf-off'}`} title={cli.error || ''}>
          <span className="dot" />Modelos extra (Cinema Studio 4.0) {!cli.instalada ? 'no instalado' : !cli.cargada ? 'sin sesión' : cli.desconectada ? 'sesión vencida' : 'conectado'}{cli.cuenta ? ` · ${cli.cuenta}` : ''}
        </span>
        {cli.cargada && <button className="mini-btn" disabled={msg?.cargando} onClick={() => correr(verificarCli, 'Funciona:')}>✓ Verificar</button>}
        <button className="mini-btn" onClick={() => setAbierto(!abierto)}>{cli.cargada ? '🔑 Reemplazar sesión' : '🔑 Cargar sesión'}</button>
      </div>
      {abierto && (
        <div className="sa-cli-form">
          <div className="card-sub" style={{ margin: 0 }}>
            Esta conexión no se puede abrir desde aquí. En una computadora: inicia sesión con <code>npx @higgsfield/cli auth login</code> usando la cuenta de la empresa,
            corre <code>node scripts/sesion-cli.js</code> en este proyecto y pega el texto que imprime. Después se renueva sola.
          </div>
          <textarea className="search" rows={3} value={paquete} onChange={(e) => setPaquete(e.target.value)} placeholder="Pega aquí el paquete de sesión" />
          <div className="ms-submit">
            <span className="ms-cost" />
            <button className="btn" disabled={!paquete.trim() || msg?.cargando} onClick={() => correr(() => cargarSesionCli(paquete.trim()), 'Sesión cargada:')}>Guardar y probar</button>
          </div>
        </div>
      )}
      {msg?.ok && <div className="ms-cost" style={{ color: 'var(--good-ink)' }}>{msg.ok}</div>}
      {msg?.error && <div className="ms-cost" style={{ color: 'var(--critical)' }}>{msg.error}</div>}
    </div>
  );
}

// Saldo de JH en la plataforma de pagos de Nebo y gastos informados (el endpoint de gasto esta pendiente).
function PagosCentral() {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState(null);
  const cargar = () => fetchPagosAdmin().then(setD).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { cargar(); }, []);
  if (!d) return <div className="card"><h3>Saldo de JH (plataforma de pagos)</h3>{msg?.error ? <div className="ms-errors">{msg.error}</div> : <div className="spinner" />}</div>;
  const s = d.saldo;
  const pendientes = d.gasto.cola.pendiente || 0;
  const conError = d.gasto.cola.error || 0;
  return (
    <div className="card">
      <h3>Saldo de JH (plataforma de pagos)</h3>
      <div className="card-sub">
        {s.configurado
          ? <>Se crea contra el saldo de <strong>{s.nombre || 'JH'}</strong> en la plataforma de pagos. Lo creado que aún no se descontó allá se resta del saldo leído.</>
          : 'Sin configurar: faltan SALDO_CLIENT_ID y SALDO_API_KEY (en panel y worker). Mientras tanto se usa la billetera local y la recarga manual.'}
      </div>
      {s.configurado && (
        <div className="sa-ejemplos" style={{ marginTop: 0 }}>
          {s.error ? <span className="pill st-fallido">No se pudo leer: {s.error}</span> : (
            <>
              <span className="pill">Saldo total <strong>{usd(s.saldoUsd)}</strong></span>
              <span className="pill">Por descontar <strong>{usd(s.pendienteUsd)}</strong> ({num(s.pendientes, 0)})</span>
              <span className={`pill ${s.disponibleUsd < 0 ? 'st-fallido' : 'st-completado'}`}>Disponible <strong>{usd(s.disponibleUsd)}</strong></span>
            </>
          )}
          <span className="pill">Últimos 30 días: {usd(d.ultimos30.gastadoUsd)} en {num(d.ultimos30.creaciones, 0)} creaciones</span>
        </div>
      )}
      <div className="card-sub" style={{ margin: '10px 0 0' }}>
        {d.gasto.configurado
          ? (conError ? `${conError} descuento(s) para revisar.` : pendientes ? `${pendientes} descuento(s) en camino.` : 'Cada creación cobrada se descuenta del saldo con su detalle.')
          : 'Descuento de saldo sin configurar: faltan AJUSTE_CALLER_ID y AJUSTE_API_KEY (en panel y worker). Hasta entonces lo creado queda "por descontar".'}
      </div>
      {d.gasto.errores.length > 0 && (
        <div className="sa-pagos-lista">
          {d.gasto.errores.map((e) => (
            <div key={e.id} className="sa-pagos-fila">
              <span>#{e.generacion_id} {e.preset_nombre} · {e.precio_usd != null ? usd(e.precio_usd) : ''} · <code>{e.referencia}</code><br /><span className="ms-cost">{e.ultimo_error}</span></span>
              <span className="ms-ok-acc">
                <button className="mini-btn" title="En la plataforma ya aparece este descuento: no se vuelve a enviar" onClick={async () => { try { await marcarDescontado(e.id); setMsg({ ok: 'Marcado como descontado.' }); cargar(); } catch (x) { setMsg({ error: x.message }); } }}>✓ Ya se descontó</button>
                <button className="mini-btn" onClick={async () => {
                  if (!window.confirm(`Antes de reintentar, busca "${e.referencia}" en la plataforma de pagos: si ya aparece, reintentar lo descontaría dos veces. ¿No aparece y quieres reintentar?`)) return;
                  try { await reintentarConsumo(e.id); setMsg({ ok: 'Se reintentará en el próximo ciclo.' }); cargar(); } catch (x) { setMsg({ error: x.message }); }
                }}>↻ Reintentar</button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="ms-submit">
        <span className="ms-cost">{msg?.ok && <span style={{ color: 'var(--good-ink)' }}>{msg.ok}</span>}{msg?.error && <span style={{ color: 'var(--critical)' }}>{msg.error}</span>}</span>
        <button className="mini-btn" disabled={!s.configurado} onClick={async () => {
          try { const r = await probarPagos(); setMsg({ ok: `Conexión OK: saldo de ${r.nombre || 'JH'} ${usd(r.saldoUsd)}.` }); cargar(); } catch (e) { setMsg({ error: e.message }); }
        }}>🔌 Probar conexión</button>
      </div>
    </div>
  );
}

function Ajustes({ onGuardado }) {
  const [datos, setDatos] = useState(null);
  const [f, setF] = useState(null);
  const [estado, setEstado] = useState(null);
  const [rec, setRec] = useState({ creditos: '', usd: '', nota: '' });
  const [recEstado, setRecEstado] = useState(null);
  const [acc, setAcc] = useState(null); // mensajes de las acciones de Estado

  const cargar = () => fetchAjustes().then((d) => { setDatos(d); setF({ ...d.ajustes }); }).catch((e) => setEstado({ error: e.message }));
  useEffect(() => { cargar(); }, []);
  if (!f) return <div className="card">{estado?.error ? <div className="ms-errors">{estado.error}</div> : <div className="spinner" />}</div>;

  const costo = Number(f.usd_por_credito) || 0;
  const precioCredito = costo * (1 + (Number(f.margen_pct) || 0) / 100);
  const info = datos.ajustes.costo_info;
  const guardar = async () => {
    setEstado({ guardando: true });
    try {
      const { costo_info: _i, ...cambios } = f; // eslint-disable-line no-unused-vars
      await guardarAjustes(cambios);
      setEstado({ ok: 'Guardado. Aplica a las generaciones y recargas nuevas.' });
      cargar(); onGuardado?.();
    } catch (e) { setEstado({ error: e.message }); }
  };
  const leerAhora = async () => {
    setEstado({ guardando: true });
    try { await actualizarCosto(); setEstado({ ok: 'Precios del proveedor actualizados.' }); cargar(); onGuardado?.(); } catch (e) { setEstado({ error: e.message }); }
  };
  const recargar = async () => {
    setRecEstado({ guardando: true });
    try {
      const cr = Number(rec.creditos);
      const r = await recargaManual({ creditos: cr, usd: rec.usd === '' ? (cr > 0 && precioCredito ? Math.round(cr * precioCredito * 100) / 100 : null) : Number(rec.usd), nota: rec.nota });
      setRecEstado({ ok: `Listo. Saldo de JH: ${cred(r.saldo)} créditos.` });
      setRec({ creditos: '', usd: '', nota: '' }); onGuardado?.();
    } catch (e) { setRecEstado({ error: e.message }); }
  };

  return (
    <div className="grid sa-grid">
      <div className="card">
        <h3>Costo y ganancia</h3>
        <div className="card-sub">Precio por crédito para JH = costo por crédito × (1 + % de ganancia). Es lo que ven todos al generar y al recargar.</div>
        <label className="user-admin-check" style={{ margin: '4px 0 10px' }}>
          <input type="checkbox" checked={Number(f.costo_auto) === 1} onChange={(e) => setF({ ...f, costo_auto: e.target.checked ? 1 : 0 })} />
          Actualizar el costo automáticamente con los precios del proveedor (paquete más caro por crédito, cada 6 h)
        </label>
        <div className="sa-form">
          <label className="filter-field"><span>Costo por crédito (USD){Number(f.costo_auto) === 1 ? ' · automático' : ''}</span>
            <input className="search" type="number" min="0" step="0.000001" value={f.usd_por_credito} disabled={Number(f.costo_auto) === 1}
              onChange={(e) => setF({ ...f, usd_por_credito: e.target.value })} />
          </label>
          <label className="filter-field"><span>% de ganancia</span>
            <input className="search" type="number" min="0" step="1" value={f.margen_pct} onChange={(e) => setF({ ...f, margen_pct: e.target.value })} />
          </label>
          {datos.conexiones.saldoExterno && (
            <label className="filter-field"><span>Saldo negativo permitido (USD, 0 = solo con saldo)</span>
              <input className="search" type="number" min="0" step="1" value={f.saldo_negativo_permitido ?? 0} onChange={(e) => setF({ ...f, saldo_negativo_permitido: e.target.value })} />
            </label>
          )}
          <label className="filter-field"><span>Tope diario por usuario (créditos, 0 = sin tope)</span>
            <input className="search" type="number" min="0" step="1" value={f.limite_diario_creditos} onChange={(e) => setF({ ...f, limite_diario_creditos: e.target.value })} />
          </label>
        </div>

        <div className="sa-calc">
          <span className="filter-lbl">Precios del proveedor:</span>
          {info ? (
            <>
              {info.paquetes.map((p) => <span key={p.creditos} className="pill">{cred(p.creditos)} cr = {usd(p.usd)} ({cred(p.creditos / p.usd)}/$)</span>)}
              <span className="ms-cost">Usado: {info.fuente} · leído {new Date(info.actualizado).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </>
          ) : <span className="ms-cost">Todavía no se leyeron.</span>}
          <button className="mini-btn" onClick={leerAhora} disabled={estado?.guardando}>↻ Leer ahora</button>
        </div>

        {costo > 0 && (
          <div className="sa-ejemplos">
            <span className="pill">1 crédito: costo {usd(costo)} → precio JH <strong>{usd(precioCredito)}</strong></span>
            <span className="pill">21 créditos: costo {usd(21 * costo)} → precio JH <strong>{usd(21 * precioCredito)}</strong> · ganancia {usd(21 * (precioCredito - costo))}</span>
            {EJEMPLOS.map(([t, cr, l]) => (
              <span key={t} className="pill">{l} ({cr} cr): costo {usd(cr * costo)} → precio <strong>{usd(cr * precioCredito)}</strong></span>
            ))}
          </div>
        )}
        {!costo && <div className="banner-off" style={{ marginTop: 12 }}>Sin costo por crédito no hay precios: actívalo automático o ponlo a mano.</div>}

        <div className="ms-submit">
          <span className="ms-cost">{estado?.ok && <span style={{ color: 'var(--good-ink)' }}>{estado.ok}</span>}{estado?.error && <span style={{ color: 'var(--critical)' }}>{estado.error}</span>}</span>
          <button className="btn" onClick={guardar} disabled={estado?.guardando}>{estado?.guardando ? 'Guardando…' : 'Guardar ajustes'}</button>
        </div>
      </div>

      <div className="grid" style={{ gap: 16 }}>
        <div className="card">
          <h3>Estado</h3>
          <div className="card-sub">Solo lo ven los super admin.</div>
          <div className="kpi">
            <div className="kpi-label">Créditos en la cuenta del proveedor</div>
            <div className="kpi-value">{datos.saldo ? cred(datos.saldo.creditos) : '—'}</div>
            <div className="kpi-foot">{datos.saldo ? `Plan ${datos.saldo.plan}` : 'No se pudo leer el saldo'}</div>
          </div>
          <div className="sa-conex">
            <span className={`badge ${datos.conexiones.generador ? 'live' : 'hf-off'}`} title={datos.conexiones.generadorError || ''}>
              <span className="dot" />Generador {datos.conexiones.generador ? 'conectado' : 'desconectado'}{datos.conexiones.generadorCuenta ? ` · ${datos.conexiones.generadorCuenta}` : ''}
            </span>
            <button className="mini-btn" onClick={async () => {
              if (!window.confirm('Se abrirá el inicio de sesión del generador. Entra con la cuenta de la empresa (admin@neboaiconsulting.com) y acepta. El token actual se reemplaza por el nuevo. ¿Continuar?')) return;
              try { const { url } = await reconectarGenerador(); window.location.href = url; } catch (e) { setAcc({ error: e.message }); }
            }}>🔌 Reconectar generador</button>
            <span className={`badge ${datos.conexiones.promptAuto ? 'live' : 'hf-off'}`}><span className="dot" />Prompt automático {datos.conexiones.promptAuto ? 'listo' : 'sin clave'}</span>
          </div>
          <SesionCli cli={datos.conexiones.cli} onCambio={cargar} />
        </div>

        <div className="card">
          <h3>Catálogo de plantillas</h3>
          {datos.catalogo ? (
            <>
              <div className="card-sub">
                {num(datos.catalogo.total, 0)} plantillas · {num(datos.catalogo.base, 0)} clasificadas a mano · {num(datos.catalogo.auto, 0)} automáticas · <strong>{num(datos.catalogo.sinClasificar, 0)} sin clasificar</strong>
              </div>
              <div className="card-sub" style={{ margin: 0 }}>Las nuevas se clasifican solas cada 12 h (encaje con JH, estilo, persona). Sin clasificar entran al final de la galería.</div>
              <div className="ms-submit">
                <span className="ms-cost">{acc?.clasif}</span>
                <button className="mini-btn" disabled={!datos.catalogo.clasificadorListo || !datos.catalogo.sinClasificar} onClick={async () => {
                  try { const r = await clasificarPlantillas(); setAcc({ clasif: r.enCurso ? 'Ya se están clasificando.' : 'Clasificando en segundo plano; recarga en unos minutos.' }); } catch (e) { setAcc({ clasif: e.message }); }
                }}>🏷️ Clasificar nuevas ahora</button>
              </div>
            </>
          ) : <div className="card-sub">No se pudo leer el catálogo.</div>}
        </div>

        <RedesSetup />
        {acc?.error && <div className="ms-errors">{acc.error}</div>}

        <PagosCentral />

        {!datos.conexiones.saldoExterno && <div className="card">
          <h3>Recarga manual a JH</h3>
          <div className="card-sub">Mientras el pago en línea está en pausa: después de cobrar (transferencia, factura), suma los créditos a la billetera de JH. Un número negativo corrige el saldo.</div>
          <div className="sa-form" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className="filter-field"><span>Créditos</span>
              <input className="search" type="number" step="1" value={rec.creditos} onChange={(e) => setRec({ ...rec, creditos: e.target.value })} />
            </label>
            <label className="filter-field"><span>Cobrado (USD)</span>
              <input className="search" type="number" min="0" step="0.01" value={rec.usd}
                placeholder={Number(rec.creditos) > 0 && precioCredito ? (Number(rec.creditos) * precioCredito).toFixed(2) : ''}
                onChange={(e) => setRec({ ...rec, usd: e.target.value })} />
            </label>
          </div>
          <label className="filter-field" style={{ marginTop: 10 }}><span>Nota</span>
            <input className="search" value={rec.nota} placeholder="Transferencia 18-sep" onChange={(e) => setRec({ ...rec, nota: e.target.value })} />
          </label>
          <div className="ms-submit">
            <span className="ms-cost">{recEstado?.ok && <span style={{ color: 'var(--good-ink)' }}>{recEstado.ok}</span>}{recEstado?.error && <span style={{ color: 'var(--critical)' }}>{recEstado.error}</span>}</span>
            <button className="btn" onClick={recargar} disabled={!Number(rec.creditos) || recEstado?.guardando}>Sumar créditos</button>
          </div>
        </div>}
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
