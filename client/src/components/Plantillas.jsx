import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPlantillas } from '../api';
import { TIPOS, CATEGORIAS_ES } from '@shared/reglas.mjs';
import Portada, { esVideo } from './Portada';

const FORMATOS_ES = {
  'talking-head': 'Talking head', 'with-model': 'Con modelo', standalone: 'Solo producto',
  '2d-product-motion': 'Animación 2D', hypermotion: 'Hypermotion', 'mixed-media': 'Mixed media', saas: 'SaaS', general: 'General',
};

// Galeria de plantillas por categoria (paginada contra Higgsfield via el panel).
export default function Plantillas({ categorias, onElegir }) {
  const [cat, setCat] = useState('all');
  const [formato, setFormato] = useState(null);
  const [q, setQ] = useState('');
  const [paginas, setPaginas] = useState({}); // cat -> { items, cursor, total, cargando, error }
  const fin = useRef(null);

  const actual = paginas[cat] || { items: [], cursor: null, total: 0, cargando: false, error: null, iniciado: false };

  const cargar = async (categoria, cursor) => {
    setPaginas((p) => ({ ...p, [categoria]: { ...(p[categoria] || { items: [] }), cargando: true, error: null, iniciado: true } }));
    try {
      const d = await fetchPlantillas(categoria, cursor);
      setPaginas((p) => {
        const prev = cursor ? (p[categoria]?.items || []) : [];
        const vistos = new Set(prev.map((x) => x.id));
        return { ...p, [categoria]: { items: [...prev, ...d.items.filter((x) => !vistos.has(x.id))], cursor: d.cursor, total: d.total, cargando: false, error: null, iniciado: true } };
      });
    } catch (e) {
      setPaginas((p) => ({ ...p, [categoria]: { ...(p[categoria] || { items: [] }), cargando: false, error: e.message, iniciado: true } }));
    }
  };

  useEffect(() => { if (!paginas[cat]?.iniciado) cargar(cat, null); }, [cat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Carga la siguiente pagina al llegar al final.
  useEffect(() => {
    const el = fin.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && actual.cursor && !actual.cargando && !actual.error) cargar(cat, actual.cursor);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cat, actual.cursor, actual.cargando, actual.error]); // eslint-disable-line react-hooks/exhaustive-deps

  const formatos = (categorias.find((c) => c.slug === cat)?.formats || []);
  // Como el widget oficial: el feed de una categoria trae primero sus plantillas
  // y luego sigue con el resto del catalogo ("spill"). Se muestran separadas.
  const corte = useMemo(() => {
    if (cat === 'all') return actual.items.length;
    const tipos = new Set(formatos.map((f) => (f.type === 'ugc_v2' ? 'ugc' : f.type)).filter(Boolean));
    if (!tipos.size) return actual.items.length;
    const i = actual.items.findIndex((p) => !tipos.has(p.type));
    return i < 0 ? actual.items.length : i;
  }, [cat, formatos, actual.items]);
  const filtrar = (xs) => {
    const t = q.trim().toLowerCase();
    return xs.filter((p) => (!formato || (p.format_slugs || []).includes(formato)) && (!t || (p.name || '').toLowerCase().includes(t)));
  };
  const propias = useMemo(() => filtrar(actual.items.slice(0, corte)), [actual.items, corte, formato, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const otras = useMemo(() => (formato ? [] : filtrar(actual.items.slice(corte))), [actual.items, corte, formato, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const completa = corte < actual.items.length || !actual.cursor;
  const tarjeta = (p) => (
    <button key={p.id} className="ms-card" onClick={() => onElegir(p, cat)} title={p.name}>
      <div className="ms-cover">
        <Portada cover={p.cover_image} alt={p.name} />
        <span className="ms-kind">{TIPOS[p.type] || p.type}</span>
        {esVideo(p.cover_image) && <span className="ms-play">▶ video</span>}
      </div>
      <div className="ms-card-name">{p.name}</div>
    </button>
  );

  return (
    <>
      <div className="ms-bar">
        <div className="ms-chips">
          {categorias.map((c) => (
            <button key={c.slug} className={`dr-preset ${cat === c.slug ? 'active' : ''}`} onClick={() => { setCat(c.slug); setFormato(null); }}>
              {CATEGORIAS_ES[c.slug] || c.name}
            </button>
          ))}
        </div>
        <input className="search" placeholder="Buscar plantilla…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ms-count">
          {cat === 'all' ? (actual.total ? `${actual.items.length} de ${actual.total} plantillas` : '')
            : `${corte}${completa ? '' : '+'} plantillas`}
        </span>
      </div>

      {formatos.length > 1 && (
        <div className="ms-sub">
          <button className={`mini-btn ${!formato ? 'active' : ''}`} onClick={() => setFormato(null)}>Todos</button>
          {formatos.map((f) => (
            <button key={f.slug} className={`mini-btn ${formato === f.slug ? 'active' : ''}`} onClick={() => setFormato(f.slug)}>
              {FORMATOS_ES[f.slug] || f.name}
            </button>
          ))}
        </div>
      )}

      {actual.error && !actual.items.length ? (
        <div className="empty-state">No se pudieron cargar las plantillas: {actual.error}<br />
          <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => cargar(cat, null)}>Reintentar</button>
        </div>
      ) : !actual.items.length && actual.cargando ? (
        <div className="loading"><div className="spinner" />Cargando plantillas…</div>
      ) : (
        <>
          <div className="ms-grid">{propias.map(tarjeta)}</div>
          {!propias.length && !actual.cargando && <div className="empty-state">Ninguna plantilla coincide con el filtro.</div>}
          {otras.length > 0 && (
            <>
              <div className="section-title">Más plantillas de otras categorías</div>
              <div className="ms-grid">{otras.map(tarjeta)}</div>
            </>
          )}
          <div className="ms-more" ref={fin}>
            {actual.cargando && <div className="spinner" />}
            {actual.error && actual.items.length > 0 && (
              <button className="btn secondary" onClick={() => cargar(cat, actual.cursor)}>Reintentar ({actual.error})</button>
            )}
          </div>
        </>
      )}
    </>
  );
}
