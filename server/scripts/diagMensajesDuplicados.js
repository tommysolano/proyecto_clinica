/**
 * DIAGNÓSTICO (SOLO LECTURA): mensajes entrantes repetidos en el chat.
 *
 * Distingue las dos causas posibles, que se arreglan en sitios distintos:
 *
 *  A) MISMO `externalId` guardado dos veces → el fallo es NUESTRO. Meta reintenta
 *     el webhook si no respondemos a tiempo y la comprobación de duplicado es
 *     leer-y-luego-escribir, sin índice único detrás: dos entregas a la vez pasan
 *     las dos.
 *
 *  B) `externalId` DISTINTO con el mismo texto y (casi) la misma hora → el
 *     mensaje entró dos veces de verdad: dos pasarelas ingiriendo el mismo
 *     número (QR y Cloud a la vez), dos backends vivos, o el contacto que
 *     escribió dos veces.
 *
 * No escribe nada. Uso:
 *   node scripts/diagMensajesDuplicados.js [díasAtrás]
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const dias = Number(process.argv[2]) || 3;
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el entorno.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const Message = mongoose.connection.collection('messages');

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  console.log(`\nMensajes ENTRANTES desde ${desde.toISOString()} (${dias} días)\n`);

  const total = await Message.countDocuments({ direction: 'in', createdAt: { $gte: desde } });
  console.log(`Total entrantes: ${total}`);

  // ── A) mismo externalId más de una vez ────────────────────────────────
  const porExternal = await Message.aggregate([
    { $match: { direction: 'in', createdAt: { $gte: desde }, externalId: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$externalId', n: { $sum: 1 }, ids: { $push: '$_id' }, conv: { $first: '$conversation' }, body: { $first: '$body' } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 20 },
  ]).toArray();

  const totalA = await Message.aggregate([
    { $match: { direction: 'in', createdAt: { $gte: desde }, externalId: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$externalId', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'grupos' },
  ]).toArray();

  console.log(`\n── A) MISMO externalId repetido: ${totalA[0]?.grupos || 0} grupos`);
  if (porExternal.length) {
    console.log('   (esto es un fallo NUESTRO: el webhook se procesó dos veces)');
    porExternal.slice(0, 5).forEach((g) =>
      console.log(`   ×${g.n}  ${g._id}  «${String(g.body || '').slice(0, 45)}»`)
    );
  }

  // ── B) mismo texto y misma conversación en menos de 2 minutos ─────────
  const sospechosos = await Message.aggregate([
    { $match: { direction: 'in', createdAt: { $gte: desde } } },
    { $sort: { conversation: 1, createdAt: 1 } },
    {
      $group: {
        _id: { conv: '$conversation', body: '$body' },
        n: { $sum: 1 },
        ext: { $addToSet: '$externalId' },
        fechas: { $push: '$createdAt' },
      },
    },
    { $match: { n: { $gt: 1 }, '_id.body': { $type: 'string', $ne: '' } } },
    { $limit: 400 },
  ]).toArray();

  // Solo los que están MUY juntos: el mismo texto tres días después es que el
  // contacto lo escribió otra vez, no un duplicado.
  const juntos = sospechosos.filter((g) => {
    const f = g.fechas.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
    return f.some((t, i) => i > 0 && t - f[i - 1] < 120000);
  });

  const distintoId = juntos.filter((g) => g.ext.filter(Boolean).length > 1);
  console.log(`\n── B) mismo texto + misma conversación en <2 min: ${juntos.length} grupos`);
  console.log(`      de ellos con externalId DISTINTO: ${distintoId.length}`);
  distintoId.slice(0, 8).forEach((g) => {
    const f = g.fechas.map((d) => new Date(d).toISOString().slice(11, 23)).sort();
    console.log(`   ×${g.n}  «${String(g._id.body).slice(0, 40)}»  ${f.join('  ')}`);
    console.log(`         ids: ${g.ext.filter(Boolean).map((x) => String(x).slice(-24)).join(' | ')}`);
  });

  // ── ¿Por qué pasarela entraron los duplicados? ────────────────────────
  if (distintoId.length) {
    const conv = distintoId[0]._id.conv;
    const muestra = await Message.find({ conversation: conv, direction: 'in' })
      .sort({ createdAt: -1 })
      .limit(6)
      .project({ body: 1, externalId: 1, createdAt: 1, whatsappAccount: 1, origin: 1 })
      .toArray();
    console.log('\n── Muestra de una conversación afectada:');
    muestra.reverse().forEach((m) =>
      console.log(
        `   ${new Date(m.createdAt).toISOString().slice(11, 23)}  cuenta=${String(m.whatsappAccount || '—').slice(-6)}  origin=${m.origin || '—'}  id=…${String(m.externalId || '').slice(-18)}  «${String(m.body || '').slice(0, 30)}»`
      )
    );
  }

  // ── ¿Existe el índice único que lo impediría? ─────────────────────────
  const idx = await Message.indexes();
  const unicoExt = idx.find((i) => i.unique && i.key && i.key.externalId);
  console.log(`\n── Índice único sobre externalId: ${unicoExt ? 'SÍ' : 'NO ← nada lo impide en la base'}`);

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
