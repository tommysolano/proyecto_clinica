/**
 * Mueve TODOS los archivos del chat de MongoDB al disco del servidor y libera el
 * espacio que ocupaban en la base de datos.
 *
 * POR QUÉ
 * -------
 * Medido en producción el 25-jul-2026:
 *
 *     base de datos completa .......... 169 MB
 *     archivos en base64 .............. 149 MB  (88%)
 *       · 6 videos ....................  60 MB
 *       · media dentro de los mensajes.  76 MB
 *       · imágenes/audios subidos ......  12 MB
 *     TODA la operación de la clínica ..  20 MB
 *
 * El cluster es un M0 (512 MB, CPU y ancho de banda compartidos) a 118 ms del
 * servidor. Cada apertura de un chat con video arrastraba esos megas por el
 * cuello de botella... con 65 GB de disco libres en el propio servidor.
 *
 * QUÉ HACE (dos fases)
 * --------------------
 *   A) Mensajes cuyo adjunto sigue DENTRO del documento (`mediaUrl` = data:…):
 *      el archivo pasa al almacén y el mensaje se queda con su URL pública.
 *   B) Adjuntos de `chatgalleryimages` que aún guardan `dataUrl`: los bytes van
 *      al disco y se BORRA el base64 de Mongo (esto es lo que libera la cuota).
 *
 * SEGURIDAD
 * ---------
 * Ningún archivo se borra de Mongo hasta que sus bytes están en disco y se han
 * VUELTO A LEER comprobando tamaño y hash SHA-256. Si la verificación falla, el
 * base64 se queda donde está y el script sigue con el siguiente. Es idempotente y
 * se puede reanudar: lo ya migrado no se vuelve a tocar.
 *
 *   node scripts/migrateChatMediaToDisk.js            (ensayo: no escribe nada)
 *   node scripts/migrateChatMediaToDisk.js --commit   (aplica)
 *
 * HAZ UNA COPIA ANTES DE --commit:
 *   mongodump --uri="$MONGODB_URI" --out=/root/backup_clinica
 */
const crypto = require('crypto');
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Message = require('../models/Message');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');
const chatMedia = require('../utils/chatMedia');
const { parseDataUrl } = require('../utils/dataUrl');

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Escribe los bytes y los vuelve a leer del disco comparando tamaño y hash.
 * Devuelve la clave solo si todo cuadra: es la condición para poder borrar
 * después el base64 de Mongo sin riesgo de perder el archivo.
 */
async function writeVerified(id, buffer, mimeType) {
  const { storageKey } = await mediaStore.write({ id, buffer, mimeType });
  const readBack = await mediaStore.read(storageKey);
  if (!readBack) throw new Error('el archivo no se pudo releer del disco');
  if (readBack.length !== buffer.length) {
    throw new Error(`tamaño distinto al releer (${readBack.length} vs ${buffer.length})`);
  }
  if (sha256(readBack) !== sha256(buffer)) throw new Error('el hash no coincide al releer');
  return storageKey;
}

async function migrateMessages(opts, stats) {
  const filter = { mediaUrl: /^data:/, ...(opts.clinic ? { clinic: opts.clinic } : {}) };
  const total = await Message.countDocuments(filter);
  console.log(`\n── Fase A: adjuntos dentro de los mensajes ── ${total} encontrados`);
  if (!total) return;

  // En ENSAYO el peso se calcula EN EL SERVIDOR: descargar los 76 MB solo para
  // contarlos tardaría minutos y el enlace con Atlas es justo lo que sobra.
  if (opts.dryRun) {
    const [agg] = await Message.aggregate([
      { $match: filter },
      { $group: { _id: '$mediaType', n: { $sum: 1 }, b: { $sum: { $strLenBytes: { $toString: '$mediaUrl' } } } } },
      { $group: { _id: null, total: { $sum: '$b' }, n: { $sum: '$n' }, porTipo: { $push: { tipo: '$_id', n: '$n', b: '$b' } } } },
    ]);
    stats.messagesCount = agg?.n || 0;
    stats.messagesBytes = agg?.total || 0;
    (agg?.porTipo || []).sort((a, b) => b.b - a.b).forEach((t) => {
      console.log(`  ${String(t.tipo || '?').padEnd(10)} ${String(t.n).padStart(4)} archivos  ${MB(t.b).padStart(9)}`);
    });
    return;
  }

  const cursor = Message.find(filter)
    .select('_id clinic conversation mediaUrl mediaType mediaName mediaSize')
    .cursor();

  for await (const msg of cursor) {
    const bytes = Buffer.byteLength(msg.mediaUrl, 'utf8');
    stats.messagesBytes += bytes;
    stats.messagesCount += 1;
    try {
      // storeInlineMedia ya escribe en disco (ver utils/chatMedia + mediaStore).
      const stored = await chatMedia.storeInlineMedia({
        clinicId: msg.clinic,
        dataUrl: msg.mediaUrl,
        name: msg.mediaName || `${msg.mediaType || 'adjunto'}_${msg._id}`,
        kind: 'inbound',
      });
      if (!stored) {
        stats.failed += 1;
        console.warn(`  ! data URL ilegible, se deja intacto (msg ${msg._id})`);
        continue;
      }
      await Message.updateOne(
        { _id: msg._id },
        { $set: { mediaUrl: stored.url, mediaSize: msg.mediaSize || stored.size } }
      );
      stats.messagesDone += 1;
      if (stats.messagesDone % 20 === 0) console.log(`  … ${stats.messagesDone}/${total}`);
    } catch (err) {
      stats.failed += 1;
      console.error(`  ! error con el mensaje ${msg._id}: ${err.message}`);
    }
  }
  console.log(`  hechos: ${stats.messagesDone}/${total}`);
}

