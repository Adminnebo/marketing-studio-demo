import { useState } from 'react';
import { entrarDemo } from '../api';

// Acceso a la demo: un código por prospecto, sin cuentas ni contraseñas.
export default function Login() {
  const [codigo, setCodigo] = useState(() => {
    // El enlace que se le manda al prospecto puede traer el código: ?codigo=NEBO-XXXX-XXXX
    try { return (new URLSearchParams(window.location.search).get('codigo') || '').toUpperCase(); } catch { return ''; }
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await entrarDemo(codigo.trim());
      // El código no se queda en la barra de direcciones ni en el historial.
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* sin history */ }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">🎬</div>
        <h1>Marketing Studio</h1>
        <p className="login-sub">Demo · crea una imagen y un video de tu producto</p>

        <label className="login-label" htmlFor="codigo">Código de acceso</label>
        <input id="codigo" className="login-input demo-codigo" type="text" autoComplete="off" autoCapitalize="characters" spellCheck="false"
          value={codigo} onChange={(e) => setCodigo(e.target.value.toUpperCase())} placeholder="NEBO-XXXX-XXXX" required autoFocus />

        {error && <div className="login-error">{error}</div>}

        <button className="btn login-btn" type="submit" disabled={loading || !codigo.trim()}>
          {loading ? 'Entrando…' : 'Entrar a la demo'}
        </button>
        <p className="login-foot">¿No tienes código? Escríbenos y te mandamos uno.</p>
      </form>
    </div>
  );
}
