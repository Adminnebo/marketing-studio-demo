import { useCallback, useEffect, useRef, useState } from 'react';
import { iniciarAuth, sesion, salir, cambiarVerComo, fetchCamilaEstado, fetchMe, fetchEstado, fetchSaldo, fetchCategorias, fetchCostos, fetchGeneraciones, fetchRedesEstado, fetchCuentas, fetchPublicaciones } from './api';
import Login from './components/Login';
import Plantillas from './components/Plantillas';
import Recrear from './components/Recrear';
import Generaciones, { EN_CURSO } from './components/Generaciones';
import Redes from './components/Redes';
import SuperAdmin from './components/SuperAdmin';
import Creditos from './components/Creditos';
import Libre from './components/Libre';
import { cred, usd, sinClausula } from './precio';
import Publicar from './components/Publicar';
import Camila from './components/Camila';
import { Ayuda } from './components/Guia';
import { MenuUsuario, RielPlataformas, IconoLuna, IconoSol, IconoAyuda } from './components/Encabezado';
import { REDES, PUB_EN_CURSO } from '@shared/redes.mjs';

const TABS = [
  { id: 'plantillas', label: 'Crear', icon: '🎨' },
  { id: 'generaciones', label: 'Mis creaciones', icon: '🗂️' },
  { id: 'creditos', label: 'Créditos', icon: '💳' },
  { id: 'redes', label: 'Redes', icon: '📣', min: 'admin' },
  { id: 'superadmin', label: 'Super Admin', icon: '🛡️', min: 'super_admin' },
];
const NIVEL = { usuario: 1, admin: 2, super_admin: 3 };
const ROL_ES = { usuario: 'Usuario', admin: 'Admin', super_admin: 'Super admin' };

// Vuelta del flujo de conexion de una red: ?redes=1&connected=instagram&username=x  (o &error=...)
function leerVueltaRedes() {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('redes')) return null;
  window.history.replaceState(null, '', window.location.pathname);
  const red = REDES[q.get('connected') || q.get('platform')]?.nombre || q.get('connected') || q.get('platform') || 'la red';
  if (q.get('error')) return { ok: false, texto: `No se pudo conectar ${red}. Intenta de nuevo.` };
  if (q.get('connected')) return { ok: true, texto: `✅ ${red} conectado${q.get('username') ? ` (@${q.get('username')})` : ''}.` };
  return { ok: true, texto: 'Conexión terminada.' };
}

// Conmutador entre plataformas (mismo que en los otros paneles, con Marketing).
const PLATS = [
  { key: 'inbox', label: 'Conversaciones', icon: '💬', url: 'https://whatsapp.neboaiconsulting.com' },
  { key: 'cotizaciones', label: 'Cotizaciones', icon: '📄', url: 'https://panelcotizaciones.neboaiconsulting.com' },
  { key: 'cobranzas', label: 'Cobranzas', icon: '💰', url: 'https://panelcobranzas.neboaiconsulting.com' },
  { key: 'marketing', label: 'Marketing', icon: '🎬' },
];

// Sesion de Supabase: { cargando, s } (s = null sin sesion).
function useSesion() {
  const [st, setSt] = useState({ cargando: true, s: null });
  useEffect(() => {
    const f = () => setSt({ cargando: false, s: sesion() });
    iniciarAuth().then(f).catch(() => setSt({ cargando: false, s: null, error: true }));
    window.addEventListener('ms-sesion', f);
    return () => window.removeEventListener('ms-sesion', f);
  }, []);
  return st;
}

