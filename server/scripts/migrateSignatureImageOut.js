/**
 * Borra el campo `signatureImage` (la firma ESCANEADA) de todos los usuarios.
 *
 * La firma pasó a ser un certificado .p12 de verdad (`signatureCert`): una foto
 * de la firma no firma nada, solo se parece a una firma, y dejarla en la base
 * sería guardar cientos de KB de base64 que ya no lee nadie.
 *
 * Es IDEMPOTENTE: se puede correr las veces que haga falta.
 *
 * Uso (por defecto NO escribe, solo cuenta):
 *   node scripts/migrateSignatureImageOut.js
 *   node scripts/migrateSignatureImageOut.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const commit = process.argv.includes('--commit');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el entorno.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection('users');

  const con = await col.countDocuments({ signatureImage: { $exists: true } });
  const conContenido = await col.countDocuments({
    signatureImage: { $exists: true, $nin: [null, ''] },
  });

  console.log(`Usuarios con el campo:        ${con}`);
  console.log(`De ellos, con una imagen:     ${conContenido}`);

  if (!commit) {
    console.log('\n(simulación) No se ha escrito nada. Repite con --commit para borrarlo.');
    await mongoose.disconnect();
    return;
  }

  const r = await col.updateMany({ signatureImage: { $exists: true } }, { $unset: { signatureImage: '' } });
  console.log(`\nBorrado de ${r.modifiedCount} usuarios.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
