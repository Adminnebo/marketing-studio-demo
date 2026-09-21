# Contrato: Marketing ↔ plataforma central de pagos de Nebo

Versión 3 · 2026-09-21 · implementado en `server/lib/saldo-externo.js` y `server/lib/pagos.js`, simulado en `test/mock-pagos.js`.

## Modelo

- JH tiene un **saldo total** en la plataforma de pagos de Nebo (Sword AI), en USD, compartido con
  sus otros servicios. **Es el saldo con el que se crea en Marketing**: Marketing no tiene saldo propio.
- **Ver el saldo**: `GET https://app.swordaisolutions.com/api/credits/balance?clientId=<id>&apiKey=<clave>`
  (ya existe). Lo lee el servidor de Marketing; la clave nunca llega al navegador.
- **Recargar**: la página de pago de la plataforma, embebida en la pestaña Créditos (ya existe).
- **Descontar lo gastado**: `POST /api/credits/adjust` con el monto y el detalle en la nota (ya existe).
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

## Descontar el gasto (existente)

```json
POST https://app.swordaisolutions.com/api/credits/adjust
{ "callerId": 14, "apiKey": "…", "clientId": 16, "amount": 2.18, "operation": "subtract",
  "concept": "marketing",
  "note": "Video Cinema Studio 4.0 · 5 s · 720p · vertical 9:16 · con audio · 35 créditos · $2.18 · vendedor@jh.com · ref mkt-gen-1234" }
200 { "success": true, … }
400 { "success": false, "error": "amount must be a positive number up to 100000" }
```

- Se envía cuando la creación termina bien, una vez por creación. `amount` = precio para JH en centavos
  (lo mismo que ve en el panel). `note` lleva el detalle y la referencia `mkt-gen-<id>`.
- **Sin idempotencia**: el endpoint no reconoce pedidos repetidos. Marketing solo reintenta solo cuando es seguro
  que no llegó (no conectó, 429, 503). Un corte a mitad (timeout, 500, 502, 504) queda en Super Admin para
  revisar en la plataforma (buscando la referencia) y elegir **Ya se descontó** o **Reintentar**.
- Pedido al equipo de pagos: aceptar una referencia única (p. ej. `reference`) y rechazar repetidos. Con eso los
  reintentos pasan a ser automáticos y seguros.

## Configuración en Marketing

- Saldo: `SALDO_CLIENT_ID`, `SALDO_API_KEY` (y opcional `SALDO_API_URL`, `PAGO_URL` para la página de pago) en el panel.
  Sin ellas se usa la billetera local de créditos con recarga manual del super admin.
- Descuento: `AJUSTE_CALLER_ID`, `AJUSTE_API_KEY` (y opcional `AJUSTE_URL`) más `SALDO_CLIENT_ID`, en panel y worker.

## Probar sin la plataforma

```sh
node test/mock-pagos.js 4600   # saldo y ajuste simulados (clientId 16, callerId 14)
# en Marketing: SALDO_API_URL=http://localhost:4600/api/credits/balance SALDO_CLIENT_ID=16 SALDO_API_KEY=clave-saldo
#               AJUSTE_URL=http://localhost:4600/api/credits/adjust AJUSTE_CALLER_ID=14 AJUSTE_API_KEY=clave-ajuste
```
