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

## Mantenimiento automático

- **Reconectar el generador** (Super Admin → Estado → 🔌): OAuth code + PKCE con la cuenta de la empresa; vuelve a
  `/api/hf/callback` (state de un solo uso, 15 min) y reemplaza el token. El cliente OAuth se registra solo para la URL
  del panel (`PANEL_URL`).
- **Plantillas nuevas**: el worker las clasifica cada 12 h con `gpt-4.1` mirando la portada (mismos criterios que las
  986 originales) y las guarda en `plantillas_clasif`; el catálogo las mezcla con `shared/clasificacion.json`. También
  a mano desde Super Admin.
- **Ver como** (super_admin): selector en el encabezado para ver el panel como Admin o Usuario. El servidor aplica los
  permisos del rol elegido (cabecera `x-ver-como`, solo baja permisos y solo para super_admin); lo que se genera así no
  se cobra a la billetera de JH.

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
- Prompt manual o **autogenerado desde la imagen** (`server/lib/prompt-auto.js`): la adaptación a ferretería y material
  eléctrico de las reglas V2 del menú digital (Adminnebo/Restaurant, `scripts/prompt-v2.mjs` y `prompt-foto.mjs`), los
  prompts ganadores de comida. Misma estructura y candados (elementos numerados, conteos bloqueados, tres tramos, una sola
  acción según el ritmo, negativos por categoría); cambia el objeto: PRODUCT en vez de DISH, catálogo de acciones por
  producto (palanca, encendido, cuarto de vuelta, recorrido de cámara…), LIGHT AND MATERIAL CUE en vez de vapor, las
  marcas impresas del producto se preservan tal cual y nunca chispas, humo ni fuego. Devuelve el prompt en inglés y
  avisos en español para revisar. Usa OpenAI `gpt-4.1` (el mini contaba mal las piezas repetidas); ~0,03 USD por prompt.
- El costo en créditos se pide con `get_cost` (no genera nada) y se muestra con el precio para JH; al generar, el servidor
  lo vuelve a calcular y cobra la billetera. El worker envía con `generate_video`/`generate_image` y sigue con `job_status`.
- La pestaña Crear empieza eligiendo **plantilla** (recomendado) o **desde cero**. Desde cero es un asistente de 5 pasos
  (qué crear · formato, duración y calidad · foto · descripción · revisar y crear) con barra clicable para volver a
  cualquiera. El orden no es casual: la descripción que escribe la IA se arma para la duración (tramos y ritmo), el
  formato y el sonido elegidos, así que van antes; si después se cambia alguno (o la foto), el paso 5 avisa que la
  descripción quedó descuadrada y ofrece reescribirla.
- **Dictar** (🎙, paso 4 y en las plantillas): el reconocimiento de voz del navegador, igual que el menú digital
  (`client/src/lib/dictado.js`); gratis, sin servidor. Lo dictado se usa como base para la IA (va como indicaciones del
  usuario) o tal cual como descripción. Chrome, Edge y Safari; Firefox y los Chromium sin servicios de Google no.
- **Cinema Studio 4.0 y 3.5** no están en el MCP: se cotizan y crean con la CLI oficial (`@higgsfield/cli`, misma cuenta y
  créditos; `server/lib/hf-cli.js`). Su sesión rota como `hf_token`, así que vive en la base (`hf_cli_sesion`) y cada
  llamada la toma con `FOR UPDATE`, corre la CLI en un directorio temporal y guarda lo renovado. El seguimiento es el mismo
  `job_status`. Se carga una vez (la CLI inicia sesión por navegador contra localhost): `npx @higgsfield/cli auth login` →
  `node scripts/sesion-cli.js` → pegar en Super Admin (o variable `HF_CLI_SESION` del worker, solo si la tabla está
  vacía); después **borrar la sesión local** (`~/.config/higgsfield`), si no, dos copias rotan el mismo token. El worker la
  usa cada 6 h para que no venza. CS 4.0: 4–30 s, 480p/720p/1080p, 7 cr/s a 720p.

## Créditos, precios y billetera de JH

- **Costo por crédito automático**: cada 6 h el worker lee los paquetes de recarga del generador y toma el **más caro por
  crédito** (hoy 500 créditos a $26 = $0.052). Se puede pasar a manual en Super Admin (`costo_auto`).
