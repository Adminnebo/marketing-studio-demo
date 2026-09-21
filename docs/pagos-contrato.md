# Contrato: Marketing ↔ plataforma central de pagos de Nebo

Versión 2 · 2026-09-21 · implementado en `server/lib/pagos.js`, simulado en `test/mock-pagos.js`.

## Modelo

- JH tiene un **saldo total** en la plataforma de pagos de Nebo (Sword AI), en USD, compartido con
  sus otros servicios. **Es el saldo con el que se crea en Marketing**: Marketing no tiene saldo propio.
- **Ver el saldo**: `GET https://app.swordaisolutions.com/api/credits/balance?clientId=<id>&apiKey=<clave>`
  (ya existe). Lo lee el servidor de Marketing; la clave nunca llega al navegador.
- **Recargar**: la página de pago de la plataforma, embebida en la pestaña Créditos (ya existe).
- **Descontar lo gastado**: cada creación cobrada se informa con su detalle y su costo para que la
  plataforma lo reste del saldo total. **Este endpoint es el que falta**; abajo va la propuesta.
- Mientras un gasto no se informó, Marketing lo resta del saldo leído ("por descontar"), para que no se
  pueda gastar dos veces la misma plata en ese intervalo.
- Las creaciones que fallan no se cobran ni se informan; las de los super admin de Nebo tampoco.

## Saldo (existente)

```json
GET /api/credits/balance?clientId=16&apiKey=…
200 { "success": true, "clientId": 16, "name": "JH Electroalambres", "email": "…", "credits": -1018.69,
      "balance": -1018.69, "currency": "USD", "autoRechargeEnabled": false, "autoRechargeThreshold": 30 }
```

Marketing usa `balance` (o `credits` si no viene). Antes de cada creación: si
`balance − por descontar − costo < −saldo negativo permitido` (ajuste de Super Admin, por defecto 0), no se crea.

## Endpoint de gasto (propuesta: pendiente)

Si el equipo de pagos lo define distinto, Marketing se adapta; lo que no puede faltar es la idempotencia.

### Autenticación

| Header | Valor |
|---|---|
| `Authorization` | `Bearer <PAGOS_API_KEY>` |
| `X-Nebo-Timestamp` | segundos Unix del envío |
| `X-Nebo-Firma` | HMAC-SHA256 en hex de `"<timestamp>.<cuerpo crudo>"` con `PAGOS_SECRETO` (cuerpo vacío en GET) |
| `X-Nebo-Origen` | `marketing` |
| `Idempotency-Key` | en los POST, igual a `referencia` |

La plataforma debe rechazar con 401 una firma inválida o un timestamp a más de 5 minutos.

### Idempotencia

Cada operación trae una `referencia` única generada por Marketing:
`mkt-gen-<id>` (una por creación). Si llega otra vez la misma referencia,
la plataforma **no la procesa de nuevo** y responde 200 con el mismo resultado. Marketing reintenta
cuando no recibe respuesta; sin idempotencia descontaría dos veces.

### `POST /consumos` — el gasto de una creación

Se envía cuando la creación termina bien. La plataforma resta `monto_usd` del saldo total de JH.

```json
{
  "cliente": "16",
  "origen": "marketing",
  "referencia": "mkt-gen-1234",
  "monto_usd": 2.184,
  "moneda": "USD",
  "creditos": 35,
  "descripcion": "Video · Cinema Studio 4.0 · 5 s · 720p · 9:16",
  "usuario": { "id": "uuid", "email": "vendedor@jh.com" },
  "detalle": {
    "generacion_id": 1234,
    "panel": "marketing",
    "medio": "video",
    "origen": "desde_cero",
    "nombre": "Cinema Studio 4.0",
    "modelo": { "id": "cinematic_studio_video_4_0", "nombre": "Cinema Studio 4.0" },
    "plantilla": null,
    "duracion_s": 5,
    "calidad": "720p",
    "formato": "9:16",
    "audio": true,
    "opciones": { "resolution": "720p", "generate_audio": true },
    "descripcion": "Create a premium 5-second cinematic product commercial…",
    "descripcion_por_ia": true,
    "imagen_producto": "https://…/breaker.png",
    "persona": null,
    "resultados": [{ "url": "https://…/video.mp4", "miniatura": null }],
    "creado": "2026-09-21T13:00:00Z",
    "terminado": "2026-09-21T13:04:10Z",
    "segundos_proceso": 250,
    "creditos": 35,
    "precio_usd": 2.184,
    "costo_usd": 1.82,
    "margen_pct": 20,
    "usd_por_credito": 0.052
  }
}
```

- `monto_usd` / `detalle.precio_usd`: lo que pagó el cliente (lo que se le muestra).
- `costo_usd`, `margen_pct`, `usd_por_credito`: **internos de Nebo** (costo del proveedor y margen),
  para reportes. No mostrarlos al cliente.
- En plantillas: `origen = "plantilla"`, `modelo.id = "marketing_studio"` y `plantilla = { id, nombre, tipo, categoria, formato }`.
  En fotos, `duracion_s` y `audio` van en `null`.

| Respuesta | Marketing hace |
|---|---|
| `201 { "consumo_id", "referencia", "estado": "registrado" }` o `200` repetido | listo |
| `5xx`, `408`, `429` o sin respuesta | reintenta con espera 1, 2, 4… min (tope 1 h), hasta 12 intentos |
| otro `4xx` | lo deja en error; un super admin lo reintenta desde Super Admin |

## Configuración en Marketing

- Saldo: `SALDO_CLIENT_ID`, `SALDO_API_KEY` (y opcional `SALDO_API_URL`, `PAGO_URL` para la página de pago) en el panel.
  Sin ellas se usa la billetera local de créditos con recarga manual del super admin.
- Gasto (cuando exista): `PAGOS_URL`, `PAGOS_API_KEY`, `PAGOS_SECRETO`, `PAGOS_CLIENTE` en panel y worker.
  Si el endpoint real tiene otra forma, se adapta `server/lib/pagos.js`.

## Probar sin la plataforma

```sh
SALDO_API_KEY=clave-saldo PAGOS_API_KEY=clave PAGOS_SECRETO=secreto node test/mock-pagos.js 4600
# en Marketing: SALDO_API_URL=http://localhost:4600/api/credits/balance SALDO_CLIENT_ID=16 SALDO_API_KEY=clave-saldo
#               PAGOS_URL=http://localhost:4600 PAGOS_API_KEY=clave PAGOS_SECRETO=secreto PAGOS_CLIENTE=16
```
