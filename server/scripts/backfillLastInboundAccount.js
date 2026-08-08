/**
 * Backfill de `Conversation.lastInboundAccount`: POR QUÉ NÚMERO llegó el último
 * mensaje del contacto.
 *
 * POR QUÉ HACE FALTA: la ventana de 24h de WhatsApp es de la pareja (número de la
 * clínica, contacto). Que un paciente le escriba al WhatsApp de recepción no abre
 * ninguna ventana en el número de la Cloud API. Mientras la ventana se calculó
 * solo con la FECHA del último entrante, sin mirar por dónde entró, el CRM
 * enseñaba "ventana abierta, te quedan 8 h" y Meta rechazaba el texto libre con
 * 131047: el paciente no recibía nada.
 *
 * El campo lo escribe ya la ingesta de entrantes, pero nace vacío en todo el
 * histórico. Sin este backfill, los chats anteriores al cambio siguen sin poder
 * comprobar la regla (se les aplica el comportamiento antiguo: "no sé por dónde
 * entró" no puede convertirse en "cerrada" para media bandeja).
 *
 * QUÉ HACE: por cada conversación de WhatsApp con entrante, copia el
 * `whatsappAccount` de su ÚLTIMO mensaje entrante. Idempotente: solo escribe las
 * que no lo tienen o lo tienen distinto.
 *
 * De UNA agregación, no de una consulta por chat: son decenas de miles de
 * conversaciones y contra una base remota eso son horas.
 *
 *   node scripts/backfillLastInboundAccount.js            (dry-run: informe)
 *   node scripts/backfillLastInboundAccount.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

async function run() {
  const opts = parseArgs();
  banner('Backfill del número que abrió la ventana (lastInboundAccount)', opts);

  await connect();
  try {
    const convs = await Conversation.find({ channel: 'whatsapp', lastInboundAt: { $ne: null } })
      .select('_id lastInboundAccount')
      .lean();
    console.log(`Conversaciones de WhatsApp con algún entrante: ${convs.length}`);

    // Último entrante CON número anotado de cada conversación, de una pasada.
    const ultimos = await Message.aggregate([
      { $match: { direction: 'in', whatsappAccount: { $ne: null } } },
      { $sort: { conversation: 1, createdAt: -1 } },
      { $group: { _id: '$conversation', cuenta: { $first: '$whatsappAccount' } } },
    ]).allowDiskUse(true);
    const porConv = new Map(ultimos.map((u) => [String(u._id), u.cuenta]));
    console.log(`Conversaciones con el número anotado en algún entrante: ${porConv.size}`);

    let sinNumero = 0;
    const ops = [];
    for (const c of convs) {
      const cuenta = porConv.get(String(c._id));
      if (!cuenta) { sinNumero++; continue; }
      if (String(c.lastInboundAccount || '') === String(cuenta)) continue;
      ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: { lastInboundAccount: cuenta } } } });
    }

    console.log(`  · A rellenar: ${ops.length}`);
    console.log(`  · Sin número anotado en ningún entrante (se quedan como estaban): ${sinNumero}`);

    if (opts.dryRun) {
      console.log('\nDry-run: no se escribió nada. Repite con --commit para aplicar.');
      return;
    }
    if (!ops.length) { console.log('\nNada que rellenar.'); return; }

    // Por lotes: son decenas de miles y un bulkWrite gigante se come la memoria.
    let hechos = 0;
    for (let i = 0; i < ops.length; i += 1000) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Conversation.bulkWrite(ops.slice(i, i + 1000));
      hechos += r.modifiedCount ?? 0;
    }
    console.log(`\nListo: ${hechos} conversación(es) actualizada(s).`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
