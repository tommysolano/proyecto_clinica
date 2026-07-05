/**
 * Elimina el índice ÚNICO antiguo { clinic, type, code } de retentionrules, para
 * habilitar versiones históricas del mismo código en vigencias distintas. La
 * no-duplicación de reglas ACTIVAS con vigencia solapada la valida la aplicación.
 *
 * Dry-run por defecto; usa --commit para aplicar.
 */
const { parseArgs, connect, disconnect, banner, mongoose } = require('./_common');

async function run() {
  const opts = parseArgs();
  banner('Drop índice único de RetentionRule', opts);
  await connect();
  try {
    const coll = mongoose.connection.collection('retentionrules');
    const indexes = await coll.indexes();
    // Busca un índice único sobre exactamente { clinic, type, code }.
    const target = indexes.find((ix) => ix.unique && JSON.stringify(ix.key) === JSON.stringify({ clinic: 1, type: 1, code: 1 }));
    if (!target) {
      console.log('No hay índice único { clinic,type,code } que eliminar. Nada que hacer.');
      return;
    }
    console.log(`Índice único encontrado: ${target.name}`);
    if (opts.dryRun) { console.log('\nDRY-RUN: no se eliminó nada. Usa --commit para aplicar.'); return; }
    await coll.dropIndex(target.name);
    console.log(`\nÍndice ${target.name} eliminado. Mongoose recreará el no-único al reiniciar la app.`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
