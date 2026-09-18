/**
 * Reconectar el generador desde el panel: un super_admin inicia el OAuth
 * (code + PKCE) contra el MCP, inicia sesion con la cuenta de la empresa en el
 * navegador y vuelve a /api/hf/callback, donde se guarda el token nuevo. El
 * cliente OAuth se registra solo (registro dinamico) para la URL de retorno del
 * panel y se recuerda en config.
 */
const crypto = require('crypto');
const { pool } = require('./db');

const MCP_URL = process.env.HF_MCP_URL || 'https://mcp.higgsfield.ai/mcp';
const BASE_OAUTH = process.env.HF_OAUTH_URL || 'https://mcp.higgsfield.ai/oauth2';
const ESTADO_MIN = 15;

const b64u = (b) => b.toString('base64url');

async function cliente(redirect) {
  const { rows } = await pool.query(`SELECT valor FROM config WHERE clave = 'hf_oauth_cliente'`);
  const guardado = rows[0] ? JSON.parse(rows[0].valor) : null;
  if (guardado?.client_id && guardado.redirect === redirect) return guardado.client_id;
  const r = await fetch(`${BASE_OAUTH}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Nebo Marketing Panel', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: 'openid email offline_access',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.client_id) throw new Error('No se pudo registrar el cliente OAuth: HTTP ' + r.status);
  await pool.query(
    `INSERT INTO config (clave, valor) VALUES ('hf_oauth_cliente', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [JSON.stringify({ client_id: j.client_id, redirect })]
  );
  return j.client_id;
}

// Devuelve la URL de autorizacion para abrir en el navegador.
async function iniciar({ base, por }) {
  const redirect = `${base.replace(/\/+$/, '')}/api/hf/callback`;
  const clientId = await cliente(redirect);
  const verifier = b64u(crypto.randomBytes(32));
  const state = b64u(crypto.randomBytes(24));
  await pool.query(`DELETE FROM oauth_estados WHERE creado < now() - interval '1 day'`);
  await pool.query(`INSERT INTO oauth_estados (state, verifier, client_id, redirect, por) VALUES ($1, $2, $3, $4, $5)`,
    [state, verifier, clientId, redirect, por]);
  const url = new URL(`${BASE_OAUTH}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'openid email offline_access',
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    state, resource: MCP_URL,
  });
  return url.toString();
}

const cuentaDe = (idToken) => { try { return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url')).email || null; } catch { return null; } };

// Canjea el code (el state es de un solo uso) y reemplaza el token guardado.
async function completar({ code, state }) {
  const { rows: [e] } = await pool.query(
    `DELETE FROM oauth_estados WHERE state = $1 AND creado > now() - ($2 || ' minutes')::interval RETURNING *`, [String(state || ''), ESTADO_MIN]
  );
  if (!e) throw new Error('El intento de conexión venció o no es válido. Vuelve a intentarlo.');
  const r = await fetch(`${BASE_OAUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: e.redirect, client_id: e.client_id, code_verifier: e.verifier, resource: MCP_URL }),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token || !t.refresh_token) throw new Error('No se pudo obtener el token: ' + (t.error_description || t.error || 'HTTP ' + r.status));
  const cuenta = t.id_token ? cuentaDe(t.id_token) : null;
  await pool.query(
    `INSERT INTO hf_token (id, client_id, access_token, refresh_token, expira_en, cuenta, actualizado, ultimo_error)
     VALUES (1, $1, $2, $3, $4, $5, now(), NULL)
     ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
       expira_en = EXCLUDED.expira_en, cuenta = COALESCE(EXCLUDED.cuenta, hf_token.cuenta), actualizado = now(), ultimo_error = NULL`,
    [e.client_id, t.access_token, t.refresh_token, new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000), cuenta]
  );
  console.log(`[generador] reconectado por ${e.por} con la cuenta ${cuenta}`);
  return { cuenta, por: e.por };
}

module.exports = { iniciar, completar };
