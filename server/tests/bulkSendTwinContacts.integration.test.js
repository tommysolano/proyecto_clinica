/**
 * Envío masivo: la MISMA persona, una sola vez y con SUS datos.
 *
 * Los tres fallos de este archivo se dieron juntos en producción el 27-jul-2026 y
 * cuestan dinero: son plantillas y Meta cobra cada envío.
 *
 * La raíz de los dos primeros es la misma: `Contact` es único por (SEDE, teléfono),
 * no por teléfono. Si dos importaciones mandan el mismo número a sucursales
 * distintas —la columna "Sucursal" del Excel— acaban existiendo DOS fichas de la
 * misma persona. Entonces:
 *
 *   1. La importación inscribía las dos → el mismo WhatsApp recibía el mensaje
 *      DOS veces. Caso real: un archivo de 3 filas generó 4 inscripciones.
 *   2. Al rellenar la plantilla, el envío buscaba la ficha POR TELÉFONO y se
 *      quedaba con la primera del disco, que es la MÁS VIEJA. El recordatorio salió
 *      con "12:00 / bioresonancia" (ficha de otra sede, sin tocar desde hacía
 *      cuatro días) en vez del "08:00 / REVISION" del Excel recién importado.
 *
 * Y el tercero: una persona puede tener DOS chats (uno por el número de Cloud API
 * y otro, con identificador oculto @lid, por el del QR). Buscando solo por teléfono
 * se encontraba siempre el de Cloud, así que la campaña le escribía por ahí aunque
 * su última conversación real fuera la del QR.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const Contact = require('../models/Contact');
const ContactImport = require('../models/ContactImport');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const { enrollInWorkflows, runImport } = require('../utils/contactImportRunner');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593988535561';

/** Anota por qué cuenta y con qué parámetros salió cada mensaje. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate };
  gw.sendText = async (account, to, body) => {
    sent.push({ cuenta: account.label, to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, templateName, lang, components) => {
    const body = (components || []).find((c) => c.type === 'body');
    sent.push({
      cuenta: account.label,
      to,
      templateName,
      params: (body?.parameters || []).map((p) => p.text),
    });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

/** Las DOS fichas de la misma persona: una vieja en otra sede, otra recién importada. */
async function fichasGemelas(clinicId, otraSede) {
  const vieja = await Contact.create({
    clinic: otraSede,
    phone: TEL,
    displayName: 'Tommy Solano',
    customFields: { hora: '12:00', servicio: 'bioresonancia' },
  });
  // La de ESTA campaña: se toca después, así que es la más reciente.
  await new Promise((r) => setTimeout(r, 10));
  const nueva = await Contact.create({
    clinic: clinicId,
    phone: TEL,
    displayName: 'TOMMY',
    customFields: { hora: '08:00', servicio: 'REVISION' },
  });
  return { vieja, nueva };
}

function flujoRecordatorio(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Recordatorio 24h',
    active: true,
    trigger: { type: 'contact_import' },
    steps: [{ type: 'send_template', templateName: '24h_flujo', templateLanguage: 'es' }],
  });
}

function plantilla(clinicId) {
  return MessageTemplate.create({
    clinic: clinicId,
    channel: 'whatsapp',
    name: '24h_flujo',
    status: 'approved',
    body: 'Este es un recordatorio de tu cita de mañana a las {{hora}} para {{servicio}}.',
    variables: [
      { key: 'hora', example: '14:30' },
      { key: 'servicio', example: 'Limpieza facial' },
    ],
  });
}

// ─────────── 1. un solo mensaje por teléfono ───────────

test('la misma persona con ficha en dos sucursales recibe UN mensaje, no dos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otraSede = new mongoose.Types.ObjectId();
  await fichasGemelas(clinicId, otraSede);
  const wf = await flujoRecordatorio(clinicId);

  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'reco.xlsx', status: 'done',
    mapping: [{ column: 'Celular', field: 'phone' }],
    workflows: [wf._id], createdBy: userId,
  });

  const n = await enrollInWorkflows(batch, [TEL]);

  assert.equal(n, 1, 'dos fichas del mismo número no son dos personas: Meta cobra cada plantilla');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
  assert.match(batch.enrollWarning || '', /repetida en otra sucursal/i, 'y queda dicho por qué');
});

test('se inscribe la ficha ACTUALIZADA (la del Excel de ahora), no la vieja de otra sede', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otraSede = new mongoose.Types.ObjectId();
  const { nueva } = await fichasGemelas(clinicId, otraSede);
  const wf = await flujoRecordatorio(clinicId);

  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'reco.xlsx', status: 'done',
    mapping: [{ column: 'Celular', field: 'phone' }],
    workflows: [wf._id], createdBy: userId,
  });
  await enrollInWorkflows(batch, [TEL]);

  const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(e.context.contactId, String(nueva._id), 'la campaña usa los datos que se acaban de importar');
});

test('una inscripción viva bloquea otra del MISMO teléfono aunque sea de la otra ficha', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otraSede = new mongoose.Types.ObjectId();
  const { vieja } = await fichasGemelas(clinicId, otraSede);
  const wf = await flujoRecordatorio(clinicId);

  // Ya está en cola por la ficha de la otra sede.
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting',
    nextRunAt: new Date(Date.now() + 3600e3),
    context: { phone: TEL, contactId: String(vieja._id), eventType: 'contact_import' },
  });

  const batch = await ContactImport.create({
    clinic: clinicId, fileName: 'reco.xlsx', status: 'done',
    mapping: [{ column: 'Celular', field: 'phone' }],
    workflows: [wf._id], createdBy: userId, cancelPending: false,
  });

  assert.equal(await enrollInWorkflows(batch, [TEL]), 0, 'no se le encola dos veces al mismo número');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
});

