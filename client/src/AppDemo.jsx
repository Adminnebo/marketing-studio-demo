import { useCallback, useEffect, useRef, useState } from 'react';
import { iniciarAuth, sesion, salir, fetchMe, fetchGeneraciones, contactoDemo } from './api';
import Login from './components/Login';
import Libre from './components/Libre';
import Generaciones, { EN_CURSO } from './components/Generaciones';
import { IconoLuna, IconoSol } from './components/Encabezado';
import { sinClausula } from './precio';
import './demo.css';

/**
 * La demo para prospectos. Es la misma interfaz del panel —el asistente de
 * "Desde cero" y la galería son los componentes reales— con otra cáscara: se
 * entra con un código, hay una imagen y un video de cortesía, y todo lo demás
 * se ve pero con candado.
 *
 * App.jsx (el panel completo) no se usa aquí y se deja sin tocar a propósito,
 * para poder traer sus arreglos con un merge limpio.
 */

const SECCIONES = [['crear', 'Crear'], ['creaciones', 'Mis creaciones']];
// Lo que existe en la versión completa y aquí solo se enseña.
const COMPLETA = [
  ['🧩', 'Plantillas', 'Casi mil plantillas listas: eliges una, pones tu producto y sale la pieza.'],
  ['🖼️', 'Tus propias plantillas', 'Tus diseños ya publicados, convertidos en receta para repetirlos con otro producto.'],
  ['📅', 'Calendario', 'Todo lo creado y lo programado, día por día.'],
  ['📣', 'Publicar en redes', 'Instagram, Facebook y TikTok desde el mismo panel, con el texto y los hashtags escritos por IA.'],
  ['🏷️', 'Tu logo en cada pieza', 'Marca de agua automática, con la posición que elijas.'],
  ['📈', 'Anuncios', 'Campañas de Meta Ads con sus leads y lo que cuesta cada uno.', 'Próximamente'],
];

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

const Cupo = ({ icono, nombre, c }) => (
  <span className={`demo-cupo ${c?.quedan > 0 ? '' : 'usado'}`} title={c?.quedan > 0 ? `Te queda ${c.quedan} de ${c.max}` : 'Ya la usaste'}>
    <span aria-hidden="true">{icono}</span>{nombre}<b>{c ? `${c.quedan}/${c.max}` : '—'}</b>
  </span>
);

