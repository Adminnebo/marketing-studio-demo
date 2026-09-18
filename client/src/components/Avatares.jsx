import { useEffect, useState } from 'react';
import { fetchAvatares } from '../api';

// Grilla de avatares de Marketing Studio (los de Higgsfield + los propios de la cuenta).
export default function Avatares({ seleccionado, onElegir, onVolver }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState({});
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [genero, setGenero] = useState('');

  const cargar = async (desde) => {
    setCargando(true);
    setError(null);
    try {
      const d = await fetchAvatares(desde || {});
      setItems((prev) => (desde ? [...prev, ...d.items] : d.items));
      setCursor({ preset_cursor: d.preset_cursor, user_cursor: d.user_cursor });
      setHayMas(d.has_more);
    } catch (e) {
      setError(e.message);
    } finally {
      setCargando(false);
    }
  };
  useEffect(() => { cargar(null); }, []);

  const visibles = items.filter((a) => !genero || a.gender === genero);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="ms-modal__head">
        <div>
          <h2>Elige un avatar</h2>
          <div className="ms-chips">
            {[['', 'Todos'], ['female', 'Mujeres'], ['male', 'Hombres']].map(([g, l]) => (
              <button key={g} className={`mini-btn ${genero === g ? 'active' : ''}`} onClick={() => setGenero(g)}>{l}</button>
            ))}
          </div>
        </div>
        <button className="btn secondary" onClick={onVolver}>← Volver</button>
      </div>
      {error && <div className="ms-errors">{error}</div>}
      <div className="ms-avatars">
        {visibles.map((a) => (
          <button key={a.type + a.id} className={`ms-avatar ${seleccionado?.id === a.id ? 'sel' : ''}`} onClick={() => onElegir(a)} title={a.name}>
            <img src={a.preview_url} alt={a.name} loading="lazy" />
            <span>{a.type === 'custom' ? '★ ' : ''}{a.name}</span>
          </button>
        ))}
      </div>
      {cargando ? <div className="spinner" /> : hayMas && (
        <button className="btn secondary" onClick={() => cargar(cursor)}>Cargar más avatares</button>
      )}
    </div>
  );
}
