/**
 * Backfill de `Conversation.lastAgentReplyBy` / `lastAgentReplyName`: QUIÉN
 * atendió por última vez cada chat.
 *
 * POR QUÉ HACE FALTA: la bandeja mostraba el agente ASIGNADO (`assignedToName`),
 * que se fija con el PRIMERO que tocó el chat y ya no se mueve salvo transferencia.
 * Por eso un chat seguía diciendo "Emily" aunque llevara semanas contestándolo
 * otra persona. Ahora la fila y la cabecera muestran la última asesora que
 * respondió — pero ese campo lo escribe el envío, así que nace vacío en todo el
 * histórico: sin este backfill, los chats antiguos no muestran a nadie hasta que
 * alguien vuelva a contestarlos.
 *
 * QUÉ HACE: por cada conversación, copia el remitente de su ÚLTIMO mensaje
 * saliente que sea una respuesta de verdad. Idempotente: solo escribe las que no
 * lo tienen o lo tienen distinto.
 *
 * Qué NO cuenta como respuesta (mismo criterio que el envío en vivo):
 *   · `kind: 'event'` — los chips de oportunidad llevan `sentBy` pero mover una
 *     etapa no es atender el chat (ver utils/opportunities.js).
 *   · salientes automáticos y de workflow — no traen `sentBy`.
 * Sí cuenta, y se rotula tal cual, lo escrito desde el móvil (`origin: 'phone'`,
 * sin usuario del CRM): decir "WhatsApp (teléfono)" es preferible a atribuírselo
 * a una asesora que no fue.
 *
 * LIMITACIÓN CONOCIDA: los envíos masivos históricos no se pueden distinguir
 * (el mensaje no guarda esa marca), así que un chat cuyo último saliente humano
 * fuera una difusión quedará con el nombre de quien la mandó. A partir de ahora
 * ya no ocurre: el envío masivo va con `broadcast: true` y no pisa este campo.
 *
 * De UNA agregación, no de una consulta por chat: son decenas de miles de
 * conversaciones y contra una base remota eso son horas.
 *
 *   node scripts/backfillLastAgentReply.js            (dry-run: informe)
 *   node scripts/backfillLastAgentReply.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

async function run() {
  const opts = parseArgs();
  banner('Backfill de la última asesora que respondió (lastAgentReplyBy/Name)', opts);

  await connect();
  try {
    const convs = await Conversation.find({})
      .select('_id lastAgentReplyBy lastAgentReplyName')
      .lean();
    console.log(`Conversaciones: ${convs.length}`);

    // Último saliente "de persona" de cada conversación, de una pasada.
    const ultimos = await Message.aggregate([
      {
        $match: {
          direction: 'out',
          kind: { $ne: 'event' },
          $or: [{ sentBy: { $ne: null } }, { origin: 'phone' }],
        },
      },
      { $sort: { conversation: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$conversation',
          sentBy: { $first: '$sentBy' },
          sentByName: { $first: '$sentByName' },
          origin: { $first: '$origin' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]).allowDiskUse(true);
    const porConv = new Map(ultimos.map((u) => [String(u._id), u]));
    console.log(`Conversaciones con alguna respuesta de persona: ${porConv.size}`);

    let sinRespuesta = 0;
    let desdeTelefono = 0;
    const ops = [];
    for (const c of convs) {
      const u = porConv.get(String(c._id));
      if (!u) { sinRespuesta++; continue; }
      const desdeMovil = !u.sentBy && u.origin === 'phone';
      if (desdeMovil) desdeTelefono++;
      const by = u.sentBy || null;
      const name = desdeMovil ? 'WhatsApp (teléfono)' : String(u.sentByName || '').trim();
      // Un saliente humano sin nombre anotado no aporta nada que mostrar.
      if (!name) { sinRespuesta++; continue; }
      const igual =
        String(c.lastAgentReplyBy || '') === String(by || '') &&
        String(c.lastAgentReplyName || '') === name;
      if (igual) continue;
      ops.push({
        updateOne: {
          filter: { _id: c._id },
          update: { $set: { lastAgentReplyBy: by, lastAgentReplyName: name, lastAgentReplyAt: u.createdAt } },
        },
      });
    }

    console.log(`  · A rellenar: ${ops.length}`);
    console.log(`  · De los cuales, contestados desde el móvil: ${desdeTelefono}`);
    console.log(`  · Sin ninguna respuesta de persona (se quedan vacíos): ${sinRespuesta}`);

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