- **Precio por crédito para JH** = costo × (1 + % de ganancia). Es lo que ven todos los usuarios al generar y al recargar.
- **Billetera** (tabla `billetera`): el saldo es la suma de movimientos. Cada generación de un usuario descuenta sus
  créditos al encolarse (con lock, sin gastar dos veces el mismo saldo); si falla, el worker los devuelve una sola vez.
  Las generaciones de los super_admin (Nebo) no tocan la billetera.
- **Recargas**: la pestaña Créditos muestra los paquetes con el precio para JH. El pago en línea está en pausa
  (`pagoEnLinea: false`); mientras tanto un super_admin suma créditos a mano desde Super Admin.

## Pagos: saldo de la plataforma de pagos de Nebo

- Se crea contra el **saldo total de JH** en la plataforma de pagos (Sword AI, USD, compartido con sus otros
  servicios), que el servidor lee con `SALDO_CLIENT_ID` / `SALDO_API_KEY` (`server/lib/saldo-externo.js`, cache 20 s).
  La clave nunca llega al navegador. Marketing no tiene saldo propio mientras esto esté configurado.
- Antes de cada creación: `saldo − por descontar − costo` no puede bajar de `−saldo_negativo_permitido` (ajuste de Super
  Admin, por defecto 0). "Por descontar" = lo creado que aún no se informó a la plataforma; se chequea con un lock para
  que dos creaciones simultáneas no gasten la misma plata. Si la plataforma no responde, no se crea (503).
- Recarga: la página de pago de Nebo embebida en Créditos (`PAGO_URL`), con "Actualizar saldo" y refresco cada 30 s.
- Descuento: cada creación cobrada que sale bien se resta del saldo con `POST /api/credits/adjust` (monto en
  centavos, detalle y referencia `mkt-gen-<id>` en la nota), por una cola en el worker. El endpoint no tiene
  idempotencia: solo se reintenta solo si es seguro que no llegó; los cortes a mitad quedan en Super Admin para
  revisar ("Ya se descontó" / "Reintentar"). Mientras no se descuenta, se resta del saldo leído.
- Sin las variables de saldo se vuelve a la billetera local de créditos con recarga manual.

## Redes sociales (Zernio)

