/**
 * Imprime la sesion de la CLI del generador de esta maquina como un paquete para
 * pegar en Super Admin ("Cargar sesión") o en la variable HF_CLI_SESION.
 * Antes: npx @higgsfield/cli auth login  (con la cuenta de la empresa)
 */
const { empaquetar } = require('../server/lib/hf-cli');

empaquetar()
  .then((p) => { console.log(p); process.exit(0); })
  .catch((e) => { console.error('No hay sesion de la CLI en esta maquina (' + e.message + '). Primero: npx @higgsfield/cli auth login'); process.exit(1); });