async function migrateAttachments(opts, stats) {
  const filter = {
    dataUrl: { $exists: true, $ne: null, $ne: '' },
    ...(opts.clinic ? { clinic: opts.clinic } : {}),
  };
  const total = await ChatGalleryImage.countDocuments(filter);
  console.log(`\n── Fase B: adjuntos con los bytes en Mongo ── ${total} encontrados`);
  if (!total) return;

  // Igual que en la fase A: en ensayo se pesa en el servidor, sin descargar nada.
  if (opts.dryRun) {
    const rows = await ChatGalleryImage.aggregate([
      { $match: filter },
      { $project: { name: 1, mimeType: 1, b: { $strLenBytes: { $toString: '$dataUrl' } } } },
      { $sort: { b: -1 } },
    ]);
    stats.attachCount = rows.length;
    stats.attachBytes = rows.reduce((t, r) => t + r.b, 0);
    rows.slice(0, 12).forEach((r) => {
      console.log(`  [ensayo] ${MB(r.b).padStart(9)}  ${(r.mimeType || '').padEnd(12)} ${(r.name || '').slice(0, 40)}`);
    });
    if (rows.length > 12) console.log(`  … y ${rows.length - 12} más`);
    return;
  }

  const cursor = ChatGalleryImage.find(filter).select('_id dataUrl mimeType name storageKey').cursor();

  for await (const doc of cursor) {
    const bytes = Buffer.byteLength(doc.dataUrl, 'utf8');
    stats.attachBytes += bytes;
    stats.attachCount += 1;
    try {
      let key = doc.storageKey;
      if (!key) {
        const parsed = parseDataUrl(doc.dataUrl);
        if (!parsed) {
          stats.failed += 1;
          console.warn(`  ! data URL ilegible, se deja intacto (${doc._id})`);
          continue;
        }
        key = await writeVerified(doc._id, Buffer.from(parsed.b64, 'base64'), parsed.mimeType || doc.mimeType);
      } else if (!(await mediaStore.size(key))) {
        // Dice tener archivo pero no está: se reescribe antes de borrar el base64.
        const parsed = parseDataUrl(doc.dataUrl);
        if (!parsed) { stats.failed += 1; continue; }
        key = await writeVerified(doc._id, Buffer.from(parsed.b64, 'base64'), parsed.mimeType || doc.mimeType);
      }
      // Solo AHORA, con los bytes verificados en disco, se suelta el base64.
      await ChatGalleryImage.updateOne(
        { _id: doc._id },
        { $set: { storageKey: key }, $unset: { dataUrl: '' } }
      );
      stats.attachDone += 1;
      stats.freed += bytes;
      console.log(`  ✓ ${MB(bytes).padStart(9)}  ${(doc.name || '').slice(0, 45)}`);
    } catch (err) {
      stats.failed += 1;
      console.error(`  ! ${doc._id}: ${err.message} — el base64 NO se ha borrado`);
    }
  }
}

async function run() {
  const opts = parseArgs();
  banner('Migración: archivos del chat de MongoDB al disco del servidor', opts);
  console.log(`Almacén en disco: ${mediaStore.rootDir()}\n`);

  await connect();
  const stats = {
    messagesCount: 0, messagesDone: 0, messagesBytes: 0,
    attachCount: 0, attachDone: 0, attachBytes: 0,
    freed: 0, failed: 0,
  };
  try {
    await migrateMessages(opts, stats);
    await migrateAttachments(opts, stats);

    console.log('\n════════ RESUMEN ════════');
    console.log(`Fase A (mensajes):   ${opts.dryRun ? stats.messagesCount + ' a migrar' : stats.messagesDone + '/' + stats.messagesCount} · ${MB(stats.messagesBytes)}`);
    console.log(`Fase B (adjuntos):   ${opts.dryRun ? stats.attachCount + ' a migrar' : stats.attachDone + '/' + stats.attachCount} · ${MB(stats.attachBytes)}`);
    if (stats.failed) console.log(`Con error (intactos, se pueden reintentar): ${stats.failed}`);

    if (opts.dryRun) {
      console.log(`\nSe liberarían de MongoDB: ~${MB(stats.messagesBytes + stats.attachBytes)}`);
      console.log('ENSAYO: no se escribió nada. Repite con --commit para aplicar.');
    } else {
      console.log(`\nLiberado de MongoDB: ${MB(stats.freed)}`);
      const st = await require('mongoose').connection.db.command({ collStats: 'chatgalleryimages' }).catch(() => null);
      if (st) console.log(`chatgalleryimages ahora: ${MB(st.size)} (${st.count} adjuntos)`);
      const ms = await require('mongoose').connection.db.command({ collStats: 'messages' }).catch(() => null);
      if (ms) console.log(`messages ahora:          ${MB(ms.size)} (${ms.count} mensajes)`);
      console.log('\nListo. Comprueba en el chat que las fotos y los videos se siguen viendo.');
    }
  } finally {
    await disconnect();
  }
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
