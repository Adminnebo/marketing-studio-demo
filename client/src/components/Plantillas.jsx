import { useEffect, useRef, useState } from 'react';
import { fetchPlantillas } from '../api';
import { TIPOS, CATEGORIAS_ES } from '@shared/reglas.mjs';
import { PRODUCTOS, ESTILOS, ORIENTACIONES, SIRVE_PARA, RECOMENDADA } from '@shared/filtros.mjs';
import Portada, { esVideo } from './Portada';

const FORMATOS_ES = {
  'talking-head': 'Talking head', 'with-model': 'Con modelo', standalone: 'Solo producto',
  '2d-product-motion': 'Animación 2D', hypermotion: 'Hypermotion', 'mixed-media': 'Mixed media', saas: 'SaaS', general: 'General',
};
const VACIO = { categoria: 'all', formato: '', sirve: [], producto: [], estilo: [], persona: '', medio: '', orientacion: '', q: '', orden: 'jh' };
const CLAVE = 'ms_filtros';

function cargarFiltros() {
  try { return { ...VACIO, ...JSON.parse(localStorage.getItem(CLAVE) || '{}') }; } catch { return VACIO; }
}

// Chip con conteo; alterna un valor dentro de una lista.
function Chips({ opciones, valores, conteos, onCambio }) {
  const alternar = (k) => onCambio(valores.includes(k) ? valores.filter((x) => x !== k) : [...valores, k]);
  return Object.entries(opciones).map(([k, l]) => {
    const n = conteos?.[k] || 0;
    if (!n && !valores.includes(k)) return null;
    return (
      <button key={k} className={`mini-btn ${valores.includes(k) ? 'active' : ''}`} onClick={() => alternar(k)}>
        {l} <span className="pl-n">{n}</span>
      </button>
    );
  });
}