export default function App() {
  const { cargando: cargandoSesion, s, error: errorAuth } = useSesion();
  const [sinAcceso, setSinAcceso] = useState(false);
  const [avisoRedes] = useState(leerVueltaRedes);
  const [avisoGenerador] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('generador')) return null;
    window.history.replaceState(null, '', window.location.pathname);
    return q.get('generador') === 'conectado'
      ? { ok: true, texto: `✅ Generador reconectado${q.get('cuenta') ? ` con ${q.get('cuenta')}` : ''}.` }
      : { ok: false, texto: `No se pudo reconectar el generador${q.get('motivo') ? `: ${q.get('motivo')}` : ''}.` };
  });
  const [tab, setTab] = useState(() => (avisoRedes ? 'redes' : avisoGenerador ? 'superadmin' : 'plantillas'));
  const [redesEstado, setRedesEstado] = useState(null);
  const [cuentas, setCuentas] = useState(null);
  const [errorCuentas, setErrorCuentas] = useState(null);
  const [publicaciones, setPublicaciones] = useState(null);
  const [publicando, setPublicando] = useState(null); // { g, indice }
  const [me, setMe] = useState(null);
  const [estado, setEstado] = useState(null);
  const [saldo, setSaldo] = useState(null);
  const [categorias, setCategorias] = useState(null);
  const [costos, setCostos] = useState(null);
  const [errorCat, setErrorCat] = useState(null);
  const [abierto, setAbierto] = useState(null); // { preset, categoria, inicial }
  const [ayuda, setAyuda] = useState(false);
  // Crear: con plantilla (lo facil, por defecto) o desde cero. Se recuerda por navegador.
  const [modoCrear, setModoCrearSt] = useState(() => { try { return localStorage.getItem('ms_modo_crear') || 'plantilla'; } catch { return 'plantilla'; } });
  const setModoCrear = (m) => { setModoCrearSt(m); try { localStorage.setItem('ms_modo_crear', m); } catch { /* sin storage */ } };
  const [libre, setLibre] = useState({ n: 0, inicial: null }); // 'Usar de nuevo' de una generacion libre
  const [gens, setGens] = useState({ items: [], cargando: false, error: null, siguiente: null });
  // Camila (buscar productos de JH; se ve siempre, aunque no este conectada al catalogo). productoListo = foto ya preparada para crear ({ media_id, url, nombre, producto }).
  const [camila, setCamila] = useState({ conectada: true, abierta: false, destino: null });
  const [productoListo, setProductoListo] = useState(null);
  const abrirCamila = useCallback((destino = null) => setCamila((c) => ({ ...c, abierta: true, destino })), []);
  const cerrarCamila = useCallback(() => setCamila((c) => ({ ...c, abierta: false, destino: null })), []);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  const gensRef = useRef(gens);
  gensRef.current = gens;

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* sin storage */ }
  };

  const cargarCatalogo = useCallback(() => {
    setErrorCat(null);
    fetchCategorias().then((d) => setCategorias(d.categorias)).catch((e) => setErrorCat(e.message));
    fetchCostos().then(setCostos).catch(() => {});
  }, []);

  // Refresca la primera pagina de generaciones sin perder las ya cargadas de mas abajo.
  const recargarGens = useCallback(async () => {
    try {
      const d = await fetchGeneraciones();
      setGens((g) => {
        const nuevos = new Map(d.items.map((x) => [x.id, x]));
        const resto = g.items.filter((x) => !nuevos.has(x.id) && x.id < (d.items.at(-1)?.id ?? Infinity));
        return { items: [...d.items, ...resto], cargando: false, error: null, siguiente: g.siguiente ?? d.siguiente };
      });
    } catch (e) {
      setGens((g) => ({ ...g, cargando: false, error: e.message }));
    }
  }, []);

  const cargarRedes = useCallback(async () => {
    try {
      const e = await fetchRedesEstado();
      setRedesEstado(e);
      if (!e.configurado) { setCuentas([]); setPublicaciones([]); return; }
      fetchCuentas().then((d) => { setCuentas(d.cuentas); setErrorCuentas(null); }).catch((err) => { setCuentas([]); setErrorCuentas(err.message); });
      fetchPublicaciones().then((d) => setPublicaciones(d.items)).catch(() => setPublicaciones([]));
    } catch { /* se reintenta al volver a la pestaña */ }
  }, []);

  const masGens = async () => {
    const { siguiente } = gensRef.current;
    if (!siguiente) return;
    setGens((g) => ({ ...g, cargando: true }));
    try {
      const d = await fetchGeneraciones(siguiente);
      setGens((g) => ({ items: [...g.items, ...d.items], cargando: false, error: null, siguiente: d.siguiente }));
    } catch (e) {
      setGens((g) => ({ ...g, cargando: false, error: e.message }));
    }
  };

  useEffect(() => {
    if (!s) return undefined;
    setSinAcceso(false);
    fetchMe().then((m) => {
      setMe(m);
      if (m.rol === 'super_admin') fetchSaldo().then(setSaldo).catch(() => {});
      if (NIVEL[m.rol] >= NIVEL.admin || m.puedePublicar) cargarRedes();
    }).catch((e) => { if (e.sinAcceso) setSinAcceso(true); });
    fetchEstado().then(setEstado).catch(() => {});
    fetchCamilaEstado().then((e) => setCamila((c) => ({ ...c, conectada: !!e.configurado }))).catch(() => {});
    cargarCatalogo();
    setGens((g) => ({ ...g, cargando: true }));
    recargarGens();
    const id = setInterval(() => {
      fetchEstado().then(setEstado).catch(() => {});
      fetchMe().then(setMe).catch(() => {}); // saldo al dia (JH tambien gasta desde sus otros servicios)
    }, 60000);
    return () => clearInterval(id);
  }, [s, cargarCatalogo, recargarGens, cargarRedes]);

  // Mientras haya generaciones en curso, refrescar cada 5 s.
  const hayEnCurso = gens.items.some((g) => EN_CURSO.has(g.estado));
  useEffect(() => {
    if (!s || !hayEnCurso) return undefined;
    const id = setInterval(recargarGens, 5000);
    return () => { clearInterval(id); fetchMe().then(setMe).catch(() => {}); }; // al terminar, saldo al dia (reembolsos)
  }, [s, hayEnCurso, recargarGens]);

  // Publicaciones en curso: refrescar cada 10 s.
  const pubEnCurso = (publicaciones || []).some((p) => PUB_EN_CURSO.has(p.estado));
  useEffect(() => {
    if (!s || !pubEnCurso) return undefined;
    const id = setInterval(() => fetchPublicaciones().then((d) => setPublicaciones(d.items)).catch(() => {}), 10000);
    return () => clearInterval(id);
  }, [s, pubEnCurso]);

  if (cargandoSesion) return <div className="app"><div className="loading"><div className="spinner" />Cargando…</div></div>;
  if (errorAuth) return <div className="app"><div className="loading" style={{ color: 'var(--critical)' }}>No se pudo iniciar. Recarga la página.</div></div>;
  if (!s) return <Login />;
  if (sinAcceso) {
    return (
      <div className="app">
        <div className="noacc">
          <div className="noacc__ic">🔒</div>
          <h1>Sin acceso a Marketing</h1>
          <p>Tu usuario no tiene acceso a este panel. Pídeselo a un super admin.</p>
          <div className="noacc__links">
            {PLATS.filter((p) => p.url).map((p) => <a key={p.key} className="noacc__link" href={p.url}>{p.icon} {p.label} →</a>)}
          </div>
          <button className="noacc__out" onClick={salir}>Cerrar sesión</button>
        </div>
      </div>
    );
  }
  if (!me) return <div className="app"><div className="loading"><div className="spinner" />Cargando…</div></div>;
  // Redes: admin o quien tiene permiso de publicar.
  const verRedes = NIVEL[me.rol] >= NIVEL.admin || !!me.puedePublicar;
  const tabs = TABS.filter((t) => !t.min || NIVEL[me.rol] >= NIVEL[t.min] || (t.id === 'redes' && verRedes));

  const enCurso = gens.items.filter((g) => EN_CURSO.has(g.estado)).length;
  // Saldo: el de la plataforma de pagos (USD) o, si no esta configurada, la billetera local (creditos).
  // Con saldo de Marketing: saldo propio del departamento (USD), recargado por solicitud desde el general.
  const marketing = me.saldoFuente === 'marketing';
  const externo = me.saldoFuente === 'externo';
  const saldoUsd = marketing ? me.saldoUsd : externo ? me.saldoDisponibleUsd : null;
  const sinSaldo = me.rolReal !== 'super_admin' && (marketing || externo
    ? saldoUsd != null && saldoUsd <= -(me.saldoNegativoPermitidoUsd || 0)
    : Number(me.saldo) <= 0);
  const saldoValor = marketing || externo ? saldoUsd : Number(me.saldo);
  const saldoProps = { saldo: me.saldo, saldoUsd, negativoUsd: me.saldoNegativoPermitidoUsd || 0 };
  const desconectado = estado && !estado.conectado;

  const repetir = (g) => (g.entrada?.libre ? (() => {
    const l = g.entrada.libre;
    setLibre((x) => ({
      n: x.n + 1,
      inicial: {
        tipo: g.preset_tipo === 'libre_imagen' ? 'imagen' : 'video', modelo: l.modelo, prompt: sinClausula(g.entrada.params?.prompt),
        aspecto: l.aspecto, duracion: l.duracion ? String(l.duracion) : '', opciones: l.opciones || {},
        imagen: g.entrada.producto?.media_id ? { media_id: g.entrada.producto.media_id, url: g.entrada.producto.url, nombre: g.entrada.producto.nombre || 'Imagen' } : null,
      },
    }));
    setTab('plantillas');
    setModoCrear('cero');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  })() : setAbierto({
    preset: g.entrada.preset,
    categoria: g.entrada.categoria || 'all',
    inicial: {
      producto: g.entrada.args.product_media_id ? { media_id: g.entrada.args.product_media_id, url: g.entrada.producto?.url, nombre: g.entrada.producto?.nombre || 'Producto' } : null,
      avatar: g.entrada.avatar || null,
      prompt: g.entrada.texto_usuario ?? sinClausula(g.entrada.args.prompt),
      personalizacion: g.entrada.personalizacion || null,
      url: g.entrada.args.brand_url || '',
    },
  }));

  return (
    <div className="app">
      <header className="hd">
        <div className="hd-marca">
          <b>Marketing</b>
          <MenuUsuario me={me} estado={estado} saldoGenerador={saldo} onSalir={salir} onSuperAdmin={() => setTab('superadmin')} />
        </div>
        <nav className="hd-tabs" aria-label="Secciones">
          {tabs.map((t) => (
            <button key={t.id} className={`hd-tab ${tab === t.id ? 'on' : ''}`} onClick={() => { setTab(t.id); if (t.id === 'redes') cargarRedes(); }}>
              {t.label}
              {t.id === 'generaciones' && enCurso > 0 && <span className="hd-n">{enCurso}</span>}
              {t.id === 'creditos' && me.solicitudesPendientes > 0 && <span className="hd-n" title="Solicitudes de recarga por aprobar">{me.solicitudesPendientes}</span>}
              {t.id === 'redes' && cuentas?.length > 0 && <span className="hd-n gris">{cuentas.length}</span>}
            </button>
          ))}
        </nav>
        <div className="hd-r">
          <button className={`hd-saldo ${saldoValor != null && saldoValor < 0 ? 'neg' : ''}`} onClick={() => setTab('creditos')}
            title={marketing ? 'Saldo de Marketing' : externo ? `Saldo total ${me.saldoUsd != null ? usd(me.saldoUsd) : '—'}${me.saldoPendienteUsd ? ` · ${usd(me.saldoPendienteUsd)} por descontar` : ''}` : 'Saldo de créditos de JH'}>
            <span className="hd-saldo-l">Saldo</span>
            {marketing || externo ? (
              <b className="num">{saldoUsd != null ? usd(saldoUsd) : '—'}</b>
            ) : (
              <>
                <b className="num">{cred(me.saldo)} cr</b>
                {me.precios?.precioCredito != null && <span className="hd-saldo-usd num">≈ {usd(Number(me.saldo) * me.precios.precioCredito)}</span>}
              </>
            )}
            {tab !== 'creditos' && <span className="hd-saldo-r">{marketing ? 'Pedir recarga' : 'Recargar'}</span>}
          </button>
          <button className="hd-ib" onClick={toggleTheme} title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}>
            {theme === 'dark' ? <IconoSol /> : <IconoLuna />}
          </button>
        </div>
      </header>

      {me.verComo && (
        <div className="vc-banner">
          👁️ Estás viendo el panel como <strong>{ROL_ES[me.verComo]}</strong>: pestañas, botones y precios como los ve ese rol. Lo que generes acá no se cobra a la billetera de JH.
          <button className="btn" onClick={() => cambiarVerComo('')}>Volver a Super admin</button>
        </div>
      )}

      {me.rolReal === 'super_admin' && saldo && Number(saldo.credits) < 100 && (
        <div className="banner-off">
          ⚠️ La cuenta del generador tiene solo <strong>{Number(saldo.credits).toLocaleString('es-MX', { maximumFractionDigits: 1 })} créditos</strong>. Las creaciones que cuesten más se rechazan hasta recargarla en el proveedor (plan o paquete de créditos).
        </div>
      )}

      {avisoGenerador && <div className={avisoGenerador.ok ? 'ms-ok' : 'banner-off'} style={{ marginBottom: 16 }}>{avisoGenerador.texto}</div>}

      {desconectado && (
        <div className="banner-off">
          ⚠️ El panel perdió la conexión con el generador de contenido. Las generaciones quedan en cola hasta que se restablezca{me.rol === 'super_admin' ? <>: reconéctalo en <button className="mini-btn" onClick={() => setTab('superadmin')}>🛡️ Super Admin</button></> : '; avísale al administrador.'}
        </div>
      )}

      {sinSaldo && tab !== 'creditos' && (
        <div className="aviso-saldo">
          <span>💳 {marketing
            ? <><strong>El saldo de Marketing está en {usd(saldoUsd)}.</strong> Puedes explorar todo; para crear, pide una recarga en Créditos (la aprueba una persona autorizada de JH).</>
            : externo
            ? <><strong>Tu saldo está en {usd(me.saldoDisponibleUsd)}.</strong> Puedes explorar todo, pero para crear primero hay que recargar.</>
            : <><strong>Todavía no tienes créditos.</strong> Puedes explorar todo, pero para generar primero hay que recargar saldo.</>}</span>
          <button className="btn" onClick={() => setTab('creditos')}>{marketing ? 'Pedir recarga' : 'Recargar'}</button>
        </div>
      )}
      {externo && me.errorSaldo && <div className="banner-off">{me.errorSaldo}</div>}

      {tab === 'plantillas' && (
        errorCat ? (
          <div className="empty-state">No se pudo cargar el catálogo: {errorCat}<br />
            <button className="btn secondary" style={{ marginTop: 12 }} onClick={cargarCatalogo}>Reintentar</button>
          </div>
        ) : !categorias ? (
          <div className="loading"><div className="spinner" />Cargando catálogo…</div>
        ) : (
          <>
            <div className="cr-cab">
              <div className="cr-modos" role="tablist" aria-label="Cómo quieres crear">
                <button role="tab" aria-selected={modoCrear === 'plantilla'} className={`cr-modo ${modoCrear === 'plantilla' ? 'on' : ''}`} onClick={() => setModoCrear('plantilla')}>
                  <span aria-hidden="true">🧩</span>Con una plantilla<span className="cr-rec">Recomendado</span>
                </button>
                <button role="tab" aria-selected={modoCrear === 'cero'} className={`cr-modo ${modoCrear === 'cero' ? 'on' : ''}`} onClick={() => setModoCrear('cero')}>
                  <span aria-hidden="true">✨</span>Desde cero
                </button>
              </div>
              <button className="cr-ayuda" onClick={() => setAyuda(true)} title="Cómo usar el panel"><IconoAyuda />Ayuda</button>
            </div>
            {productoListo ? (
              <div className="cm-listo-bar">
                <img src={productoListo.url} alt="" />
                <div className="cm-listo-bar-t">
                  <strong>📦 Producto listo para crear</strong>
                  <span>{productoListo.nombre}{productoListo.producto?.codigo ? ` · Cód. ${productoListo.producto.codigo}` : ''}</span>
                </div>
                <div className="cm-listo-bar-acc">
                  <button className="mini-btn" onClick={() => abrirCamila()}>Cambiar</button>
                  <button className="mini-btn" onClick={() => setProductoListo(null)}>Quitar</button>
                </div>
              </div>
            ) : (
              <div className="cm-listo-bar cm-invita">
                <div className="cm-listo-bar-t">
                  <strong>¿No tienes la foto del producto?</strong>
                  <span>Pídesela a Camila: busca en el catálogo de JH y la deja lista para crear.</span>
                </div>
                <button className="cm-buscar-btn" onClick={() => abrirCamila()}><span className="cm-av">C</span>Buscar producto</button>
              </div>
            )}
            {modoCrear === 'cero' ? (
              <Libre key={libre.n} inicial={libre.inicial} {...saldoProps} rol={me.rol} rolReal={me.rolReal}
                productoListo={productoListo} onBuscarCamila={() => abrirCamila('libre')}
                onVer={() => setTab('generaciones')} onRecargar={() => setTab('creditos')}
                onEnviada={() => { recargarGens(); fetchMe().then(setMe).catch(() => {}); }} />
            ) : (
              <Plantillas categorias={categorias} onElegir={(preset, categoria) => setAbierto({ preset, categoria })} />
            )}
          </>
        )
      )}

      {tab === 'generaciones' && (
        <Generaciones items={gens.items} cargando={gens.cargando} error={gens.error} hayMas={!!gens.siguiente}
          onMas={masGens} onRepetir={repetir} rol={me.rol} onCrear={() => setTab('plantillas')}
          onPublicar={me.puedePublicar ? (g, indice) => setPublicando({ g, indice }) : null} />
      )}

      {tab === 'creditos' && <Creditos recarga={me.saldo} onRecargada={() => fetchMe().then(setMe).catch(() => {})} />}

      {tab === 'superadmin' && me.rol === 'super_admin' && <SuperAdmin yo={me.email} onAjustes={() => fetchMe().then(setMe).catch(() => {})} />}

      {tab === 'redes' && verRedes && (
        <Redes estado={redesEstado} cuentas={cuentas} errorCuentas={errorCuentas} publicaciones={publicaciones} administrar={NIVEL[me.rol] >= NIVEL.admin}
          aviso={avisoRedes} onRecargar={cargarRedes} />
      )}

      {publicando && (
        <Publicar
          generacion={publicando.g}
          indice={publicando.indice}
          cuentas={cuentas}
          onPublicada={() => fetchPublicaciones().then((d) => setPublicaciones(d.items)).catch(() => {})}
          onCerrar={(ir) => { setPublicando(null); if (ir === 'redes') setTab('redes'); }}
        />
      )}

      {abierto && categorias && (
        <Recrear
          key={abierto.preset.id}
          preset={abierto.preset}
          categoria={abierto.categoria}
          categorias={categorias}
          costos={costos}
          precios={me.precios}
          {...saldoProps}
          onRecargar
          rol={me.rol}
          rolReal={me.rolReal}
          inicial={abierto.inicial}
          productoListo={productoListo}
          onBuscarCamila={() => abrirCamila('plantilla')}
          onEnviada={() => { recargarGens(); fetchMe().then(setMe).catch(() => {}); }}
          onCerrar={(ir) => { setAbierto(null); if (ir === 'generaciones' || ir === 'creditos') setTab(ir); }}
        />
      )}

      {ayuda && <Ayuda onCerrar={() => setAyuda(false)} />}

      <Camila abierta={camila.abierta} destino={camila.destino} conectada={camila.conectada} usado={productoListo?.producto?.codigo}
        burbuja={!abierto && !publicando && !ayuda} onAbrir={() => abrirCamila()} onCerrar={cerrarCamila} onUsado={setProductoListo}
        onIr={(modo) => { setTab('plantillas'); setModoCrear(modo); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />

      <RielPlataformas plataformas={PLATS} />

      <div className="footer">Marketing · contenido generado con IA · <button className="linklike" onClick={() => setAyuda(true)}>Guía rápida</button></div>
    </div>
  );
}
