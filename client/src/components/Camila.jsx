import { useEffect, useRef, useState } from 'react';
import { fetchCamilaConversacion, mensajeCamila, usarProductoCamila } from '../api';
import Dictar from './Dictar';
import './camila.css';

const EJEMPLOS = ['Breaker Square D de 20 amperios', 'Tomacorriente doble blanco', 'Lámpara LED panel 60x60', 'Cable THHN #12 rojo'];
// Lo que se ve mientras Camila busca (la busqueda con reintentos tarda unos segundos).
const ESTADOS = ['Entendiendo lo que buscas…', 'Buscando en el catálogo de JH…', 'Comparando marcas y medidas…', 'Revisando cuáles tienen foto…', 'Eligiendo las mejores opciones…', 'Ya casi…'];

const rd = (n) => `RD$ ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const unidad = (u) => (u ? String(u).toLowerCase() : 'und');

function Avatar({ chico = false }) {
  return <span className={`cm-av ${chico ? 'chico' : ''}`} aria-hidden="true">C</span>;
}

// Tarjeta de un producto: foto (o aviso de que no tiene), datos y "Usar para crear".
function Producto({ p, usando, usado, onUsar, onVer }) {
  const listo = usado === p.codigo;
  const hayFoto = !!(p.foto || p.tiene_imagen); // tiene_imagen: la busqueda la ve aunque el indice aun no
  return (
    <div className={`cm-prod ${listo ? 'listo' : ''} ${hayFoto ? '' : 'sin-foto'}`}>
      <button type="button" className="cm-prod-foto" onClick={() => p.foto && onVer(p)} disabled={!p.foto} title={p.foto ? 'Ver la foto en grande' : 'Este producto no tiene foto'}>
        {p.foto ? <img src={p.foto} alt={p.descripcion} loading="lazy" /> : <span className="cm-sinfoto"><span>📷</span>{hayFoto ? 'Foto disponible' : 'Sin foto'}</span>}
      </button>
      <div className="cm-prod-info">
        <div className="cm-prod-nom">{p.descripcion}</div>
        <div className="cm-prod-meta">
          <span>Cód. <strong>{p.codigo}</strong></span>
          {p.marca && <span>{p.marca}</span>}
        </div>
        <div className="cm-prod-meta">
          {p.precio != null && <span className="cm-precio">{rd(p.precio)}<small> / {unidad(p.unidad)}</small></span>}
          {p.inventario != null && <span className={p.inventario > 0 ? '' : 'cm-agotado'}>{p.inventario > 0 ? `${Number(p.inventario).toLocaleString('es-DO')} en inventario` : 'Sin inventario'}</span>}
        </div>
        <div className="cm-prod-acc">
          {listo ? (
            <span className="cm-listo">✓ Listo para crear</span>
          ) : (
            <button className="btn cm-usar" disabled={!hayFoto || !!usando} onClick={() => onUsar(p)}>
              {usando === p.codigo ? 'Preparando…' : hayFoto ? 'Usar para crear' : 'Sin foto para usar'}
            </button>
          )}
          {p.ficha && <a className="linklike" href={p.ficha} target="_blank" rel="noreferrer">📄 Ficha técnica</a>}
        </div>
      </div>
    </div>
  );
}

/**
 * Mini chat con Camila: se le pide un producto, ella lo busca en el catalogo de JH,
 * dice si tiene foto y con "Usar para crear" la foto queda lista en el panel.
 * destino: 'libre' | 'plantilla' cuando se abrio desde un paso "Tu foto" (usar = aplicar y cerrar).
 */
export default function Camila({ abierta, destino, usado, conectada = true, onCerrar, onUsado, onIr }) {
  const [conv, setConv] = useState({ id: null, mensajes: [] });
  const [cargada, setCargada] = useState(false);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [estado, setEstado] = useState(0);
  const [error, setError] = useState(null); // { texto, reintentar }
  const [usando, setUsando] = useState(null);
  const [recien, setRecien] = useState(null); // producto recien preparado (para ofrecer cómo crear)
  const [viendo, setViendo] = useState(null);
  const lista = useRef(null);
  const caja = useRef(null);

  // La primera vez que se abre, retoma la ultima conversacion.
  useEffect(() => {
    if (!abierta || cargada) return;
    fetchCamilaConversacion()
      .then((d) => { if (d.conversacion) setConv({ id: d.conversacion.id, mensajes: d.conversacion.mensajes }); })
      .catch(() => {})
      .finally(() => setCargada(true));
  }, [abierta, cargada]);

  useEffect(() => { if (abierta) setTimeout(() => caja.current?.focus(), 50); }, [abierta]);
  useEffect(() => { if (!abierta) { setRecien(null); setViendo(null); } }, [abierta]);

  // Siempre abajo al llegar algo nuevo.
  useEffect(() => { lista.current?.scrollTo({ top: lista.current.scrollHeight, behavior: 'smooth' }); }, [conv.mensajes.length, enviando, error, recien]);

  useEffect(() => {
    if (!enviando) return undefined;
    setEstado(0);
    const id = setInterval(() => setEstado((e) => Math.min(e + 1, ESTADOS.length - 1)), 3500);
    return () => clearInterval(id);
  }, [enviando]);

  useEffect(() => {
    if (!abierta) return undefined;
    const f = (e) => { if (e.key === 'Escape') (viendo ? setViendo(null) : onCerrar()); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [abierta, viendo, onCerrar]);

  const enviar = async (t = texto) => {
    const limpio = t.trim();
    if (!limpio || enviando) return;
    setTexto('');
    setError(null);
    setRecien(null);
    const provisional = { id: `tmp${Date.now()}`, rol: 'usuario', texto: limpio };
    setConv((c) => ({ ...c, mensajes: [...c.mensajes, provisional] }));
    setEnviando(true);
    if (!conectada) {
      // Sin catalogo todavia: se ve como funciona, pero Camila avisa en vez de buscar.
      await new Promise((ok) => setTimeout(ok, 900));
      setConv((c) => ({ ...c, mensajes: [...c.mensajes, { id: `tmpc${Date.now()}`, rol: 'camila', texto: 'Todavía no estoy conectada al catálogo de JH, así que no puedo buscar productos. En cuanto me conecten, te los busco aquí mismo 🙂' }] }));
      setEnviando(false);
      return;
    }
    try {
      const r = await mensajeCamila({ conversacionId: conv.id, texto: limpio });
      setConv((c) => ({ id: r.conversacionId, mensajes: [...c.mensajes.filter((m) => m.id !== provisional.id), r.usuario, r.camila] }));
    } catch (e) {
      setConv((c) => ({ ...c, mensajes: c.mensajes.filter((m) => m.id !== provisional.id) }));
      setError({ texto: e.message, reintentar: limpio });
    } finally {
      setEnviando(false);
      setTimeout(() => caja.current?.focus(), 30);
    }
  };

  const usar = async (p) => {
    setUsando(p.codigo);
    setError(null);
    try {
      const r = await usarProductoCamila({ codigo: p.codigo, conversacionId: conv.id });
      onUsado(r);
      if (destino) onCerrar();
      else setRecien(r);
    } catch (e) {
      setError({ texto: e.message });
    } finally { setUsando(null); }
  };

  const nueva = () => { setConv({ id: null, mensajes: [] }); setError(null); setRecien(null); setTexto(''); caja.current?.focus(); };

  if (!abierta) return null;

  const ultima = conv.mensajes.at(-1);
  const vacia = cargada && conv.mensajes.length === 0 && !enviando;

  return (
    <>
      <div className="cm-velo" onClick={onCerrar} />
      <aside className="cm-panel" role="dialog" aria-label="Camila, buscar productos">
        <header className="cm-cab">
          <Avatar />
          <div className="cm-cab-t">
            <strong>Camila</strong>
            {conectada
              ? <span><span className="dot pulse" /> Busca en el catálogo de JH</span>
              : <span><span className="dot apagado" /> Todavía sin conexión al catálogo</span>}
          </div>
          {conv.mensajes.length > 0 && <button className="mini-btn" onClick={nueva} disabled={enviando} title="Empezar otra búsqueda">↺ Nueva</button>}
          <button className="ms-x" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </header>

        {!conectada && (
          <div className="cm-aviso">🔌 Camila todavía no está conectada al catálogo de JH. Ya puedes ver cómo funciona; muy pronto va a buscar productos de verdad.</div>
        )}

        {destino && (
          <div className="cm-destino">
            {destino === 'libre' ? 'Elige un producto y su foto se pone en "Tu foto" del paso a paso.' : 'Elige un producto y su foto se pone en la plantilla que tienes abierta.'}
          </div>
        )}

        <div className="cm-lista" ref={lista} aria-live="polite">
          {!cargada && <div className="loading"><div className="spinner" /></div>}

          {vacia && (
            <div className="cm-hola">
              <Avatar />
              <h3>¡Hola! Soy Camila 👋</h3>
              <p>Dime qué producto necesitas, como se lo pedirías a alguien de la tienda. Lo busco en el catálogo de JH, te digo si tiene foto y la dejo lista para crear.</p>
              <div className="cm-lbl">Prueba con:</div>
              <div className="cm-chips">
                {EJEMPLOS.map((e) => <button key={e} className="cm-chip" onClick={() => enviar(e)}>{e}</button>)}
              </div>
              <div className="cm-tip">También sirve el código: <em>"el 305400"</em>.</div>
            </div>
          )}

          {conv.mensajes.map((m) => (
            m.rol === 'usuario' ? (
              <div key={m.id} className="cm-fila yo"><div className="cm-burbuja yo">{m.texto}</div></div>
            ) : (
              <div key={m.id} className="cm-fila">
                <Avatar chico />
                <div className="cm-resp">
                  <div className="cm-burbuja">{m.texto}</div>
                  {m.productos?.length > 0 && (
                    <div className="cm-prods">
                      {m.productos.map((p) => <Producto key={p.codigo} p={p} usando={usando} usado={usado} onUsar={usar} onVer={setViendo} />)}
                    </div>
                  )}
                </div>
              </div>
            )
          ))}

          {enviando && (
            <div className="cm-fila">
              <Avatar chico />
              <div className="cm-burbuja cm-pensando">
                <span className="cm-puntos"><i /><i /><i /></span>
                <span>{ESTADOS[estado]}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="cm-error">
              {error.texto}
              {error.reintentar && <button className="linklike" onClick={() => enviar(error.reintentar)}>Reintentar</button>}
            </div>
          )}

          {!enviando && ultima?.rol === 'camila' && ultima.sugerencias?.length > 0 && !recien && (
            <div className="cm-chips cm-sug">
              {ultima.sugerencias.map((s) => <button key={s} className="cm-chip" onClick={() => enviar(s)}>{s}</button>)}
            </div>
          )}
        </div>

        {recien && (
          <div className="cm-recien">
            <img src={recien.url} alt="" />
            <div className="cm-recien-t">
              <strong>✅ Listo para crear</strong>
              <span>{recien.nombre}</span>
            </div>
            <div className="cm-recien-acc">
              <button className="btn" onClick={() => { onIr('plantilla'); onCerrar(); }}>🧩 Elegir una plantilla</button>
              <button className="btn secondary" onClick={() => { onIr('cero'); onCerrar(); }}>✨ Crear desde cero</button>
            </div>
          </div>
        )}

        <form className="cm-pie" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
          <textarea ref={caja} className="cm-caja" rows={1} maxLength={600} value={texto} disabled={enviando}
            placeholder="Ej.: breaker de 2 polos 40 amperios Siemens"
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }} />
          <div className="cm-pie-acc">
            <Dictar valor={texto} onCambiar={setTexto} max={600} />
            <button className="btn cm-enviar" type="submit" disabled={!texto.trim() || enviando}>Buscar ➤</button>
          </div>
        </form>

        {viendo && (
          <div className="cm-lupa" onClick={() => setViendo(null)}>
            <img src={viendo.foto} alt={viendo.descripcion} />
            <div className="cm-lupa-t">{viendo.descripcion} · Cód. {viendo.codigo}</div>
          </div>
        )}
      </aside>
    </>
  );
}
