/**
 * "Marcar como visto" respeta el mismo candado que el resto del chat: el asesor
 * responsable y los supervisores pueden hacerlo; otro call center no ve ni altera
 * el pendiente de una conversación privada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const mongoose = require('mongoose');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedAssignedConversation(clinicId, ownerId) {
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999000111',
    channel: 'whatsapp',
    assignedTo: ownerId, // asignada a OTRO agente
    assignedToName: 'Dueña del chat',
    unreadCount: 3,
    lastMessageDirection: 'in',
  });
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola', isRead: false });
  return conv;
}

test('un agente NO asignado no puede marcar como visto el chat privado de otro', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const otherAgent = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner);

  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, otherAgent, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );

  assert.equal(res.statusCode, 403);

  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.unreadCount, 3, 'no debe alterar el pendiente ajeno');
  const unreadMsgs = await Message.countDocuments({ conversation: conv._id, direction: 'in', isRead: false });
  assert.equal(unreadMsgs, 1, 'no debe marcar mensajes ajenos como leídos');
});

test('el asesor asignado sí puede marcar su chat como visto', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner);
  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, owner, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 200);
  assert.equal((await Conversation.findById(conv._id).lean()).unreadCount, 0);
});

test('marcar como visto sigue exigiendo tener acceso a la bandeja', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, new mongoose.Types.ObjectId());

  // Un rol sin acceso al chat (p.ej. enfermería) NO puede.
  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, new mongoose.Types.ObjectId(), {}, { role: 'enfermeria', params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 403);
});
