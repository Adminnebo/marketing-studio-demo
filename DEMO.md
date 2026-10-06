# Marketing Studio · Demo para prospectos

La misma interfaz del panel de Marketing Studio, limitada: el prospecto entra con un **código**, crea **una imagen y un
video** sin costo, y ve todo lo demás de la versión completa con un candado.

Este repo es un clon de `Adminnebo/marketing-studio-panel`. Lo propio de la demo son pocos archivos; el resto es el
panel tal cual, y se deja sin tocar para poder traer sus arreglos con un merge limpio.

## Cómo funciona

```
navegador ──► demo (este repo, server/demo-app.js) ──► panel de producción (/api/demo/*) ──► generador
              · interfaz del panel, limitada            · códigos, cupo y tope de créditos
              · cookie firmada con el código            · crea la pieza, sin cobrársela a nadie
              · sin base de datos                       · Super Admin → Demo
```

**La demo no genera nada ni habla con el generador.** Le pide las piezas al panel de producción con una clave de
servicio. Tiene que ser así: el token del generador rota en cada renovación y solo un proceso puede rotarlo, así que
una segunda app con su propia copia dejaría a producción sin poder generar.

Por eso todo lo que importa lo decide producción y no esta app, que es la que queda expuesta a internet:

- si el código vale, cuánto le queda y cuándo caduca;
- qué modelo, resolución, duración y sonido se generan (lo que mande el navegador se ignora);
- que la pieza no se le cobre a nadie, y el tope mensual de créditos de todas las demos.

Si alguien rompe esta app, lo único que consigue es lo mismo que ya le daba su código.

## Lo propio de la demo

| Archivo | Qué es |
|---|---|
| `server/demo-app.js` | El servidor: sesión por cookie, freno de intentos y la traducción de la API del panel a `/api/demo/*`. |
| `client/src/AppDemo.jsx`, `demo.css` | La cáscara: encabezado con el cupo, la franja de la demo y la ventana de "versión completa". |
| `client/src/components/Login.jsx` | Acceso con código (acepta `?codigo=NEBO-XXXX-XXXX` en el enlace). |
| `client/src/components/Libre.jsx`, `Generaciones.jsx` | Los del panel, con una propiedad `demo` que pinta los candados. |
| `client/src/api.js`, `main.jsx`, `index.html` | Arranque en modo demo. |
| `test-demo/demo-app.test.js` | Pruebas del servidor de la demo, contra un panel de mentira. |

`server/index.js`, `server/worker.js` y el resto del panel **no se usan aquí**: `npm start` arranca `server/demo-app.js`.

## Variables

| Variable | Para qué |
|---|---|
| `PANEL_API` | URL del panel de producción, sin barra final. Hoy `https://panelmarketing.neboaiconsulting.com`. |
| `DEMO_CLAVE` | Clave de servicio, **la misma** que tiene el servicio `panel` de producción. 24 caracteres o más. |
| `DEMO_SESION` | Secreto para firmar la cookie. Cualquier cadena larga y aleatoria; si se cambia, todos vuelven a entrar. |
| `DEMO_CONTACTO` | Opcional. A dónde lleva "Quiero la versión completa" (un `https://wa.me/…`, por ejemplo). |
| `NODE_ENV` | `production` en el despliegue: la cookie solo viaja por https. |

Para generar las dos claves: `openssl rand -base64 36`.

No necesita Postgres, ni Supabase, ni credenciales del generador.

## Dar acceso a un prospecto

Todo se hace en el panel de producción, **Super Admin → Demo**:

1. *Crear código* con el nombre del prospecto. Sale el código, el enlace y un mensaje listo para copiar.
2. Ahí mismo se ve si ya entró, qué creó y cuántos créditos lleva. *Revocar* lo deja fuera al momento.
3. En *Qué se puede generar* se cambia el modelo, la calidad, el cupo por código y el tope de créditos del mes.

## Local

```
npm install
npm run build
PANEL_API=http://localhost:3002 DEMO_CLAVE=… DEMO_SESION=… npm start    # http://localhost:3003
npm test
```

Apunta `PANEL_API` a un panel local con la misma `DEMO_CLAVE` y la demo encendida. No lo apuntes a producción para
probar: las piezas salen de los créditos de verdad.

## Railway

Un solo servicio, sin base de datos. Railway usa `npm run build` y `npm start` solos. Las variables de arriba, y un
dominio (el que se ponga va también en Super Admin → Demo → *Dirección de la demo*, para que el enlace salga completo).

## Traer cambios del panel

```
git fetch panel
git merge panel/main
```

El remoto `panel` es solo de lectura desde aquí: desde este repo nunca se empuja al panel.
