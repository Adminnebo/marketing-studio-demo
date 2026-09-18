import { useCallback, useEffect, useRef, useState } from 'react';
import { sesion, salir, fetchMe, fetchEstado, fetchSaldo, fetchCategorias, fetchCostos, fetchGeneraciones } from './api';
import Login from './components/Login';
import Plantillas from './components/Plantillas';
import Recrear from './components/Recrear';
import Generaciones, { EN_CURSO } from './components/Generaciones';

const TABS = [
  { id: 'plantillas', label: 'Plantillas', icon: '🎨' },
  { id: 'generaciones', label: 'Generaciones', icon: '🗂️' },
];

// Conmutador entre plataformas (mismo que en los otros paneles, con Marketing).
const PLATS = [
  { key: 'inbox', label: 'Conversaciones', icon: '💬', url: 'https://whatsapp.neboaiconsulting.com' },
  { key: 'cotizaciones', label: 'Cotizaciones', icon: '📄', url: 'https://panelcotizaciones.neboaiconsulting.com' },
  { key: 'cobranzas', label: 'Cobranzas', icon: '💰', url: 'https://panelcobranzas.neboaiconsulting.com' },
  { key: 'marketing', label: 'Marketing', icon: '🎬' },
];

function useSesion() {
  const [s, setS] = useState(sesion);
  useEffect(() => {
    const f = () => setS(sesion());
    window.addEventListener('ms-sesion', f);
    return () => window.removeEventListener('ms-sesion', f);
  }, []);
  return s;
}

export default function App() {
  const s = useSesion();
  const [tab, setTab] = useState('plantillas');
  const [me, setMe] = useState(null);
  const [estado, setEstado] = useState(null);
  const [saldo, setSaldo] = useState(null);
  const [categorias, setCategorias] = useState(null);
  const [costos, setCostos] = useState(null);
  const [errorCat, setErrorCat] = useState(null);
  const [abierto, setAbierto] = useState(null); // { preset, categoria, inicial }
  const [gens, setGens] = useState({ items: [], cargando: false, error: null, siguiente: null });
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
    fetchMe().then((m) => {
      setMe(m);
      if (m.creditosVisibles) fetchSaldo().then(setSaldo).catch(() => {});
    }).catch(() => {});
    fetchEstado().then(setEstado).catch(() => {});
    cargarCatalogo();
    setGens((g) => ({ ...g, cargando: true }));
    recargarGens();
    const id = setInterval(() => fetchEstado().then(setEstado).catch(() => {}), 60000);
    return () => clearInterval(id);
  }, [s, cargarCatalogo, recargarGens]);

  // Mientras haya generaciones en curso, refrescar cada 5 s.
  const hayEnCurso = gens.items.some((g) => EN_CURSO.has(g.estado));
  useEffect(() => {
    if (!s || !hayEnCurso) return undefined;
    const id = setInterval(recargarGens, 5000);
    return () => clearInterval(id);
  }, [s, hayEnCurso, recargarGens]);

  if (!s) return <Login />;

  const enCurso = gens.items.filter((g) => EN_CURSO.has(g.estado)).length;
  const desconectado = estado && !estado.conectado;

  const repetir = (g) => setAbierto({
    preset: g.entrada.preset,
    categoria: g.entrada.categoria || 'all',
    inicial: {
      producto: g.entrada.args.product_media_id ? { media_id: g.entrada.args.product_media_id, url: g.entrada.producto?.url, nombre: g.entrada.producto?.nombre || 'Producto' } : null,
      avatar: g.entrada.avatar || null,
      prompt: g.entrada.args.prompt || '',
      url: g.entrada.args.brand_url || '',
    },
  });

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Marketing Studio · Contenido con IA</h1>
        </div>
        <nav className="platsw" aria-label="Cambiar de plataforma">
          {PLATS.map((p) => (
            p.key === 'marketing'
              ? <span key={p.key} className="platsw__it platsw__it--on" title="Estás aquí"><span className="platsw__ic">{p.icon}</span>{p.label}</span>
              : <a key={p.key} className="platsw__it" href={p.url} title={`Ir a ${p.label}`}><span className="platsw__ic">{p.icon}</span>{p.label}</a>
          ))}
        </nav>
        <div className="badges">
          {estado && (
            <span className={`badge ${desconectado ? 'hf-off' : 'live'}`} title={estado.error || (estado.cuenta ? `Cuenta ${estado.cuenta}` : '')}>
              <span className={`dot ${desconectado ? '' : 'pulse'}`} />
              {desconectado ? 'Higgsfield desconectado' : 'Higgsfield conectado'}
            </span>
          )}
          {me?.creditosVisibles && saldo && (
            <span className="badge" title={`Plan ${saldo.subscription_plan_type}`}>
              🪙 {Number(saldo.credits).toLocaleString('es-MX', { maximumFractionDigits: 1 })} créditos
            </span>
          )}
          <button className="btn secondary icon-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label="Cambiar tema">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <span className="badge user-badge" title={s.email}>
            <span className="ub-mail">{s.email}</span>
            <button className="logout-btn" onClick={salir} title="Cerrar sesión">Salir</button>
          </span>
        </div>
      </header>

      {desconectado && (
        <div className="banner-off">
          ⚠️ El panel perdió la conexión con la cuenta de Higgsfield. Las generaciones quedan en cola hasta que se vuelva a autorizar.
          {estado.error && <><br /><small>{estado.error}</small></>}
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="tab-ic">{t.icon}</span>{t.label}
            {t.id === 'generaciones' && enCurso > 0 && <span className="tab-count">{enCurso}</span>}
          </button>
        ))}
      </nav>

      {tab === 'plantillas' && (
        errorCat ? (
          <div className="empty-state">No se pudo cargar el catálogo de Higgsfield: {errorCat}<br />
            <button className="btn secondary" style={{ marginTop: 12 }} onClick={cargarCatalogo}>Reintentar</button>
          </div>
        ) : !categorias ? (
          <div className="loading"><div className="spinner" />Cargando catálogo…</div>
        ) : (
          <Plantillas categorias={categorias} onElegir={(preset, categoria) => setAbierto({ preset, categoria })} />
        )
      )}

      {tab === 'generaciones' && (
        <Generaciones items={gens.items} cargando={gens.cargando} error={gens.error} hayMas={!!gens.siguiente}
          onMas={masGens} onRepetir={repetir} />
      )}

      {abierto && categorias && (
        <Recrear
          key={abierto.preset.id}
          preset={abierto.preset}
          categoria={abierto.categoria}
          categorias={categorias}
          costos={costos}
          inicial={abierto.inicial}
          onEnviada={() => recargarGens()}
          onCerrar={(ir) => { setAbierto(null); if (ir === 'generaciones') setTab('generaciones'); }}
        />
      )}

      <div className="footer">Marketing Studio · generado con Higgsfield usando los créditos del plan de la empresa</div>
    </div>
  );
}
