// Genera el hash para PANEL_USUARIOS. Uso: npm run hash-password  (la pide por stdin)
const readline = require('readline');
const { hashPassword } = require('../lib/auth');

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
rl.question('Contraseña: ', (pw) => {
  rl.close();
  if (!pw) { console.error('Vacía, nada que hacer.'); process.exit(1); }
  console.log(hashPassword(pw));
});
