/**
 * Convierte a H.264 los VIDEOS ya guardados que WhatsApp no puede entregar.
 *
 * POR QUÉ
 * -------
 * WhatsApp Cloud API solo entrega video H.264 + AAC. Un MP4 con pista
 * H.265/HEVC —lo que graba cualquier iPhone reciente— es un archivo
 * perfectamente válido: Meta ACEPTA la subida, devuelve un media id y responde
 * 200 al enviar el mensaje... y después, al transcodificarlo para entregarlo,
 * falla y manda por webhook el estado `failed` con el código 131053. El agente
 * ve el mensaje enviado y de pronto en rojo, siempre con el mismo archivo.
 *
 * Medido en producción (16-ago-2026): de los cinco videos del sistema, uno era
 * `hevc/hvc1` (8,39 MB) y acumulaba SEIS envíos con SEIS fallos 131053; los
 * otros cuatro eran `h264/avc1` —dos de ellos más pesados, 11,1 y 11,8 MB— y
 * nunca fallaron. No era el tamaño: era el códec.
 *
 * Desde ahora las subidas se normalizan solas (ver utils/videoTranscode, que se
 * llama desde uploadSavedReplyMedia). Este script es para lo que YA estaba
 * guardado antes de ese cambio.
 *
 * QUÉ HACE
 * --------
 * Recorre los adjuntos de `chatgalleryimages` cuyo MIME es de video, mira lo que
 * hay dentro con ffmpeg y, si no es H.264+AAC (o no cabe en el tope de
 * WhatsApp), lo recodifica y sustituye los bytes.
 *
 * El _id del adjunto NO cambia, así que la URL pública `/api/public/media/:id`
 * sigue siendo la misma y todos los mensajes guardados que la referencian
 * siguen funcionando sin tocarlos. Se escribe con una clave de almacén NUEVA y
 * se borra la vieja solo después de verificar la nueva.
 *
 * OJO: la media se sirve con cache `immutable` de un año, así que el navegador
 * de un agente puede seguir enseñándole la miniatura vieja un tiempo. Lo que se
 * ENVÍA a WhatsApp se lee del disco, así que eso queda arreglado al instante.
 *
 *   node scripts/fixHevcVideos.js            (ensayo: solo informa, no escribe)
 *   node scripts/fixHevcVideos.js --commit   (aplica)
 *
 * HAZ UNA COPIA ANTES DE --commit:
 *   mongodump --uri="$MONGODB_URI" --out=/root/backup_clinica
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseArgs, connect, disconnect, banner } = require('./_common');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');
const videoTranscode = require('../utils/videoTranscode');

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const { commit, clinic, dryRun } = parseArgs();
  banner('Convertir a H.264 los videos que WhatsApp no entrega', { dryRun, clinic });

  await connect();

  const filter = { mimeType: /^video\// };
  if (clinic) filter.clinic = clinic;
  const docs = await ChatGalleryImage.find(filter).sort({ createdAt: 1 });
  console.log(`Videos guardados: ${docs.length}\n`);

  const stats = { ok: 0, convertidos: 0, fallidos: 0, ilegibles: 0 };

  for (const doc of docs) {
    const etiqueta = `${doc.name || '(sin nombre)'} [${doc._id}]`;
    // Puerta única: sirve tanto si está en disco (lo normal) como si todavía
    // guarda base64 heredado (ver mediaStore.loadAttachment).
    // eslint-disable-next-line no-await-in-loop
    const att = await mediaStore.loadAttachment(doc._id).catch(() => null);
    if (!att?.buffer?.length) {
      stats.ilegibles++;
      console.log(`  ILEGIBLE  ${etiqueta}`);
      continue;
    }

    const id = crypto.randomBytes(8).toString('hex');
    const probePath = path.join(os.tmpdir(), `fixhevc_${id}.mp4`);
    let probe;
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.writeFile(probePath, att.buffer);
      // eslint-disable-next-line no-await-in-loop
      probe = await videoTranscode.probeMedia(probePath);
    } finally {
      fs.promises.unlink(probePath).catch(() => {});
    }

    const motivo = videoTranscode.transcodeReason({
      mimeType: att.mimeType,
      bytes: att.buffer.length,
      probe,
    });
    const dentro = probe?.ok ? `${probe.videoCodec}/${probe.audioCodec || 'sin audio'}` : 'ilegible';

    if (!motivo) {
      stats.ok++;
      console.log(`  OK        ${etiqueta} — ${dentro}, ${mb(att.buffer.length)}`);
      continue;
    }

    console.log(`  CONVERTIR ${etiqueta} — ${dentro}, ${mb(att.buffer.length)}`);
    console.log(`            motivo: ${motivo}`);
    if (dryRun) { stats.convertidos++; continue; }

    // eslint-disable-next-line no-await-in-loop
    const conv = await videoTranscode.toWhatsappVideo(
      `data:${att.mimeType};base64,${att.buffer.toString('base64')}`
    );
    if (!conv.ok) {
      stats.fallidos++;
      console.log(`            FALLÓ: ${conv.error}`);
      continue;
    }

    const bytes = Buffer.from(conv.dataUrl.split(',')[1], 'base64');
    const claveVieja = doc.storageKey;
    // Clave NUEVA: se escribe el archivo nuevo antes de tocar el documento, y la
    // clave vieja no se borra hasta haber releído y verificado la nueva.
    // eslint-disable-next-line no-await-in-loop
    const escrito = await mediaStore.write({
      id: doc._id,
      buffer: bytes,
      mimeType: conv.mimeType,
      when: new Date(),
    });
    // eslint-disable-next-line no-await-in-loop
    const releido = await mediaStore.read(escrito.storageKey);
    if (!releido || releido.length !== bytes.length) {
      stats.fallidos++;
      console.log('            FALLÓ: la verificación tras escribir no cuadró; no se toca el documento.');
      continue;
    }

    doc.storageKey = escrito.storageKey;
    doc.mimeType = conv.mimeType;
    doc.size = bytes.length;
    doc.dataUrl = undefined; // si quedaba base64 heredado, ya no hace falta
    // eslint-disable-next-line no-await-in-loop
    await doc.save();

    if (claveVieja && claveVieja !== escrito.storageKey) {
      // eslint-disable-next-line no-await-in-loop
      await mediaStore.remove(claveVieja).catch(() => {});
    }
    stats.convertidos++;
    console.log(`            HECHO: ${mb(att.buffer.length)} → ${mb(bytes.length)} (H.264)`);
  }

  console.log('\n--- Resumen ---');
  console.log(`  Ya estaban bien ....... ${stats.ok}`);
  console.log(`  ${dryRun ? 'Se convertirían' : 'Convertidos'} ....... ${stats.convertidos}`);
  console.log(`  Fallidos .............. ${stats.fallidos}`);
  console.log(`  Ilegibles ............. ${stats.ilegibles}`);
  if (dryRun && stats.convertidos) console.log('\nVuelve a ejecutarlo con --commit para aplicarlo.');

  await disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
