/**
 * Motor del envío por goteo: manda una tanda y se reprograma.
 *
 * Lo llama un job cada minuto. Cada tanda:
 *   1. Comprueba que estemos dentro de la franja horaria y los días permitidos.
 *   2. Resuelve la audiencia EN VIVO (no una lista congelada al crear la campaña):
 *      así respeta a quien se dio de baja mientras el goteo estaba en marcha.
 *   3. Manda `batchSize` mensajes por la puerta única (utils/messaging) — que ya
 *      valida opt-out, consentimiento, ventana de 24 h y plantillas.
 *   4. Se reprograma dentro de `intervalMinutes`, o termina si no queda nadie.
 *
 * Todo mensaje sale por `messaging.send`, nunca directo al gateway: es lo que
 * garantiza que el envío masivo respete las mismas reglas que un mensaje suelto.
 */
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const DripCampaign = require('../models/DripCampaign');
const MessageTemplate = require('../models/MessageTemplate');
const messaging = require('./messaging');
const { buildSendableMatch } = require('./contactAudience');
const { buildContactTemplateVars } = require('./contactTemplateVars');
const { emitToCallCenter } = require('../realtime');

/**
 * ¿Toca enviar ahora? (franja horaria y días permitidos).
 * La hora local del proceso YA es la de Ecuador: index.js fuerza
 * TZ=America/Guayaquil, igual que asumen los flujos de mensajes.
 */
function withinSchedule(camp, now = new Date()) {
  const day = now.getDay();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (Array.isArray(camp.days) && camp.days.length && !camp.days.includes(day)) return false;
  if (camp.hourFrom && hhmm < camp.hourFrom) return false;
  if (camp.hourTo && hhmm > camp.hourTo) return false;
  return true;
}

/**
 * Conversación del contacto (se crea si no existe) para que el envío se vea en el
 * chat. Cuenta también los chats de "número oculto" (@lid) enlazados a ese
 * teléfono: si no, la campaña escribe por el chat viejo de Cloud API y no por el
 * número al que el contacto acaba de escribir. Ver findConversationForPerson.
 */
async function conversationFor(clinicId, contact) {
  let conv = await messaging.findConversationForPerson(clinicId, contact.phone, 'whatsapp');
  if (!conv) {
    conv = await Conversation.create({
      clinic: clinicId,
      phone: contact.phone,
      channel: 'whatsapp',
      contactName: contact.displayName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      patient: contact.patient || null,
    });
  }
  return conv;
}

/** Rellena {{variables}} de un texto libre con los datos del contacto (envíos por QR). */
function personalize(body, contact) {
  const first = contact.firstName || (contact.displayName || '').split(' ')[0] || '';
  const full = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.displayName || '';
  return String(body || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, first)
    .replace(/\{\{\s*nombre_completo\s*\}\}/gi, full);
}

/**
 * Envía UNA tanda. Devuelve { sent, failed, skipped, remaining }.
 */
