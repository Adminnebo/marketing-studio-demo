# Marketing Studio · JH

Panel intermediario de [Higgsfield Marketing Studio](https://higgsfield.ai/marketing-studio) para JH. Tiene las mismas
categorías y plantillas (UGC, fotos de producto, animación, anuncios, pósters, marketplace) y usa los **créditos
normales del plan** de la cuenta de Higgsfield de la empresa. No usa la API de pago aparte.

## Cómo funciona

```
navegador ──► panel (Express + React)      ──► Postgres ◄── worker
               · login Supabase (paneles)       · hf_token       · manda las generaciones pendientes
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

## Catálogo ordenado para JH

- El panel baja el catálogo completo (986 plantillas en sep-2026) y lo sirve filtrado y ordenado desde
  `server/lib/catalogo.js`: primero lo que mejor encaja con los productos de JH.
- `shared/clasificacion.json` guarda, por id de plantilla, el análisis visual de su portada: producto del ejemplo,
  estilos, si sale una persona y un puntaje de encaje con JH (0–10). Se hizo con hojas de contacto de las portadas
  frente al catálogo real de JH (`List_ProductosIA`: material eléctrico 24 %, controles/industrial 18 %, iluminación
  16 %, ferretería 10 %, piscina 9 %, plomería 9 %). Casi ningún ejemplo es de ferretería (el catálogo del generador
  es de consumo), así que el encaje se decide por la composición.
- Filtros: "Sirve para JH" (eléctrico, iluminación, agua/plomería/piscina, herramientas; reglas en
  `shared/filtros.mjs`), estilo, producto del ejemplo, con/sin persona, foto/video, forma y orden.
- Plantillas nuevas que aparezcan sin clasificar entran con encaje 5 y al final de su nivel; conviene reclasificar
  cada tanto.

## Acceso y Super Admin

- Se entra con la cuenta de Supabase de los otros paneles. Los `super_admin` de `profiles` entran siempre; el resto
  solo si un super_admin le da acceso (**Usuario**: genera y descarga; **Admin**: además redes sociales). Ese acceso
  vive en la tabla `accesos` de este panel, no en `profiles.permissions` (los editores de usuarios de los otros
  paneles reescriben esa lista completa y lo borrarían).
- `GET /api/acceso` (con el token de Supabase, CORS solo para `*.neboaiconsulting.com`) lo consultan Conversaciones,
  Cotizaciones y Cobranzas para mostrar u ocultar su pestaña/botón de Marketing.
- Pestaña **Super Admin**: costo por crédito (USD), % de ganancia general y por tipo, tope diario de créditos por
  usuario, si los usuarios ven el precio, consumo del mes (costo, precio y ganancia por usuario y por tipo) y los
  accesos. Cada generación guarda la foto de costo/precio al crearse.

## Generación libre (pestaña Crear)

- Arriba de la galería: cualquier modelo de video o imagen del generador (hoy 26 de video y 24 de imagen; Cinema Studio
  3.0, Seedance 2.5/2.0, Kling 3.0, Veo 3.1, GPT Image 2.5, Nano Banana Pro…). El catálogo se lee con `models_explore`
  (cache 1 h) y el formulario se arma solo: formato, duración, resolución/calidad, audio, etc. (`server/lib/modelos.js`).
- Prompt manual o **autogenerado desde la imagen** (el botón existe; las instrucciones las define el cliente).
- El costo en créditos se pide con `get_cost` (no genera nada) y se muestra con el precio para JH; al generar, el servidor
  lo vuelve a calcular y cobra la billetera. El worker envía con `generate_video`/`generate_image` y sigue con `job_status`.

## Créditos, precios y billetera de JH

- **Costo por crédito automático**: cada 6 h el worker lee los paquetes de recarga del generador y toma el **más caro por
  crédito** (hoy 500 créditos a $26 = $0.052). Se puede pasar a manual en Super Admin (`costo_auto`).
- **Precio por crédito para JH** = costo × (1 + % de ganancia). Es lo que ven todos los usuarios al generar y al recargar.
- **Billetera** (tabla `billetera`): el saldo es la suma de movimientos. Cada generación de un usuario descuenta sus
  créditos al encolarse (con lock, sin gastar dos veces el mismo saldo); si falla, el worker los devuelve una sola vez.
  Las generaciones de los super_admin (Nebo) no tocan la billetera.
- **Recargas**: la pestaña Créditos muestra los paquetes con el precio para JH. El pago en línea está en pausa
  (`pagoEnLinea: false`); mientras tanto un super_admin suma créditos a mano desde Super Admin.

## Redes sociales (Zernio)

La pestaña **Redes** conecta cuentas (Instagram, Facebook, TikTok, YouTube, LinkedIn, Threads, X) con el OAuth
alojado por [Zernio](https://docs.zernio.com) y publica o programa cualquier resultado con **📣 Publicar**.

- Todas las cuentas viven en un solo perfil de Zernio (se crea solo, "JH Marketing"; su id queda en la tabla `config`).
- El panel crea el post (`POST /v1/posts` con `x-request-id` = `publicaciones.request_id`, así un reintento no
  duplica) y el worker sigue su estado por red hasta `published`/`partial`/`failed`.
- El medio se pasa por URL pública del resultado. Reglas por red (límites de texto, qué acepta cada una, TikTok con
  privacidad + consentimiento obligatorio, título de YouTube) en `shared/redes.mjs`.
- Variables: `ZERNIO_API_KEY` en `panel` y `worker`. Las 2 primeras cuentas conectadas son gratis; X exige tarjeta.

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

## Pendiente (detalles y correcciones finales)

- **Prompt automático desde la imagen**: falta que el cliente pase las instrucciones (el endpoint responde 501).
- **Pago en línea de recargas** (Stripe/Whop o solicitud + aprobación): en pausa por decisión del cliente.
- **Clave de Zernio** (`ZERNIO_API_KEY` en panel y worker) para activar las redes sociales.
- **Botón "reconectar generador"** si se pierde el token OAuth.
- **Dominio propio** (`panelmarketing.neboaiconsulting.com`): la URL de Railway está fija en los 4 paneles.
- **Primera prueba real de login** con la cuenta Supabase de un super_admin y alta del primer usuario de JH (con saldo).
- **Reclasificar plantillas** cuando aparezcan nuevas (entran con encaje 5).
- Webhooks de Zernio (hoy el worker consulta el estado cada ~15 s).
