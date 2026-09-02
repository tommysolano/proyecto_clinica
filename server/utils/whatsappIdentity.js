/**
 * IDENTIDAD ESTABLE DE UN NÚMERO DE WHATSAPP.
 *
 * EL PROBLEMA. Todo en el CRM cuelga del `_id` de la WhatsappAccount: de qué
 * número entró cada chat (`Conversation.whatsappAccount`), por cuál se abrió la
 * ventana de 24h (`lastInboundAccount`), por cuál salió cada mensaje. Ese id es
 * de un DOCUMENTO, no del teléfono: si el número se borra y se vuelve a crear
 * —el camino natural cuando "se cayó y hay que reconectarlo"— nace un id nuevo y
 * TODO el historial se queda apuntando a uno que ya no existe. La resolución del
 * número de salida cae hasta el final (el número por defecto) y los mensajes
 * salen por un teléfono al que ese paciente nunca escribió: Meta los rechaza con
 * 131047 y la ventana de 24h que el CRM anunciaba como abierta no existía. Pasó
 * el 07-ago-2026: 4.585 chats huérfanos y 156 mensajes perdidos al día siguiente.
 *
 * LA REGLA DE AHORA. La identidad de un número es SU TELÉFONO, no el id del
 * documento. De ahí las tres piezas de este módulo:
 *
 *  1. `phoneKey` — los dígitos del número, escritos en cuanto WhatsApp confirma
 *     la vinculación ('ready') o el usuario guarda el número de Cloud API. Es la
 *     identidad que sobrevive a desconexiones, borrados y reconexiones.
 *  2. Borrado LÓGICO (`archivedAt`) en vez de `deleteOne()`: el documento se
 *     queda como lápida, así que ningún chat apunta jamás a la nada.
 *  3. Adopción (`adoptIdentity`): cuando un número vuelve a conectarse —aunque
 *     sea en un documento NUEVO— reclama el historial de las lápidas con su
 *     mismo teléfono y se anota sus ids en `previousIds`. El chat vuelve a
 *     responderse por el número correcto y la ventana de 24h sigue viva.
 *
 * `previousIds` es además el "también soy yo" que consultan la resolución del
 * número de salida (whatsappGateway) y el cálculo de la ventana (messaging):
 * mientras el remapeo termina —o si quedó alguna fila sin mover— un chat que
 * recuerde el id VIEJO se sigue reconociendo como de este mismo número.
 */
const WhatsappAccount = require('../models/WhatsappAccount');

