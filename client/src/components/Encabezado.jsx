import { useEffect, useRef, useState } from 'react';
import { cambiarVerComo } from '../api';

const ROL_ES = { usuario: 'Usuario', admin: 'Admin', super_admin: 'Super admin' };

// Iconos de linea (sin emojis) para el encabezado.
const Svg = ({ children, t = 16 }) => (
  <svg width={t} height={t} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const IconoLuna = () => <Svg><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></Svg>;
export const IconoSol = () => <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>;
export const IconoAyuda = () => <Svg t={15}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01" /></Svg>;
const IconoAbajo = () => <Svg t={13}><path d="m7 10 5 5 5-5" /></Svg>;
const ICONOS_PLAT = {
  inbox: <Svg t={19}><path d="M5 18.5V6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9z" /><path d="M8.5 9h7M8.5 12.5h4.5" /></Svg>,
  cotizaciones: <Svg t={19}><path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" /><path d="M14 3.5v4h4M9 12h6M9 15.5h6" /></Svg>,
  cobranzas: <Svg t={19}><rect x="3.5" y="6" width="17" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6.5 9.5v5M17.5 9.5v5" /></Svg>,
  marketing: <Svg t={19}><rect x="3.5" y="6.5" width="12" height="11" rx="2" /><path d="m15.5 10.5 5-3v9l-5-3" /></Svg>,
};

// Nombre de quien entro, junto a "Marketing". El menu trae su correo, cerrar sesion y,
// SOLO para un super admin real, el estado del generador y "Ver como".
export function MenuUsuario({ me, estado, saldoGenerador, onSalir, onSuperAdmin }) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!caja.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', esc); };
  }, [abierto]);
  const superAdmin = me.rolReal === 'super_admin';
  const desconectado = estado && !estado.conectado;
  return (
    <div className="hd-user" ref={caja}>
      <button className="hd-user-b" onClick={() => setAbierto(!abierto)} aria-haspopup="true" aria-expanded={abierto}>
        {me.nombre || me.email} · {ROL_ES[me.rol]}{me.verComo && ' (vista)'} <IconoAbajo />
      </button>
      {abierto && (
        <div className="hd-menu" role="menu">
          <div className="hd-menu-lbl">{me.email}</div>
          {superAdmin && (
            <>
              <hr />
              <div className="hd-menu-lbl">Solo super admin</div>
              <div className="hd-menu-info">
                <span className={`hd-dot ${desconectado ? 'off' : ''}`} />
                {desconectado ? 'Generador desconectado' : 'Generador conectado'}
                {saldoGenerador && <span className="hd-menu-sub num">· cuenta: {Number(saldoGenerador.credits).toLocaleString('es-MX', { maximumFractionDigits: 1 })} cr</span>}
              </div>
              {desconectado && <button role="menuitem" onClick={() => { setAbierto(false); onSuperAdmin(); }}>Reconectar en Super Admin</button>}
              <label className="hd-menu-vc">
                <span>Ver el panel como</span>
                <select value={me.verComo || ''} onChange={(e) => cambiarVerComo(e.target.value)}>
                  <option value="">Super admin</option>
                  <option value="admin">Admin</option>
                  <option value="usuario">Usuario</option>
                </select>
              </label>
            </>
          )}
          <hr />
          <button role="menuitem" onClick={onSalir}>Cerrar sesión</button>
        </div>
      )}
    </div>
  );
}

// Accesos a las otras plataformas: columna vertical fija abajo a la izquierda.
export function RielPlataformas({ plataformas }) {
  return (
    <nav className="riel" aria-label="Cambiar de plataforma">
      {plataformas.map((p) => (
        p.url ? (
          <a key={p.key} className="riel-it" href={p.url}>{ICONOS_PLAT[p.key]}<span className="riel-lb">{p.label}</span></a>
        ) : (
          <span key={p.key} className="riel-it on" aria-current="page">{ICONOS_PLAT[p.key]}<span className="riel-lb">{p.label} · estás aquí</span></span>
        )
      ))}
    </nav>
  );
}
