/**
 * Utilidades compartidas por los scripts de migración.
 * Por seguridad, los scripts NO escriben salvo que se pase --commit.
 * Uso típico:  node scripts/<script>.js            (dry-run, no escribe)
 *              node scripts/<script>.js --commit    (aplica cambios)
 *              node scripts/<script>.js --clinic=<id> --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');

function parseArgs() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const clinicArg = args.find((a) => a.startsWith('--clinic='));
  const clinic = clinicArg ? clinicArg.split('=')[1] : null;
  return { commit, clinic, dryRun: !commit };
}

async function connect() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Falta MONGODB_URI en el entorno (.env)');
  }
  await mongoose.connect(process.env.MONGODB_URI);
}

async function disconnect() {
  await mongoose.disconnect();
}

function banner(name, { dryRun, clinic }) {
  console.log(`\n=== ${name} ===`);
  console.log(dryRun ? 'MODO: DRY-RUN (no escribe). Usa --commit para aplicar.' : 'MODO: COMMIT (aplica cambios).');
  if (clinic) console.log(`Clínica: ${clinic}`);
  console.log('');
}

module.exports = { parseArgs, connect, disconnect, banner, mongoose };
