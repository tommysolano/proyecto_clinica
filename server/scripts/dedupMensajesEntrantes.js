/**
 * Borra las COPIAS de los mensajes entrantes duplicados y deja el índice único
 * que impide que vuelvan.
 *
 * POR QUÉ HAY COPIAS: una sesión QR que figuraba conectada pero estaba muerta se
 * reconectaba SIN destruir el cliente viejo, así que quedaban dos (o cinco)
 * clientes escuchando y el mismo mensaje se ingería una vez por cada uno. La
 * comprobación de duplicado era leer-y-luego-escribir y con ~118 ms de ida y
 * vuelta a Atlas no protegía de nada. Las dos cosas están arregladas en el
 * código; esto limpia lo que quedó.
 *
 * SE CONSERVA LA COPIA MÁS ANTIGUA de cada grupo: es la que vieron los agentes,
 * la que referencian las citas de otros mensajes y la que marca la ventana de
 * 24 h. Las demás se borran.
 *
 * Es IDEMPOTENTE: se puede correr las veces que haga falta.
 *
 * Uso (por defecto NO escribe, solo cuenta):
 *   node scripts/dedupMensajesEntrantes.js
 *   node scripts/dedupMensajesEntrantes.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');

const NOMBRE_INDICE = 'clinic_1_externalId_1';

(async () => {
  const commit = process.argv.includes('--commit');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el entorno.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const M = mongoose.connection.collection('messages');

  // ── 1. Grupos con el mismo (clinic, externalId) entre los ENTRANTES ──
  const grupos = await M.aggregate(
    [
      { $match: { direction: 'in', externalId: { $type: 'string', $gt: '' } } },
      { $group: { _id: { c: '$clinic', e: '$externalId' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { n: { $gt: 1 } } },
    ],
    { allowDiskUse: true }
  ).toArray();

  const sobran = grupos.reduce((a, g) => a + (g.n - 1), 0);
  console.log(`Grupos duplicados:            ${grupos.length}`);
  console.log(`Copias a borrar:              ${sobran}`);

  if (!commit) {
    console.log('\n(simulación) No se ha escrito nada. Repite con --commit.');
    if (grupos.length) {
      console.log('\nEjemplos:');
      for (const g of grupos.slice(0, 5)) {
        // eslint-disable-next-line no-await-in-loop
        const m = await M.findOne({ _id: g.ids[0] }, { projection: { body: 1 } });
        console.log(`  ×${g.n}  «${String(m?.body || '').slice(0, 50)}»`);
      }
    }
    await mongoose.disconnect();
    return;
  }

  // ── 2. Borrar todo menos la copia MÁS ANTIGUA de cada grupo ──
  let borrados = 0;
  for (const g of grupos) {
    // Por _id ascendente: en Mongo el ObjectId lleva la marca de tiempo dentro,
    // así que el menor es el primero que se insertó.
    const orden = g.ids.slice().sort((a, b) => (String(a) < String(b) ? -1 : 1));
    const aBorrar = orden.slice(1);
    // eslint-disable-next-line no-await-in-loop
    const r = await M.deleteMany({ _id: { $in: aBorrar } });
    borrados += r.deletedCount;
  }
  console.log(`\nCopias borradas:              ${borrados}`);

  // ── 3. El índice único que impide que vuelvan ──
  const idx = await M.indexes();
  const ya = idx.find((i) => i.name === NOMBRE_INDICE);
  if (ya && !ya.unique) {
    // Existía como índice normal: hay que tirarlo para poder crearlo único.
    console.log('Quitando el índice no único anterior…');
    await M.dropIndex(NOMBRE_INDICE);
  }
  if (!ya || !ya.unique) {
    await M.createIndex(
      { clinic: 1, externalId: 1 },
      {
        unique: true,
        // Solo ENTRANTES: los salientes ya tienen su idempotencia por `clientId`,
        // y hacer fallar un envío por un choque de ids sería peor que el
        // duplicado que evita.
        partialFilterExpression: { direction: 'in', externalId: { $type: 'string', $gt: '' } },
        name: NOMBRE_INDICE,
      }
    );
    console.log('Índice único creado.');
  } else {
    console.log('El índice único ya estaba.');
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
