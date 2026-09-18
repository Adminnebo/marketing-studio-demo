# Marketing Studio · JH

Panel intermediario de [Higgsfield Marketing Studio](https://higgsfield.ai/marketing-studio) para JH. Tiene las mismas
categorías y plantillas (UGC, fotos de producto, animación, anuncios, pósters, marketplace) y usa los **créditos
normales del plan** de la cuenta de Higgsfield de la empresa. No usa la API de pago aparte.

## Cómo funciona

```
navegador ──► panel (Express + React)      ──► Postgres ◄── worker
               · login propio                   · hf_token       · manda las generaciones pendientes
               · catálogo (proxy cacheado)      · generaciones   · sigue su estado hasta tener el resultado
               · sube la imagen del producto                     · renueva el token de Higgsfield
                     │                                                  │
                     └──────────── MCP de Higgsfield (mcp.higgsfield.ai/mcp) ─┘
```

- El panel y el worker hablan con el **MCP oficial de Higgsfield** (JSON-RPC por HTTP) con un token OAuth de la
  cuenta de la empresa. Son las mismas herramientas que usa el widget oficial de Marketing Studio:
  `marketing_studio_v2_presets/avatars/costs/create/status`, `media_upload` y `media_confirm`.
- El token dura unas 24 h y **el refresh token cambia en cada renovación**, por eso vive en la tabla `hf_token`.
  La renovación usa un lock (`SELECT … FOR UPDATE`) para que el panel y el worker no renueven a la vez.
- Crear una generación cobra créditos y no se puede repetir sin volver a cobrar. Por eso, si el worker se cae a
  mitad de un envío, la generación queda como fallida y hay que revisarla a mano. Nunca se reenvía sola.
- Las reglas de cada plantilla (qué pide y cuánto cuesta) están en `shared/reglas.mjs`, portadas del widget oficial.
  Las usan el formulario y la validación del servidor.

## Desarrollo local

```bash
npm install
cp .env.example .env        # completar
npm run dev                 # panel :3002, worker, vite :5190
npm test                    # TEST_DATABASE_URL=postgres://… para incluir las pruebas del worker
```

## Railway

Proyecto propio, **Marketing Studio**, con tres servicios que salen de este mismo repo:

| Servicio | Build | Start |
|---|---|---|
| `panel`  | `npm run build` | `npm start` (healthcheck `/api/health`) |
| `worker` | — | `npm run start:worker` |
| `Postgres` | | |

Variables: ver `.env.example`. `HF_REFRESH_TOKEN` solo siembra la base de datos la primera vez; después se puede
borrar.

## Pendiente

- Mostrar los créditos (`CREDITOS_VISIBLES=1`, en standby).
- Conectarlo a cobranzas como 4ª pestaña del conmutador de plataformas (y más adelante a los otros paneles), con el
  login de Supabase.
- Botón para volver a autorizar Higgsfield desde el panel si se pierde el token.