// ─────────── 2. el mensaje lleva los datos de ESTA campaña ───────────

test('la plantilla se rellena con la ficha de la inscripción, no con la más vieja del mismo número', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const otraSede = new mongoose.Types.ObjectId();
    const { nueva } = await fichasGemelas(clinicId, otraSede);
    await plantilla(clinicId);
    await WhatsappAccount.create({
      label: 'Recepcion', connectionType: 'cloud_api', enabled: true, isDefault: true,
      phoneNumberId: '111', accessToken: 'tok',
    });

    const r = await messaging.send({
      clinicId,
      channel: 'whatsapp',
      to: TEL,
      template: { name: '24h_flujo', language: 'es' },
      contactId: nueva._id,
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.deepEqual(
      gw.sent[0].params,
      ['08:00', 'REVISION'],
      'el paciente tiene que recibir la hora y el servicio del Excel que se acaba de importar'
    );
  } finally {
    gw.restore();
  }
});

test('sin ficha indicada se usa la más RECIENTE del teléfono, nunca la primera del disco', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const otraSede = new mongoose.Types.ObjectId();
    await fichasGemelas(clinicId, otraSede);
    await plantilla(clinicId);
    await WhatsappAccount.create({
      label: 'Recepcion', connectionType: 'cloud_api', enabled: true, isDefault: true,
      phoneNumberId: '111', accessToken: 'tok',
    });

    await messaging.send({
      clinicId, channel: 'whatsapp', to: TEL, template: { name: '24h_flujo', language: 'es' },
    });

    assert.deepEqual(gw.sent[0].params, ['08:00', 'REVISION']);
  } finally {
    gw.restore();
  }
});

// ─────────── 3. la importación ya no crea la ficha gemela ───────────

test('importar el mismo número a OTRA sucursal actualiza su ficha, no crea una segunda', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otraSede = new mongoose.Types.ObjectId();
  const previo = await Contact.create({
    clinic: otraSede, phone: TEL, displayName: 'Tommy', customFields: { servicio: 'bioresonancia' },
  });

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const csv = path.join(os.tmpdir(), `imp_${Date.now()}.csv`);
  fs.writeFileSync(csv, `Celular,Servicio\n${TEL},REVISION\n`, 'utf8');

  const batch = await ContactImport.create({
    clinic: clinicId,
    fileName: 'reco.csv',
    filePath: csv,
    host: os.hostname(),
    status: 'pending',
    mapping: [
      { column: 'Celular', field: 'phone' },
      { column: 'Servicio', field: 'custom:servicio' },
    ],
    createdBy: userId,
  });

  await runImport(batch._id);

  const fichas = await Contact.find({ phone: TEL }).lean();
  assert.equal(fichas.length, 1, 'un teléfono = un contacto en toda la organización');
  assert.equal(String(fichas[0]._id), String(previo._id), 'se actualiza el que ya existía, esté en la sede que esté');
  assert.equal(fichas[0].customFields.servicio, 'REVISION', 'con los datos del Excel nuevo');
});

// ─────────── 4. por qué número sale: el último que usó el contacto ───────────

test('chat de número oculto (@lid) enlazado: se responde por el número del QR, no por el principal', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const api = await WhatsappAccount.create({
      label: 'Recepcion', connectionType: 'cloud_api', enabled: true, isDefault: true,
      phoneNumberId: '111', accessToken: 'tok',
    });
    const qr = await WhatsappAccount.create({
      label: 'GENERAL', connectionType: 'qr', enabled: true, status: 'connected',
    });

    // Chat viejo por Cloud API: el contacto escribió hace días.
    const porCloud = await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: TEL,
      whatsappAccount: api._id, lastInboundAt: new Date('2026-07-24T11:09:00-05:00'),
    });
    await Message.create({
      clinic: clinicId, conversation: porCloud._id, direction: 'in', body: 'test',
      whatsappAccount: api._id,
    });
    // Chat con identificador OCULTO por el QR: escribió esta mañana. `phone` no
    // puede ser el número real (ya lo ocupa el otro chat), va en `linkedPhone`.
    const porQr = await Conversation.create({
      clinic: clinicId, channel: 'whatsapp',
      phone: '204496395366461', externalUserId: '204496395366461@lid', linkedPhone: TEL,
      whatsappAccount: qr._id, lastInboundAt: new Date('2026-07-27T07:43:00-05:00'),
    });
    await Message.create({
      clinic: clinicId, conversation: porQr._id, direction: 'in', body: 'tommysolano18@hotmail.com',
      whatsappAccount: qr._id,
    });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', to: TEL, body: 'Recordatorio de tu cita',
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent[0].cuenta, 'GENERAL', 'se le escribe por donde él escribió esta mañana');
    assert.equal(
      String(r.conversation._id), String(porQr._id),
      'y queda en el chat que el contacto ve de verdad, no en el otro'
    );
  } finally {
    gw.restore();
  }
});

test('sin chat oculto enlazado nada cambia: manda el chat del teléfono de siempre', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const api = await WhatsappAccount.create({
      label: 'Recepcion', connectionType: 'cloud_api', enabled: true, isDefault: true,
      phoneNumberId: '111', accessToken: 'tok',
    });
    const conv = await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: TEL,
      whatsappAccount: api._id, lastInboundAt: new Date(),
    });

    const r = await messaging.send({ clinicId, channel: 'whatsapp', to: TEL, body: 'Hola' });

    assert.equal(gw.sent[0].cuenta, 'Recepcion');
    assert.equal(String(r.conversation._id), String(conv._id));
  } finally {
    gw.restore();
  }
});