/** Dígitos de un teléfono ('+593 98 853 5561' → '593988535561'). */
function phoneKeyOf(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * ¿Dos teléfonos son EL MISMO? Además de la igualdad exacta se comparan las
 * últimas 9 cifras: el mismo número se escribe '0988535561' a mano y WhatsApp lo
 * reporta como '593988535561'. Sin esta comparación por cola, reconectar un
 * número tecleado en formato local no reconocería su propio historial.
 */
function samePhone(a, b) {
  const x = phoneKeyOf(a);
  const y = phoneKeyOf(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length, 9);
  return n >= 8 && x.slice(-n) === y.slice(-n);
}

/** Todos los teléfonos que un documento ha llegado a representar. */
function phoneKeysOf(account) {
  return [
    account?.phoneKey,
    account?.connectedPhone,
    account?.displayPhone,
    ...(Array.isArray(account?.previousPhoneKeys) ? account.previousPhoneKeys : []),
  ]
    .map(phoneKeyOf)
    .filter(Boolean);
}

/**
 * ¿`a` y `b` son el MISMO número físico? Por teléfono siempre; y en Cloud API
 * también por `phoneNumberId`, que es la identidad que asigna Meta (un número
 * dado de alta dos veces conserva su phoneNumberId aunque cambie el documento).
 */
function sameNumber(a, b) {
  if (!a || !b) return false;
  if (
    a.connectionType === 'cloud_api' &&
    b.connectionType === 'cloud_api' &&
    a.phoneNumberId &&
    String(a.phoneNumberId) === String(b.phoneNumberId)
  ) {
    return true;
  }
  const mine = phoneKeysOf(a);
  const theirs = phoneKeysOf(b);
  return mine.some((x) => theirs.some((y) => samePhone(x, y)));
}

/**
 * ¿El id `candidate` es ESTE número? Cierto para su propio `_id` y para
 * cualquiera de los documentos anteriores que absorbió (`previousIds`).
 */
function accountOwnsId(account, candidate) {
  if (!account || !candidate) return false;
  const id = String(candidate?._id || candidate);
  if (String(account._id) === id) return true;
  return (account.previousIds || []).some((prev) => String(prev) === id);
}

/**
 * Traspasa lo que cuelga de un número a otro: los chats, su ventana de 24h
 * (`lastInboundAccount`) y el historial de mensajes, más las llamadas, campañas
 * de goteo e importaciones que lo tuvieran fijado como número de salida.
 *
 * `moveHistory` distingue los DOS usos que esto tiene, que no son el mismo:
 *
 *  · `true` (por defecto) — ADOPCIÓN: es el MISMO teléfono, reconectado en otro
 *    documento. Todo se mueve, porque todo sigue siendo verdad: el contacto le
 *    escribió a ese teléfono y la ventana de 24h de Meta sigue viva ahí.
 *
 *  · `false` — REEMPLAZO por OTRO teléfono (borrar un número indicando destino).
 *    Aquí solo se mueve el ENLACE de salida (`whatsappAccount`): por dónde se le
 *    responde al contacto a partir de ahora. Mover también `lastInboundAccount`
 *    sería escribir una MENTIRA —diría que el contacto escribió a un número al
 *    que nunca escribió— y la ventana de 24h se daría por abierta en un teléfono
 *    donde Meta la rechaza con 131047. El historial de mensajes tampoco se toca:
 *    cada mensaje debe seguir diciendo por dónde salió o entró de verdad.
 */
async function reassignAccountLinks(fromId, toId, { moveHistory = true } = {}) {
  const Conversation = require('../models/Conversation');
  const Message = require('../models/Message');
  const [convs, inbound, msgs] = await Promise.all([
    Conversation.updateMany({ whatsappAccount: fromId }, { $set: { whatsappAccount: toId } }),
    moveHistory
      ? Conversation.updateMany({ lastInboundAccount: fromId }, { $set: { lastInboundAccount: toId } })
      : Promise.resolve({ modifiedCount: 0 }),
    moveHistory
      ? Message.updateMany({ whatsappAccount: fromId }, { $set: { whatsappAccount: toId } })
      : Promise.resolve({ modifiedCount: 0 }),
  ]);
  // Referencias secundarias: si el modelo no existe en esta instalación, se ignora.
  for (const name of ['Call', 'DripCampaign', 'ContactImport']) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await require(`../models/${name}`).updateMany(
        { whatsappAccount: fromId },
        { $set: { whatsappAccount: toId } }
      );
    } catch {
      /* modelo ausente o sin ese campo: nada que traspasar */
    }
  }
  return {
    conversations: convs.modifiedCount ?? convs.nModified ?? 0,
    windows: inbound.modifiedCount ?? inbound.nModified ?? 0,
    messages: msgs.modifiedCount ?? msgs.nModified ?? 0,
  };
}

/**
 * El número vuelve a estar en línea: reclama el historial de los documentos
 * ARCHIVADOS que representaban su mismo teléfono (borrados desde la app antes de
 * reconectarlo) y se apunta sus ids como suyos.
 *
 * Solo adopta lápidas: dos números ACTIVOS con el mismo teléfono son un error de
 * configuración que hay que ver, no algo que arreglar moviendo chats a ciegas.
 */
