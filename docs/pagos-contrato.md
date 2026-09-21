# Contrato: Marketing ↔ plataforma central de pagos de Nebo

Versión 1 · 2026-09-21 · implementado en `server/lib/pagos.js`, simulado en `test/mock-pagos.js`.

## Modelo

- El cliente (hoy JH) tiene un **balance general** en la plataforma central, en USD.
- Marketing tiene su **propia billetera** en créditos. Se genera siempre contra esa billetera:
  generar no depende de que la plataforma responda.
- **Recarga**: un admin de Marketing pasa dinero del balance general a Marketing.
  La plataforma lo descuenta del balance general; Marketing suma los créditos equivalentes.
- **Consumo**: cada creación cobrada que sale bien se informa con su detalle completo.
  Es informativo: **no mueve dinero** (ya se movió al recargar).
- Las creaciones que fallan se devuelven solas a la billetera de Marketing y no se informan.
  Las de los super admin de Nebo no se cobran ni se informan.

## Autenticación (todas las llamadas)

| Header | Valor |
|---|---|
| `Authorization` | `Bearer <PAGOS_API_KEY>` |
| `X-Nebo-Timestamp` | segundos Unix del envío |
| `X-Nebo-Firma` | HMAC-SHA256 en hex de `"<timestamp>.<cuerpo crudo>"` con `PAGOS_SECRETO` (cuerpo vacío en GET) |
| `X-Nebo-Origen` | `marketing` |
| `Idempotency-Key` | en los POST, igual a `referencia` |

La plataforma debe rechazar con 401 una firma inválida o un timestamp a más de 5 minutos.

## Idempotencia

Cada operación trae una `referencia` única generada por Marketing:
`mkt-rec-<uuid>` (recargas) y `mkt-gen-<id>` (consumos). Si llega otra vez la misma referencia,
la plataforma **no la procesa de nuevo** y responde 200 con el mismo resultado. Marketing reintenta
cuando no recibe respuesta; sin idempotencia eso descontaría dos veces.

## 1. `GET /saldo?cliente=<id>`

Balance general disponible para pasar a Marketing.

```json
200 { "cliente": "jh", "saldo_usd": 125.40, "moneda": "USD", "actualizado": "2026-09-21T13:00:00Z" }
404 { "error": "cliente_desconocido" }
```

## 2. `POST /recargas` — pasar saldo del balance general a Marketing

```json
{
  "cliente": "jh",
  "origen": "marketing",
  "referencia": "mkt-rec-2f1c6c1e-9a4b-4b8e-8a57-0c1f6f2d9b11",
  "monto_usd": 25.00,
  "moneda": "USD",
  "creditos": 400.6,
  "precio_credito_usd": 0.0624,
  "descripcion": "Recarga de Marketing: 400.6 créditos",
  "usuario": { "id": "uuid", "email": "admin@jh.com", "nombre": "Nombre" }
}
```

La plataforma descuenta `monto_usd` del balance general. `creditos` y `precio_credito_usd` son
informativos (lo que recibe el cliente en Marketing).

| Respuesta | Significado | Marketing hace |
|---|---|---|
| `201 { "recarga_id", "referencia", "estado": "aplicada", "saldo_usd" }` | descontado | suma los créditos |
| `200` con la misma forma | referencia repetida | suma los créditos si aún no lo hizo (nunca dos veces) |
| `402 { "error": "saldo_insuficiente", "saldo_usd" }` | no alcanza | no suma nada, avisa al usuario |
| `400` / `409` | datos inválidos / conflicto | no suma nada |
| `5xx` o sin respuesta | no se sabe | deja la recarga pendiente y repite la misma referencia cada ≥2 min |

`saldo_usd` en las respuestas es el balance general que queda.

## 3. `POST /consumos` — informar una creación cobrada

Se envía cuando la creación termina bien. No mueve dinero.

```json
{
  "cliente": "jh",
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

Variables en los servicios **panel** y **worker** de Railway:
`PAGOS_URL` (base, sin barra final), `PAGOS_API_KEY`, `PAGOS_SECRETO`, `PAGOS_CLIENTE` (id de JH en la plataforma).
Sin las cuatro, todo sigue como hoy (recarga manual del super admin) y no se informa nada.

## Probar sin la plataforma

```sh
PAGOS_API_KEY=clave PAGOS_SECRETO=secreto node test/mock-pagos.js 4600
# y en Marketing: PAGOS_URL=http://localhost:4600 PAGOS_API_KEY=clave PAGOS_SECRETO=secreto PAGOS_CLIENTE=jh
```