export default function AppDemo() {
  const { cargando: cargandoSesion, s, error: errorAuth } = useSesion();
  const [seccion, setSeccion] = useState('crear');
  const [me, setMe] = useState(null);
  const [gens, setGens] = useState({ items: [], cargando: false, error: null });
  const [libre, setLibre] = useState({ n: 0, inicial: null });
  const [verCompleta, setVerCompleta] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  const gensRef = useRef(gens);
  gensRef.current = gens;

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* sin storage */ }
  };

  const recargar = useCallback(async () => {
    try {
      const d = await fetchGeneraciones();
      setGens({ items: d.items, cargando: false, error: null });
    } catch (e) { setGens((g) => ({ ...g, cargando: false, error: e.message })); }
  }, []);
  const refrescarMe = useCallback(() => fetchMe().then(setMe).catch(() => {}), []);

  useEffect(() => {
    if (!s) { setMe(null); return undefined; }
    refrescarMe();
    setGens((g) => ({ ...g, cargando: true }));
    recargar();
    const id = setInterval(refrescarMe, 60000);
    return () => clearInterval(id);
  }, [s, recargar, refrescarMe]);

  // Mientras haya algo generándose, la galería se refresca sola.
  const hayEnCurso = gens.items.some((g) => EN_CURSO.has(g.estado));
  useEffect(() => {
    if (!s || !hayEnCurso) return undefined;
    const id = setInterval(recargar, 5000);
    return () => { clearInterval(id); refrescarMe(); };
  }, [s, hayEnCurso, recargar, refrescarMe]);

  if (cargandoSesion) return <div className="app"><div className="loading"><div className="spinner" />Cargando…</div></div>;
  if (errorAuth) return <div className="app"><div className="loading" style={{ color: 'var(--critical)' }}>No se pudo iniciar. Recarga la página.</div></div>;
  if (!s) return <Login />;
  if (!me) return <div className="app"><div className="loading"><div className="spinner" />Cargando…</div></div>;

  const cupo = me.demo?.cupo;
  const nadaQueda = cupo && cupo.imagenes.quedan <= 0 && cupo.videos.quedan <= 0;
  const enCurso = gens.items.filter((g) => EN_CURSO.has(g.estado)).length;
  const caduca = me.demo?.caduca ? new Date(me.demo.caduca) : null;
  const dias = caduca ? Math.max(0, Math.ceil((caduca - Date.now()) / 864e5)) : null;

  // "Usar de nuevo": abre el asistente con lo mismo. Si ya no queda cupo, el
  // propio asistente lo dice al llegar a crear.
  const repetir = (g) => {
    const l = g.entrada?.libre;
    if (!l) return;
    setLibre((x) => ({
      n: x.n + 1,
      inicial: {
        tipo: g.preset_tipo === 'libre_imagen' ? 'imagen' : 'video', modelo: l.modelo, prompt: sinClausula(g.entrada.params?.prompt),
        aspecto: l.aspecto, duracion: l.duracion ? String(l.duracion) : '', opciones: l.opciones || {},
        imagen: g.entrada.producto?.media_id ? { media_id: g.entrada.producto.media_id, url: g.entrada.producto.url, nombre: g.entrada.producto.nombre || 'Imagen' } : null,
      },
    }));
    setSeccion('crear');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="app demo">
      <header className="hd">
        <div className="hd-marca">
          <b>Marketing Studio</b>
          <span className="demo-etiqueta">Demo</span>
          <span className="demo-quien">{me.nombre}</span>
        </div>
        <div className="hd-r">
          <Cupo icono="🖼️" nombre="Imagen" c={cupo?.imagenes} />
          <Cupo icono="🎬" nombre="Video" c={cupo?.videos} />
          <button className="hd-ib" onClick={toggleTheme} title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}>
            {theme === 'dark' ? <IconoSol /> : <IconoLuna />}
          </button>
          <button className="mini-btn" onClick={salir}>Salir</button>
        </div>
      </header>

      <nav className="hd-tabs" aria-label="Secciones">
        {SECCIONES.map(([id, t]) => (
          <button key={id} className={`hd-tab ${seccion === id ? 'on' : ''}`} onClick={() => setSeccion(id)}>
            {t}
            {id === 'creaciones' && enCurso > 0 && <span className="hd-n">{enCurso}</span>}
          </button>
        ))}
        <button className="hd-tab demo-tab-completa" onClick={() => setVerCompleta(true)}>🔒 Versión completa</button>
      </nav>

      {me.demo && me.demo.activa === false && (
        <div className="banner-off">La demo está en pausa en este momento. Puedes mirar tus creaciones; para crear, vuelve en un rato.</div>
      )}

      <div className="demo-franja">
        {nadaQueda
          ? <span><strong>Ya usaste tu imagen y tu video de cortesía.</strong> Con la versión completa generas todo lo que necesites, en Full HD y con cualquier modelo.</span>
          : <span><strong>Esta es una demo:</strong> tienes una imagen y un video de cortesía. Verás todas las opciones de la versión completa; las que no entran en la demo llevan un candado.{dias != null && ` Tu código dura ${dias} día${dias === 1 ? '' : 's'} más.`}</span>}
        <button className="btn" onClick={() => setVerCompleta(true)}>Ver la versión completa</button>
      </div>

      {seccion === 'crear' && (
        <>
          <div className="cr-cab">
            <div className="cr-modos" role="tablist" aria-label="Cómo quieres crear">
              <button role="tab" aria-selected="false" className="cr-modo bloq" onClick={() => setVerCompleta(true)}>
                <span aria-hidden="true">🧩</span>Con una plantilla<span className="cr-rec">🔒 Versión completa</span>
              </button>
              <button role="tab" aria-selected="false" className="cr-modo bloq" onClick={() => setVerCompleta(true)}>
                <span aria-hidden="true">🖼️</span>Mis plantillas<span className="cr-rec">🔒</span>
              </button>
              <button role="tab" aria-selected="true" className="cr-modo on">
                <span aria-hidden="true">✨</span>Desde cero
              </button>
            </div>
          </div>
          <Libre key={libre.n} inicial={libre.inicial} saldo={null} saldoUsd={null} rolReal="usuario" demo={me.demo}
            onVer={() => setSeccion('creaciones')}
            onEnviada={() => { recargar(); refrescarMe(); }} />
        </>
      )}

      {seccion === 'creaciones' && (
        <Generaciones items={gens.items} cargando={gens.cargando} error={gens.error} hayMas={false}
          onMas={() => {}} onRepetir={repetir} rol="usuario" onCrear={() => setSeccion('crear')} demo onCompleta={() => setVerCompleta(true)} />
      )}

      {verCompleta && (
        <div className="demo-modal" role="dialog" aria-modal="true" aria-label="Versión completa" onClick={(e) => { if (e.target === e.currentTarget) setVerCompleta(false); }}>
          <div className="demo-modal-caja">
            <h2>La versión completa</h2>
            <p className="demo-modal-sub">Lo que estás probando es el mismo panel que usan nuestros clientes, con el grifo casi cerrado. Esto es lo que se abre:</p>
            <ul className="demo-lista">
              <li><span aria-hidden="true">🎞️</span><div><b>Sin límite de piezas, y en Full HD</b><span>Videos de hasta 30 segundos en 1080p, con todos los modelos de video e imagen.</span></div></li>
              {COMPLETA.map(([ic, t, d, nota]) => <li key={t}><span aria-hidden="true">{ic}</span><div><b>{t}{nota && <em className="demo-pronto">{nota}</em>}</b><span>{d}</span></div></li>)}
            </ul>
            <div className="demo-modal-acc">
              <button className="btn secondary" onClick={() => setVerCompleta(false)}>Seguir probando</button>
              {contactoDemo() && <a className="btn" href={contactoDemo()} target="_blank" rel="noreferrer">Quiero la versión completa</a>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
