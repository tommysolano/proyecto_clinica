/**
 * Backfill de la ventana de 24h de WhatsApp: rellena `lastInboundAt` (y de paso
 * `window24hExpiresAt`) en las conversaciones que no lo tenían.
 *
 * POR QUÉ HACE FALTA: la ventana de 24h se guardaba en `window24hExpiresAt`, pero
 * el fallback del front solo funcionaba si el ÚLTIMO mensaje era entrante. En un
 * chat contestado (el agente respondió, o se mandó una cotización) el último
 * mensaje pasa a ser saliente y, si `window24hExpiresAt` faltaba (chats viejos,
 * o creados por un envío saliente), el sistema mostraba "ventana cerrada" aunque
 * el paciente hubiera escrito hace minutos.
 *
 * QUÉ HACE: por cada conversación de WhatsApp busca su ÚLTIMO mensaje ENTRANTE y
 * fija `lastInboundAt` = su fecha, y `window24hExpiresAt` = esa fecha + 24h
 * (siempre el valor más reciente entre lo que hubiera y lo calculado). Idempotente.
 *
 *   node scripts/backfillWhatsappWindow.js            (dry-run: informe)
 *   node scripts/backfillWhatsappWindow.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function run() {
  const opts = parseArgs();
  banner('Backfill de la ventana de 24h de WhatsApp (lastInboundAt)', opts);

  await connect();
  try {
    const convs = await Conversation.find({ channel: 'whatsapp' })
      .select('_id lastInboundAt window24hExpiresAt')
      .lean();
    console.log(`Conversaciones de WhatsApp: ${convs.length}`);

    let updated = 0;
    let noInbound = 0;
    const ops = [];
    for (const c of convs) {
      // eslint-disable-next-line no-await-in-loop
      const lastIn = await Message.findOne({ conversation: c._id, direction: 'in' })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();
      if (!lastIn) { noInbound++; continue; }

      const inboundAt = new Date(lastIn.createdAt);
      const computedExpiry = new Date(inboundAt.getTime() + WINDOW_MS);
      const set = {};
      if (!c.lastInboundAt || new Date(c.lastInboundAt) < inboundAt) set.lastInboundAt = inboundAt;
      if (!c.window24hExpiresAt || new Date(c.window24hExpiresAt) < computedExpiry) {
        set.window24hExpiresAt = computedExpiry;
      }
      if (Object.keys(set).length) {
        ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: set } } });
        updated++;
      }
    }

    console.log(`  · A actualizar: ${updated}`);
    console.log(`  · Sin ningún entrante (no aplican): ${noInbound}`);

    if (opts.dryRun) {
      console.log('\nDry-run: no se escribió nada. Repite con --commit para aplicar.');
      return;
    }
    if (!ops.length) { console.log('\nNada que actualizar.'); return; }

    const r = await Conversation.bulkWrite(ops);
    console.log(`\nListo: ${r.modifiedCount} conversación(es) actualizada(s).`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