async function adoptIdentity(account) {
  if (!account?._id) return { adopted: 0 };
  const archived = await WhatsappAccount.find({
    _id: { $ne: account._id },
    archivedAt: { $ne: null },
  });
  const twins = archived.filter((old) => sameNumber(account, old));
  if (!twins.length) return { adopted: 0 };

  let moved = { conversations: 0, windows: 0, messages: 0 };
  const previousIds = new Set((account.previousIds || []).map(String));
  const previousPhoneKeys = new Set((account.previousPhoneKeys || []).filter(Boolean));
  for (const old of twins) {
    // eslint-disable-next-line no-await-in-loop
    const r = await reassignAccountLinks(old._id, account._id);
    moved = {
      conversations: moved.conversations + r.conversations,
      windows: moved.windows + r.windows,
      messages: moved.messages + r.messages,
    };
    previousIds.add(String(old._id));
    for (const prev of old.previousIds || []) previousIds.add(String(prev));
    for (const key of phoneKeysOf(old)) previousPhoneKeys.add(key);
    console.warn(
      '[whatsappIdentity] «%s» recupera el historial del número borrado %s: %d chats, %d ventanas, %d mensajes',
      account.label || account._id, String(old._id), r.conversations, r.windows, r.messages
    );
    // La lápida ya no guarda nada: su identidad vive ahora en `previousIds`.
    // eslint-disable-next-line no-await-in-loop
    await old.deleteOne().catch(() => {});
  }
  previousPhoneKeys.delete(account.phoneKey || '');
  account.previousIds = [...previousIds];
  account.previousPhoneKeys = [...previousPhoneKeys];
  await account.save();
  return { adopted: twins.length, ...moved };
}

/**
 * WhatsApp confirmó por QUÉ TELÉFONO quedó vinculado este documento. Fija su
 * identidad y, si el número había sido borrado y vuelto a crear, recupera todo
 * su historial. Es el único sitio donde se escribe `phoneKey` de un número QR.
 */
async function rememberLinkedPhone(accountId, phone) {
  const key = phoneKeyOf(phone);
  if (!accountId || !key) return null;
  const account = await WhatsappAccount.findById(accountId);
  if (!account) return null;
  const before = account.phoneKey || '';
  if (before && !samePhone(before, key)) {
    // Se escaneó OTRO teléfono en la misma conexión. No se bloquea (puede ser
    // intencionado: la clínica cambió de número), pero queda anotado: sin este
    // rastro, los chats del número anterior seguían colgando de aquí en silencio.
    console.warn(
      '[whatsappIdentity] «%s» cambió de teléfono: %s → %s. Los chats anteriores siguen enlazados a esta conexión.',
      account.label || account._id, before, key
    );
    if (!account.previousPhoneKeys.includes(before)) account.previousPhoneKeys.push(before);
  }
  account.phoneKey = key;
  await account.save();
  return adoptIdentity(account);
}

/**
 * El número que HEREDÓ los chats de un id que ya no está (porque se borró y se
 * volvió a crear). Es lo que evita que la resolución del número de salida caiga
 * al número por defecto y responda por un teléfono equivocado.
 */
async function findSuccessorAccount(oldId) {
  if (!oldId) return null;
  return WhatsappAccount.findOne({
    previousIds: oldId,
    enabled: true,
    archivedAt: null,
  });
}

/**
 * Rellena `phoneKey` en los números que venían de antes de que la identidad
 * fuera el teléfono. Idempotente y de un solo query: se llama al arrancar.
 */
async function backfillPhoneKeys() {
  try {
    const pending = await WhatsappAccount.find({
      $or: [{ phoneKey: '' }, { phoneKey: { $exists: false } }],
    });
    for (const acc of pending) {
      const key = phoneKeyOf(acc.connectedPhone || acc.displayPhone);
      if (!key) continue;
      acc.phoneKey = key;
      // eslint-disable-next-line no-await-in-loop
      await acc.save().catch(() => {});
    }
    return pending.length;
  } catch (e) {
    console.error('[whatsappIdentity] backfill:', e.message);
    return 0;
  }
}

module.exports = {
  accountOwnsId,
  adoptIdentity,
  backfillPhoneKeys,
  findSuccessorAccount,
  phoneKeyOf,
  phoneKeysOf,
  reassignAccountLinks,
  rememberLinkedPhone,
  sameNumber,
  samePhone,
};