// Galeria de plantillas: catalogo completo ordenado para JH, con filtros en el servidor.
export default function Plantillas({ categorias, onElegir }) {
  const [f, setF] = useState(cargarFiltros);
  const [qTexto, setQTexto] = useState(f.q);
  const [datos, setDatos] = useState({ items: [], total: 0, cursor: null, facetas: null, cargando: true, error: null });
  const [abiertos, setAbiertos] = useState(false);
  const fin = useRef(null);
  const peticion = useRef(0);

  useEffect(() => { try { localStorage.setItem(CLAVE, JSON.stringify(f)); } catch { /* sin storage */ } }, [f]);
  // La busqueda por texto espera a que dejes de escribir.
  useEffect(() => { const t = setTimeout(() => setF((x) => (x.q === qTexto ? x : { ...x, q: qTexto })), 300); return () => clearTimeout(t); }, [qTexto]);

  const params = (cursor) => ({
    categoria: f.categoria, formato: f.formato, sirve: f.sirve.join(','), producto: f.producto.join(','), estilo: f.estilo.join(','),
    persona: f.persona, medio: f.medio, orientacion: f.orientacion, q: f.q, orden: f.orden, ...(cursor ? { cursor } : {}),
  });

  const cargar = async (cursor) => {
    const n = ++peticion.current;
    setDatos((d) => ({ ...d, cargando: true, error: null, ...(cursor ? {} : { items: [] }) }));
    try {
      const r = await fetchPlantillas(params(cursor));
      if (n !== peticion.current) return;
      setDatos((d) => ({
        items: cursor ? [...d.items, ...r.items] : r.items, total: r.total, cursor: r.cursor,
        facetas: r.facetas || d.facetas, cargando: false, error: null,
      }));
    } catch (e) {
      if (n === peticion.current) setDatos((d) => ({ ...d, cargando: false, error: e.message }));
    }
  };
  useEffect(() => { cargar(null); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = fin.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && datos.cursor && !datos.cargando && !datos.error) cargar(datos.cursor);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [datos.cursor, datos.cargando, datos.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const cambiar = (cambios) => setF((x) => ({ ...x, ...cambios }));
  const formatos = categorias.find((c) => c.slug === f.categoria)?.formats || [];
  const activos = f.sirve.length + f.producto.length + f.estilo.length + !!f.persona + !!f.medio + !!f.orientacion + !!f.formato;
  const fc = datos.facetas;

  return (
    <>
      <div className="pl-intro">
        <div>
          <div className="pl-intro-t">Elige una plantilla</div>
          <div className="pl-intro-s">Toca una para usarla con la foto de tu producto. Las marcadas con <span className="ms-reco-inline">⭐ JH</span> son las que mejor van con los productos de JH.</div>
        </div>
      </div>
      <div className="ms-bar">
        <div className="ms-chips">
          {categorias.map((c) => (
            <button key={c.slug} className={`dr-preset ${f.categoria === c.slug ? 'active' : ''}`} onClick={() => cambiar({ categoria: c.slug, formato: '' })}>
              {CATEGORIAS_ES[c.slug] || c.name}
            </button>
          ))}
        </div>
        <input className="search" placeholder="🔍 Buscar por nombre…" value={qTexto} onChange={(e) => setQTexto(e.target.value)} />
      </div>

      <div className="pl-filtros card">
        <div className="pl-fila">
          <span className="filter-lbl">Para tu producto:</span>
          <Chips opciones={Object.fromEntries(Object.entries(SIRVE_PARA).map(([k, v]) => [k, v.label]))} valores={f.sirve} conteos={fc?.sirve} onCambio={(v) => cambiar({ sirve: v })} />
          <span className="pl-sep" />
          <span className="filter-lbl">Ordenar:</span>
          <button className={`mini-btn ${f.orden === 'jh' ? 'active' : ''}`} onClick={() => cambiar({ orden: 'jh' })}>⭐ Mejores para JH</button>
          <button className={`mini-btn ${f.orden === 'original' ? 'active' : ''}`} onClick={() => cambiar({ orden: 'original' })} title="El orden en que las publica el proveedor">Orden del catálogo</button>
          <button className="mini-btn pl-mas" onClick={() => setAbiertos(!abiertos)}>{abiertos ? 'Menos filtros ▲' : `Más filtros${activos ? ` (${activos})` : ''} ▼`}</button>
          {(activos > 0 || f.q) && !abiertos && (
            <button className="mini-btn danger" onClick={() => { setQTexto(''); setF({ ...VACIO, categoria: f.categoria, orden: f.orden }); }}>
              ✕ Quitar {activos + (f.q ? 1 : 0)} filtro{activos + (f.q ? 1 : 0) > 1 ? 's' : ''}
            </button>
          )}
        </div>
        {abiertos && (
          <>
            {formatos.length > 1 && (
              <div className="pl-fila">
                <span className="filter-lbl">Formato:</span>
                <button className={`mini-btn ${!f.formato ? 'active' : ''}`} onClick={() => cambiar({ formato: '' })}>Todos</button>
                {formatos.map((x) => (
                  <button key={x.slug} className={`mini-btn ${f.formato === x.slug ? 'active' : ''}`} onClick={() => cambiar({ formato: x.slug })}>{FORMATOS_ES[x.slug] || x.name}</button>
                ))}
              </div>
            )}
            <div className="pl-fila">
              <span className="filter-lbl">Estilo:</span>
              <Chips opciones={ESTILOS} valores={f.estilo} conteos={fc?.estilo} onCambio={(v) => cambiar({ estilo: v })} />
            </div>
            <div className="pl-fila">
              <span className="filter-lbl" title="Qué producto aparece en la foto de ejemplo de la plantilla">Producto del ejemplo:</span>
              <Chips opciones={PRODUCTOS} valores={f.producto} conteos={fc?.producto} onCambio={(v) => cambiar({ producto: v })} />
            </div>
            <div className="pl-fila">
              <span className="filter-lbl">Persona:</span>
              {[['', 'Da igual'], ['si', 'Con persona'], ['no', 'Sin persona']].map(([k, l]) => (
                <button key={k} className={`mini-btn ${f.persona === k ? 'active' : ''}`} onClick={() => cambiar({ persona: k })}>{l}</button>
              ))}
              <span className="pl-sep" />
              <span className="filter-lbl">Resultado:</span>
              {[['', 'Todo'], ['foto', 'Foto'], ['video', 'Video']].map(([k, l]) => (
                <button key={k} className={`mini-btn ${f.medio === k ? 'active' : ''}`} onClick={() => cambiar({ medio: k })}>{l}</button>
              ))}
              <span className="pl-sep" />
              <span className="filter-lbl">Forma:</span>
              {[['', 'Todas'], ...Object.entries(ORIENTACIONES)].map(([k, l]) => (
                <button key={k} className={`mini-btn ${f.orientacion === k ? 'active' : ''}`} onClick={() => cambiar({ orientacion: k })}>{l}</button>
              ))}
            </div>
            {activos > 0 && (
              <div className="pl-fila">
                <button className="mini-btn danger" onClick={() => { setF({ ...VACIO, categoria: f.categoria, orden: f.orden, q: f.q }); }}>Quitar filtros</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="ms-count" style={{ margin: '0 0 10px' }}>{datos.total ? `${datos.total} plantillas${activos || f.q || f.categoria !== 'all' ? ' con estos filtros' : ''}` : ''}</div>

      {datos.error && !datos.items.length ? (
        <div className="empty-state">No se pudieron cargar las plantillas: {datos.error}<br />
          <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => cargar(null)}>Reintentar</button>
        </div>
      ) : !datos.items.length && datos.cargando ? (
        <div className="loading"><div className="spinner" />Cargando plantillas…</div>
      ) : !datos.items.length ? (
        <div className="empty-state">Ninguna plantilla coincide con los filtros.<br />
          <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => { setQTexto(''); setF({ ...VACIO, orden: f.orden }); }}>Quitar filtros y búsqueda</button>
        </div>
      ) : (
        <div className="ms-grid">
          {datos.items.map((p) => (
            <button key={p.id} className="ms-card" onClick={() => onElegir(p, f.categoria)} title={p.name}>
              <div className="ms-cover">
                <Portada cover={p.cover_image} alt={p.name} />
                <span className="ms-kind">{TIPOS[p.type] || p.type}</span>
                {esVideo(p.cover_image) && <span className="ms-play">▶ video</span>}
                {p.jh >= RECOMENDADA && <span className="ms-reco" title="Recomendada para los productos de JH">⭐ JH</span>}
                <span className="ms-usar">Usar →</span>
              </div>
              <div className="ms-card-name">{p.name}</div>
            </button>
          ))}
        </div>
      )}
      <div className="ms-more" ref={fin}>
        {datos.cargando && datos.items.length > 0 && <div className="spinner" />}
        {datos.error && datos.items.length > 0 && <button className="btn secondary" onClick={() => cargar(datos.cursor)}>Reintentar ({datos.error})</button>}
      </div>
    </>
  );
}
