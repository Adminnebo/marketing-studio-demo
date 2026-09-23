import { useEffect, useRef, useState } from 'react';
import { fetchLogos } from '../api';

/**
 * Ajustar el logo de una creación: se arrastra sobre la previa y se cambia su tamaño y opacidad.
 * Mientras se ajusta se ve el ORIGINAL (sin logo) con el logo encima; al aplicar, el servidor
 * rehace el archivo de verdad, siempre partiendo del original, así mover mil veces no lo degrada.
 */
const IMAN = 2.2; // % de cercanía para que se pegue solo a una esquina, borde o centro
const esVideoUrl = (u) => /\.(mp4|mov|webm)($|\?)/i.test(u || '');

// Lo que tapan las redes en vertical: los botones a la derecha y el texto del post abajo.
const ZONAS = { derecha: 16, abajo: 24, arriba: 9 };

let _logosCache = null;
const traerLogos = async () => { _logosCache ||= await fetchLogos(); return _logosCache; };
export const olvidarLogos = () => { _logosCache = null; };

// De la esquina donde está hoy al centro del logo en %, para arrancar el arrastre ahí mismo.
function centroDe(posicion, tam, altoPct) {
  if (!posicion || posicion === 'centro') return { cx: 50, cy: 50 };
  const [v, h] = String(posicion).split('-');
  return { cx: h === 'izq' ? 4 + tam / 2 : 96 - tam / 2, cy: v === 'arriba' ? 4 + altoPct / 2 : 96 - altoPct / 2 };
}

const pegar = (v, destinos) => {
  const d = destinos.find((x) => Math.abs(v - x) < IMAN);
  return d == null ? Math.round(v * 10) / 10 : d;
};

export default function AjusteLogo({ gen, indice = 0, onAplicar, onCerrar }) {
  const ok = (gen.resultados || []).filter((r) => r.url);
  const r = ok[Math.min(indice, ok.length - 1)];
  const video = esVideoUrl(r?.url);
  const marca = gen.marca || {};
  const caja = useRef(null);
  const [logos, setLogos] = useState(null);
  const [tam, setTam] = useState(marca.tam || 16);
  const [opacidad, setOpacidad] = useState(marca.opacidad || 90);
  const [pos, setPos] = useState({ cx: marca.cx ?? 85, cy: marca.cy ?? 85 });
  const [arrastrando, setArrastrando] = useState(false);
  const [error, setError] = useState(null);
  const [tamLogo, setTamLogo] = useState({ w: 1, h: 0.4 }); // proporción real del logo

  useEffect(() => { traerLogos().then(setLogos).catch(() => setLogos({ logos: [] })); }, []);
  // Arranca donde está hoy: en su esquina, o donde lo pondría el panel solo.
  useEffect(() => {
    if (marca.cx != null) return;
    const vert = (marca.alto || 0) > (marca.ancho || 0);
    setPos(centroDe(marca.posicion || (vert ? 'arriba-izq' : 'abajo-der'), marca.tam || 16, (marca.tam || 16) * 0.5));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const logo = logos?.logos?.find((l) => l.id === marca.logo_id) || logos?.logos?.find((l) => l.por_defecto) || logos?.logos?.[0];
  const version = marca.version === 'oscuro' && logo?.tiene_oscuro ? 'oscuro' : (logo?.tiene_claro ? 'claro' : 'oscuro');
  const urlLogo = logo ? `/api/logos/${logo.id}/${version}` : null;

  const mover = (e) => {
    const c = caja.current?.getBoundingClientRect();
    if (!c) return;
    const cx = pegar(((e.clientX - c.left) / c.width) * 100, [tam / 2 + 4, 50, 96 - tam / 2, 100 - tam / 2 - 4]);
    const altoPct = (tam * (tamLogo.h / tamLogo.w) * c.width) / c.height;
    const cy = pegar(((e.clientY - c.top) / c.height) * 100, [altoPct / 2 + 4, 50, 100 - altoPct / 2 - 4]);
    setPos({ cx: Math.max(0, Math.min(100, cx)), cy: Math.max(0, Math.min(100, cy)) });
  };
  // Aplicar cierra al toque: el archivo se rehace mientras tanto y la carga se ve en la foto.
  const aplicar = () => onAplicar({ cx: pos.cx, cy: pos.cy, tam, opacidad });

  const vertical = (marca.alto || 0) > (marca.ancho || 0);
  return (
    <div className="aj">
      <div className={`aj-lienzo ${arrastrando ? 'arr' : ''}`} ref={caja}
        onPointerMove={(e) => arrastrando && mover(e)}
        onPointerUp={() => setArrastrando(false)} onPointerLeave={() => setArrastrando(false)}>
        {video ? <video src={r?.url} muted playsInline preload="metadata" /> : <img src={r?.url} alt="" />}
        {vertical && (
          <>
            <span className="aj-zona der" style={{ width: `${ZONAS.derecha}%` }} />
            <span className="aj-zona baja" style={{ height: `${ZONAS.abajo}%` }} />
            <span className="aj-zona alta" style={{ height: `${ZONAS.arriba}%` }} />
          </>
        )}
        {urlLogo && (
          <img className="aj-logo" src={urlLogo} alt="Logo" draggable={false}
            onLoad={(e) => setTamLogo({ w: e.target.naturalWidth || 1, h: e.target.naturalHeight || 0.4 })}
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.releasePointerCapture?.(e.pointerId); setArrastrando(true); mover(e); }}
            style={{ left: `${pos.cx}%`, top: `${pos.cy}%`, width: `${tam}%`, opacity: opacidad / 100 }} />
        )}
        {!logo && logos && <span className="aj-sin">No hay logos cargados. Súbelos en la pestaña Logos.</span>}
      </div>
      <div className="aj-ctrl">
        <label className="filter-field"><span>Tamaño: {tam} % del ancho</span>
          <input type="range" min="5" max="40" value={tam} onChange={(e) => setTam(Number(e.target.value))} />
        </label>
        <label className="filter-field"><span>Opacidad: {opacidad} %</span>
          <input type="range" min="20" max="100" value={opacidad} onChange={(e) => setOpacidad(Number(e.target.value))} />
        </label>
        <div className="aj-nota">Arrastra el logo donde quieras. Se pega solo a las esquinas y al centro.{vertical && ' Las franjas marcan lo que tapan TikTok e Instagram.'}</div>
        {error && <div className="cr-err">{error}</div>}
        <div className="aj-acc">
          <button className="btn secondary" onClick={onCerrar}>Cancelar</button>
          <button className="btn" onClick={aplicar} disabled={!logo}>✓ Aplicar</button>
        </div>
      </div>
    </div>
  );
}
