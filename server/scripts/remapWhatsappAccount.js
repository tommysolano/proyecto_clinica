/**
 * Traspasa las conversaciones (y su historial) de un número de WhatsApp a otro.
 *
 * PARA QUÉ. Cuando un número se borra —o se reconecta y queda guardado como un
 * número NUEVO— sus conversaciones se quedan apuntando al id viejo. Al responder,
 * la resolución del número no encuentra ese id y cae hasta el último recurso: el
 * número POR DEFECTO. El mensaje sale entonces por un teléfono al que ese contacto
 * nunca ha escrito, así que Meta lo rechaza con 131047 ("Re-engagement message") y
 * el paciente NO recibe nada, mientras el CRM enseñaba "ventana de 24h abierta".
 *
 * Pasó el 07-ago-2026: se borró el número QR de recepción y se reconectó como uno
 * nuevo. 4.585 chats quedaron colgando y al día siguiente 156 mensajes se
 * perdieron así en una mañana.
 *
 * QUÉ MUEVE: `Conversation.whatsappAccount`, `Conversation.lastInboundAccount`
 * (de él depende la ventana de 24h) y `Message.whatsappAccount`.
 *
 * ES REVERSIBLE: basta con volver a ejecutarlo con --from y --to al revés.
 *
 * Uso:
 *   node scripts/remapWhatsappAccount.js --from=<idViejo> --to=<idNuevo>
 *   node scripts/remapWhatsappAccount.js --from=<idViejo> --to=<idNuevo> --commit
 *   node scripts/remapWhatsappAccount.js --huerfanos            (lista los ids muertos)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');

function argValue(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
}

/**
 * Números enlazados en conversaciones que ya no están en uso.
 *
 * Un id cuenta como VIVO si es el de un número activo o uno de los `previousIds`
 * que ese número absorbió (mismo teléfono reconectado): esos se resuelven solos
 * y no hay nada que remapear a mano. Un número ARCHIVADO sí sale marcado: su
 * teléfono no ha vuelto todavía.
 */
async function listarHuerfanos() {
  const activos = await WhatsappAccount.find({ archivedAt: null }).select('_id previousIds').lean();
  const vivos = new Set(activos.flatMap((a) => [String(a._id), ...(a.previousIds || []).map(String)]));
  const grupos = await Conversation.aggregate([
    { $match: { whatsappAccount: { $ne: null } } },
    { $group: { _id: '$whatsappAccount', chats: { $sum: 1 }, ultimo: { $max: '$lastMessageAt' } } },
    { $sort: { chats: -1 } },
  ]);
  console.log('Números enlazados en las conversaciones:');
  for (const g of grupos) {
    const vivo = vivos.has(String(g._id));
    console.log(
      `  ${g._id} → ${g.chats} chats · último mensaje ${g.ultimo ? new Date(g.ultimo).toISOString() : '-'} · ${vivo ? 'VIVO' : '*** SIN NÚMERO EN LÍNEA ***'}`
    );
  }
  console.log('\nNúmeros existentes (destinos posibles):');
  for (const a of await WhatsappAccount.find().select('label connectionType displayPhone connectedPhone enabled archivedAt phoneKey').lean()) {
    console.log(
      `  ${a._id} · ${a.label} · ${a.connectionType} · ${a.displayPhone || a.connectedPhone || '-'} · ` +
      `tel=${a.phoneKey || '-'} · enabled=${a.enabled}${a.archivedAt ? ' · ARCHIVADO' : ''}`
    );
  }
}

async function main() {
  const opts = parseArgs();
  await connect();

  if (process.argv.includes('--huerfanos')) {
    await listarHuerfanos();
    return;
  }

  const from = argValue('from');
  const to = argValue('to');
  if (!from || !to) {
    console.error('Faltan --from=<id> y --to=<id>. Usa --huerfanos para ver los ids.');
    process.exitCode = 1;
    return;
  }
  if (from === to) {
    console.error('--from y --to son el mismo número.');
    process.exitCode = 1;
    return;
  }

  banner('Traspaso de conversaciones entre números de WhatsApp', opts);

  const destino = await WhatsappAccount.findById(to).lean();
  if (!destino) {
    console.error(`El número destino ${to} no existe.`);
    process.exitCode = 1;
    return;
  }
  const origen = await WhatsappAccount.findById(from).lean();
  console.log(`Origen : ${from} ${origen ? `(${origen.label})` : '(YA BORRADO)'}`);
  console.log(`Destino: ${to} (${destino.label} · ${destino.connectionType} · ${destino.displayPhone || destino.connectedPhone || '-'})\n`);

  const chats = await Conversation.countDocuments({ whatsappAccount: from });
  const ventanas = await Conversation.countDocuments({ lastInboundAccount: from });
  const mensajes = await Message.countDocuments({ whatsappAccount: from });
  console.log(`  Conversaciones a traspasar : ${chats}`);
  console.log(`  Ventanas de 24h a reatribuir: ${ventanas}`);
  console.log(`  Mensajes del historial      : ${mensajes}`);

  if (opts.dryRun) {
    console.log('\nDRY-RUN: no se ha escrito nada. Repite con --commit para aplicarlo.');
    return;
  }

  const r1 = await Conversation.updateMany({ whatsappAccount: from }, { $set: { whatsappAccount: to } });
  const r2 = await Conversation.updateMany({ lastInboundAccount: from }, { $set: { lastInboundAccount: to } });
  const r3 = await Message.updateMany({ whatsappAccount: from }, { $set: { whatsappAccount: to } });
  console.log(`\nHecho: ${r1.modifiedCount ?? 0} chats, ${r2.modifiedCount ?? 0} ventanas, ${r3.modifiedCount ?? 0} mensajes.`);
  console.log('Para deshacerlo: mismo comando con --from y --to intercambiados.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect();
  });