La pestaña **Redes** conecta cuentas (Instagram, Facebook, TikTok, YouTube, LinkedIn, Threads, X) con el OAuth
alojado por [Zernio](https://docs.zernio.com) y publica o programa cualquier resultado con **📣 Publicar**.

- Todas las cuentas viven en un solo perfil de Zernio (se crea solo, "JH Marketing"; su id queda en la tabla `config`).
- El panel crea el post (`POST /v1/posts` con `x-request-id` = `publicaciones.request_id`, así un reintento no
  duplica) y el worker sigue su estado por red hasta `published`/`partial`/`failed`.
- El medio se pasa por URL pública del resultado. Reglas por red (límites de texto, qué acepta cada una, TikTok con
  privacidad + consentimiento obligatorio, título de YouTube) en `shared/redes.mjs`.
- **Webhooks**: con `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` + `PANEL_URL`, el panel registra solo su webhook
  (`/api/zernio/webhook`, firma HMAC-SHA256 del cuerpo crudo, eventos deduplicados en `zernio_eventos`) y las
  publicaciones se actualizan al momento; la consulta del worker queda de respaldo cada 2 min. Los posts llevan
  `metadata.publicacion_id`.
- Variables: `ZERNIO_API_KEY` en `panel` y `worker` (el secreto del webhook ya está puesto). Las 2 primeras cuentas
  conectadas son gratis; X exige tarjeta.

## Camila: buscar productos de JH

El equipo le pide un producto a Camila en lenguaje natural (botón **Camila · Buscar producto** en la barra de pestañas, en el paso "Tu foto" y en la plantilla abierta). Ella busca en el catálogo de JH, dice si tiene foto y ficha técnica, y con **Usar para crear** la foto queda puesta en el paso a paso o en la plantilla.

- Quien responde es la **Camila paralela de n8n** (`n8n.lmconsultingai.com`, flujo "Agente JH Electro Alambres", webhook `agente-jh-electro`) con `canal: "marketing_request"` y la clave en el encabezado `x-panel-token`. En ese canal no pide RNC, no cotiza, no envía nada a clientes y no transfiere; solo usa `buscar_productos` (el normalizador de Nebo). Devuelve `{ texto, productos, sugerencias, execution_id }`.
- El flujo de n8n está en `docs/n8n-camila-marketing.json` (lo genera `scripts/n8n-camila-marketing.py`). Guarda cada mensaje en `mensajes_chat` con canal `marketing_request` y le pasa la ejecución al flujo **"Camila Paralela - Costos"** (`docs/n8n-camila-marketing-costo.json`), que lee los tokens reales, aplica precios y porcentaje del agente `camila` de `/api/porcentaje` y lo registra en Sword como `Camila Marketing` / `marketing-camila-request`.
- La memoria de n8n va por conversación del panel (`contact_id = mkt-<id>-<fecha>`).
- Fotos y fichas: buckets públicos `Lucas_imagenes` y `Lucas_fichas_tecnicas` (archivo = código); el panel arma el índice al arrancar (service key) y lo refresca cada 6 h.
- "Usar para crear" solo vale para productos que Camila le mostró a ese usuario; importa la foto al generador (`media_import_url`) y no cobra nada hasta crear.
- Queda guardado por usuario: `camila_conversaciones`, `camila_mensajes` (con `n8n_ejecucion`) y `camila_usos`.
- **Datos de la ficha técnica**: con un producto elegido con Camila, el paso "Descripción" (Desde cero) y el cuadro "¿Quieres cambiar algo?" (plantillas) muestran "📄 Datos de la ficha técnica". La IA (`gpt-4.1-mini`, misma `OPENAI_API_KEY`) lee el PDF del bucket de fichas y devuelve solo lo pertinente (identidad, lo que se ve, 2-3 datos para destacar); se revisa y se añade con un toque. Cada ficha se lee una vez y queda en `camila_fichas` (~US$0.002 la primera vez). Ruta `POST /api/camila/ficha` (`server/lib/fichas.js`).
- Variables en `panel`: `CAMILA_N8N_URL` y `CAMILA_N8N_TOKEN`. Sin ellas Camila igual se ve, avisa que no está conectada y no busca nada. Las respuestas tardan 10-25 s (DeepSeek con razonamiento).

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

- **Camila**: el tono de la Camila paralela es rioplatense ("usás", "Sos…"); cambiarlo a tuteo dominicano si JH lo prefiere. Cada búsqueda cuesta ~US$0.005 y en Sword se cobra ~US$0.05 (regla del agente `camila`, redondeo a 2 decimales).
- **Recargar la cuenta del generador** (admin@neboaiconsulting.com): el 2026-09-18 quedó en 19 créditos y las creaciones que cuestan más se rechazan con aviso claro.
- **Idempotencia en el descuento**: pedir al equipo de pagos que `/api/credits/adjust` acepte una referencia única y rechace repetidos; hoy un corte a mitad requiere revisión manual.
- **Política de saldo negativo**: JH está en -$1,018 en la plataforma; con el ajuste en $0 no pueden crear hasta pagar. Definir si se permite un margen.
- **Redes (Zernio)**: clave cargada el 2026-09-22 (panel y worker). La cuenta de Zernio es compartida con otros proyectos: el panel usa solo el perfil de JH (Super Admin → Redes muestra los perfiles y permite cambiarlo) y nunca crea ni toca perfiles ajenos. Falta conectar Instagram/Facebook/TikTok en ese perfil (hoy solo tiene WhatsApp, que el panel no usa) y probar una publicación real.
- **Dominio propio** (`panelmarketing.neboaiconsulting.com`): la URL de Railway está fija en los 4 paneles.
- **Primer usuario de JH**: cargar saldo en la billetera (recarga manual) y darle acceso desde Super Admin.
- **Cuenta de prueba** `prueba.marketing@neboaiconsulting.com` (agente sin permisos en los otros paneles, rol Usuario en Marketing): borrarla o quitarle el acceso cuando no haga falta.
- **Probar Cinema Studio 4.0 desde el panel** con una generación real (la CLI y el seguimiento ya se probaron por separado: video de 5 s, 35 créditos).
- **Sesión de la CLI** (Cinema Studio 4.0 y 3.5): se renueva sola; si Super Admin la marca vencida, recargarla con `scripts/sesion-cli.js`. Si el MCP llega a exponer estos modelos, el panel usa el del MCP y la CLI deja de hacer falta.
- **Facilidad de uso, 2.ª vuelta**: Crear (asistente de 5 pasos), Mis creaciones y Créditos ya están rediseñados; faltan **Super Admin y Redes**, y ajustar con lo que digan los usuarios de JH al usarlo.
- **Probar el dictado con micrófono real** en Chrome/Edge (en el servidor de pruebas solo se probó sin micrófono: el flujo y las dos opciones de uso).
- La clave de OpenAI es la misma del menú digital (servicio `generador`): si se rota allá, hay que actualizarla acá.
