/**
 * Vinculación entre canales: Meta no comparte el teléfono real de quien escribe
 * por Messenger/Instagram (es un PSID/IGSID, no un número), así que un CRM no
 * puede "adivinarlo" solo. Lo que sí es real (y lo que hace este fix): cuando el
 * agente registra como paciente a alguien que escribió por Messenger/Instagram y
 * escribe su teléfono real, el sistema:
 *   1) vincula ESE chat al paciente,
 *   2) vincula EN EL ACTO cualquier otro chat (p.ej. WhatsApp) que ya tuviera ese
 *      mismo teléfono y no estuviera vinculado a nadie,
 *   3) expone esos chats vinculados en getConversation#linkedConversations, que
 *      alimenta las pestañas de canal del compositor (responder por cualquiera
 *      de ellos sin salir del chat).
 * De ahí en adelante, un futuro mensaje de WhatsApp desde ese teléfono ya se
 * reconoce solo (findPatientForIncoming/ingestExternalMessage, sin tocar aquí).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chatCtrl = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('registrar paciente desde un chat de Messenger SIN teléfono: 400 claro, no intenta vincular con un PSID como si fuera número', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, phone: '7000800090005000', externalUserId: '7000800090005000', channel: 'messenger',
  });

  const res = await H.runController(
    chatCtrl.registerPatientFromChat,
    H.mockReq(clinicId, userId, { firstName: 'Ana', lastName: 'Vera', gender: 'femenino' }, { params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 400, JSON.stringify(res.payload));
  assert.match(res.payload.message, /teléfono real/i);
  assert.equal(await Patient.countDocuments({ clinic: clinicId }), 0);
});

test('registrar paciente desde un chat de Instagram CON teléfono real: vincula ese chat Y, en el acto, el WhatsApp existente con el mismo número', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Chat de WhatsApp que YA existía (p.ej. escribió antes por ahí), sin paciente vinculado.
  const waConv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });
  const igConv = await Conversation.create({
    clinic: clinicId, phone: '9000800070006000', externalUserId: '9000800070006000', channel: 'instagram',
  });

  const res = await H.runController(
    chatCtrl.registerPatientFromChat,
    H.mockReq(
      clinicId, userId,
      { firstName: 'Ana', lastName: 'Vera', gender: 'femenino', phone: '0991234567' },
      { params: { id: String(igConv._id) } }
    )
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  const patientId = String(res.payload.patient._id);

  const igAfter = await Conversation.findById(igConv._id).lean();
  assert.equal(String(igAfter.patient), patientId);

  // El WhatsApp que YA existía con ese número quedó vinculado sin esperar a que
  // el contacto vuelva a escribir por ahí.
  const waAfter = await Conversation.findById(waConv._id).lean();
  assert.equal(String(waAfter.patient), patientId, 'el chat de WhatsApp preexistente debió vincularse en el acto');
});

test('getConversation expone linkedConversations: el chat de Instagram ve el de WhatsApp del mismo paciente, y viceversa', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera', phone: '0991234567' });
  const waConv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp', patient: patient._id });
  const igConv = await Conversation.create({
    clinic: clinicId, phone: '9000800070006000', externalUserId: '9000800070006000', channel: 'instagram', patient: patient._id,
  });

  const r1 = await H.runController(chatCtrl.getConversation, H.mockReq(clinicId, userId, {}, { params: { id: String(igConv._id) } }));
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.payload));
  assert.equal(r1.payload.linkedConversations.length, 1);
  assert.equal(r1.payload.linkedConversations[0].channel, 'whatsapp');
  assert.equal(String(r1.payload.linkedConversations[0]._id), String(waConv._id));

  const r2 = await H.runController(chatCtrl.getConversation, H.mockReq(clinicId, userId, {}, { params: { id: String(waConv._id) } }));
  assert.equal(r2.payload.linkedConversations.length, 1);
  assert.equal(r2.payload.linkedConversations[0].channel, 'instagram');
});

test('getConversation: chat sin paciente vinculado, o sin otros chats del mismo paciente, no trae pestañas (linkedConversations vacío)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  const res = await H.runController(chatCtrl.getConversation, H.mockReq(clinicId, userId, {}, { params: { id: String(conv._id) } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload.linkedConversations, []);
});

test('registrar paciente desde WhatsApp sigue funcionando igual que antes (usa conv.phone, no exige body.phone)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593991234567', channel: 'whatsapp' });

  const res = await H.runController(
    chatCtrl.registerPatientFromChat,
    H.mockReq(clinicId, userId, { firstName: 'Ana', lastName: 'Vera', gender: 'femenino' }, { params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.payload));
  assert.equal(res.payload.patient.phone, '593991234567');
});