async function runBatch(camp) {
  const match = buildSendableMatch(camp.clinic, camp.group ? await camp.populate('group').then((c) => c.group) : null);
  // A los ya enviados no se les repite.
  const found = await Contact.find({
    $and: [match, { _id: { $nin: camp.sentContacts || [] } }],
  })
    .limit(camp.batchSize)
    .lean({ virtuals: true });

  if (!found.length) return { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  // UN ENVÍO POR TELÉFONO. `Contact` es único por (sede, teléfono): el mismo
  // número puede tener dos fichas si dos importaciones lo mandaron a sucursales
  // distintas. Sin este filtro la campaña le manda el mensaje DOS veces a la
  // misma persona (y Meta cobra las dos). Se queda la ficha actualizada más
  // recientemente, que es la que trae los datos de esta campaña.
  const byPhone = new Map();
  for (const c of found) {
    const prev = byPhone.get(c.phone);
    if (!prev || new Date(c.updatedAt || 0) > new Date(prev.updatedAt || 0)) byPhone.set(c.phone, c);
  }
  const pending = [...byPhone.values()];

  // Las fichas gemelas se marcan como enviadas junto con la que sí recibe el
  // mensaje: si no, la siguiente tanda las recogería y enviaría el duplicado igual.
  const twinsByPhone = new Map();
  const twins = await Contact.find({ phone: { $in: pending.map((c) => c.phone) } })
    .select('_id phone')
    .lean();
  for (const t of twins) {
    if (!twinsByPhone.has(t.phone)) twinsByPhone.set(t.phone, []);
    twinsByPhone.get(t.phone).push(t._id);
  }

  // La plantilla se lee UNA vez por tanda (no una por contacto): sus variables se
  // rellenan con los datos de cada contacto. Sin esto, messaging no encuentra
  // paciente y acaba mandando a todos el ejemplo de la plantilla.
  const tpl = camp.template
    ? await MessageTemplate.findById(camp.template).select('body variables').lean()
    : null;

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const contact of pending) {
    // eslint-disable-next-line no-await-in-loop
    const conv = await conversationFor(camp.clinic, contact);
    // eslint-disable-next-line no-await-in-loop
    const r = await messaging.send({
      clinicId: camp.clinic,
      channel: 'whatsapp',
      conversation: conv,
      to: contact.phone,
      patient: contact.patient || null,
      body: camp.template ? '' : personalize(camp.body, contact),
      mediaUrl: camp.mediaUrl || null,
      mediaType: camp.mediaType || null,
      template: camp.templateName
        ? {
            name: camp.templateName,
            language: camp.templateLanguage || 'es',
            vars: buildContactTemplateVars(tpl, contact, camp.templateVars),
          }
        : null,
      sentBy: camp.createdBy || null,
      sentByName: camp.createdByName || 'Campaña',
      source: 'drip',
      // Vacío = automático: cada contacto recibe el mensaje por el número con el
      // que él nos habló la última vez (y el principal si nunca nos escribió).
      // Con valor, toda la campaña sale por ese número.
      whatsappAccount: camp.whatsappAccount || null,
      // Ficha EXACTA de la que salen las variables de la campaña.
      contactId: contact._id,
    });

    if (r.skipped) skipped++;
    else if (r.ok) sent++;
    else failed++;
    // El teléfono queda marcado como atendido (también si se omitió: no se
    // reintenta cada tanda), incluidas sus fichas gemelas de otras sucursales.
    const done = twinsByPhone.get(contact.phone) || [contact._id];
    camp.sentContacts.push(...done);
    if (r.errorMessage) camp.lastError = r.errorMessage;
  }

  camp.stats.sent += sent;
  camp.stats.failed += failed;
  camp.stats.skipped += skipped;

  const remaining = await Contact.countDocuments({
    $and: [match, { _id: { $nin: camp.sentContacts } }],
  });
  return { sent, failed, skipped, remaining };
}

/** Procesa una campaña: una tanda y se reprograma (o termina). */
async function runCampaign(campId) {
  // El findOneAndUpdate con nextRunAt evita que dos ticks del job manden la misma
  // tanda dos veces (duplicaría mensajes al contacto: caro y embarazoso).
  const camp = await DripCampaign.findOneAndUpdate(
    { _id: campId, status: 'running', nextRunAt: { $lte: new Date() } },
    { $set: { nextRunAt: new Date(Date.now() + 60 * 60 * 1000) } }, // lo aparta mientras corre
    { new: true }
  );
  if (!camp) return null;

  try {
    if (!withinSchedule(camp)) {
      // Fuera de horario: se vuelve a mirar en 15 min, sin gastar mensajes.
      camp.nextRunAt = new Date(Date.now() + 15 * 60 * 1000);
      await camp.save();
      return camp;
    }
    const r = await runBatch(camp);
    if (r.remaining === 0) {
      camp.status = 'done';
      camp.finishedAt = new Date();
      camp.nextRunAt = null;
    } else {
      camp.nextRunAt = new Date(Date.now() + camp.intervalMinutes * 60 * 1000);
    }
    await camp.save();
    emitToCallCenter('drip:progress', {
      campaignId: String(camp._id),
      status: camp.status,
      stats: camp.stats,
      remaining: r.remaining,
      nextRunAt: camp.nextRunAt,
    });
  } catch (e) {
    camp.status = 'failed';
    camp.lastError = e.message;
    camp.nextRunAt = null;
    await camp.save();
  }
  return camp;
}

/** Job: campañas de goteo con tanda vencida. */
async function processDueDrips() {
  const due = await DripCampaign.find({ status: 'running', nextRunAt: { $lte: new Date() } })
    .select('_id')
    .limit(10);
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    await runCampaign(d._id).catch((e) => console.error('[drip]', e.message));
  }
}

module.exports = { runCampaign, processDueDrips, runBatch, withinSchedule, personalize };
