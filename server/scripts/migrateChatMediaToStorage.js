/**
 * Saca los adjuntos del chat de DENTRO de los mensajes y los deja en el almacén
 * (ChatGalleryImage), dejando en el mensaje solo su URL pública.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * La media que ENTRABA por WhatsApp (y la que WhatsApp nos devolvía de nuestros
 * propios envíos desde el teléfono) se guardaba como data URL base64 dentro del
 * documento del mensaje. Medido en producción el 25-jul-2026:
 *
 *     colección messages: 10.557 mensajes, 83.5 MB
 *     de esos, 114 mensajes con media inline: 73.2 MB  (el 88% del total)
 *     el mayor: 7.09 MB en UN mensaje
 *
 * Como `GET /chats/:id/messages` devolvía el hilo entero tal cual, abrir una
 * conversación con un solo video significaba descargar 6.8 MB de JSON antes de
 * pintar la primera burbuja. En la práctica el chat tardaba muchísimo o fallaba
 * con "Error al cargar mensajes", y el call center se quedaba sin poder atender
 * a ese contacto.
 *
 * QUÉ HACE
 * --------
 * Por cada mensaje con `mediaUrl` que empiece por `data:`:
 *   1. guarda los bytes en ChatGalleryImage con kind='inbound' (no aparece en la
 *      galería que el agente usa para enviar),
 *   2. sustituye `mediaUrl` por `/api/public/media/<id>`,
 *   3. rellena `mediaSize` si estaba vacío.
 *
 * NO se pierde ningún archivo: los bytes se copian ANTES de tocar el mensaje, y
 * si el guardado falla el mensaje se deja exactamente como estaba. Es idempotente:
 * un mensaje ya migrado no vuelve a tocarse, así que se puede correr las veces
 * que haga falta.
 *
 *   node scripts/migrateChatMediaToStorage.js            (dry-run: informe)
 *   node scripts/migrateChatMediaToStorage.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Message = require('../models/Message');
const { storeInlineMedia } = require('../utils/chatMedia');

const MB = 1024 * 1024;

async function run() {
  const opts = parseArgs();
  banner('Migración: adjuntos del chat fuera del documento del mensaje', opts);

  await connect();
  try {
    const filter = {
      mediaUrl: /^data:/,
      ...(opts.clinic ? { clinic: opts.clinic } : {}),
    };

    const total = await Message.countDocuments(filter);
    console.log(`Mensajes con el adjunto DENTRO del mensaje: ${total}`);
    if (!total) {
      console.log('Nada que migrar.');
      return;
    }

    let migrated = 0;
    let failed = 0;
    let bytesFreed = 0;
    const perConversation = new Map();

    // De uno en uno y sin cargar todo a memoria: son documentos de varios MB.
    const cursor = Message.find(filter)
      .select('_id clinic conversation mediaUrl mediaType mediaName mediaSize')
      .cursor();

    for await (const msg of cursor) {
      const size = Buffer.byteLength(msg.mediaUrl, 'utf8');
      bytesFreed += size;
      const key = String(msg.conversation);
      perConversation.set(key, (perConversation.get(key) || 0) + size);

      const label = `${msg.mediaType || 'adjunto'} de ${(size / MB).toFixed(2)} MB (msg ${msg._id})`;
      if (opts.dryRun) {
        console.log(`  [dry-run] movería ${label}`);
        migrated += 1;
        continue;
      }

      try {
        // 1) Los bytes se copian PRIMERO. Si esto falla, el mensaje no se toca.
        const stored = await storeInlineMedia({
          clinicId: msg.clinic,
          dataUrl: msg.mediaUrl,
          name: msg.mediaName || `${msg.mediaType || 'adjunto'}_${msg._id}`,
          kind: 'inbound',
        });
        if (!stored) {
          failed += 1;
          console.warn(`  ! data URL ilegible, se deja intacto: ${label}`);
          continue;
        }
        // 2) Recién ahora el mensaje apunta a la copia guardada.
        await Message.updateOne(
          { _id: msg._id },
          { $set: { mediaUrl: stored.url, mediaSize: msg.mediaSize || stored.size } }
        );
        migrated += 1;
        if (migrated % 10 === 0) console.log(`  … ${migrated}/${total}`);
      } catch (err) {
        failed += 1;
        console.error(`  ! error migrando ${label}: ${err.message}`);
      }
    }

    console.log('');
    console.log(`Adjuntos ${opts.dryRun ? 'a migrar' : 'migrados'}: ${migrated}`);
    if (failed) console.log(`Con error (intactos, se pueden reintentar): ${failed}`);
    console.log(`Peso que sale de los mensajes: ${(bytesFreed / MB).toFixed(1)} MB`);
    console.log(`Conversaciones que dejan de cargar lento: ${perConversation.size}`);

    const worst = [...perConversation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (worst.length) {
      console.log('\nLas que más aligeran:');
      worst.forEach(([id, bytes]) => console.log(`  ${(bytes / MB).toFixed(1)} MB  conversación ${id}`));
    }

    if (opts.dryRun) {
      console.log('\nDRY-RUN: no se escribió nada. Repite con --commit para aplicar.');
    } else {
      console.log('\nListo. Los chats afectados deberían abrir al instante.');
    }
  } finally {
    await disconnect();
  }
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
