/**
 * "Marcar como visto" respeta el candado exclusivo de workflow, pero una
 * asignacion operativa normal continua siendo compartida.
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

async function seedAssignedConversation(clinicId, ownerId, restricted = false) {
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999000111',
    channel: 'whatsapp',
    assignedTo: ownerId, // asignada a OTRO agente
    assignedToName: 'Dueña del chat',
    workflowRestrictedTo: restricted ? ownerId : null,
    unreadCount: 3,
    lastMessageDirection: 'in',
  });
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola', isRead: false });
  return conv;
}

test('un agente no asignado SI puede marcar como visto una asignacion normal compartida', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const otherAgent = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner);

  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, otherAgent, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );

  assert.equal(res.statusCode, 200);

  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.unreadCount, 0);
  const unreadMsgs = await Message.countDocuments({ conversation: conv._id, direction: 'in', isRead: false });
  assert.equal(unreadMsgs, 0);
});

test('un chat leído se puede marcar como no leído y luego volver a leído', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner);
  const latest = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'in',
    body: 'Mensaje más reciente',
    isRead: false,
    createdAt: new Date(Date.now() + 1000),
  });

  // Contrato anterior, sin body: sigue marcando como leído.
  await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, owner, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );

  const unreadRes = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, owner, { read: false }, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(unreadRes.statusCode, 200);
  assert.equal(unreadRes.payload.read, false);
  assert.equal(unreadRes.payload.unreadCount, 1);
  assert.equal((await Conversation.findById(conv._id).lean()).unreadCount, 1);

  const unreadMessages = await Message.find({ conversation: conv._id, direction: 'in', isRead: false }).lean();
  assert.equal(unreadMessages.length, 1, 'solo el último entrante representa el recordatorio');
  assert.equal(String(unreadMessages[0]._id), String(latest._id));

  const readAgain = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, owner, { read: true }, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(readAgain.payload.read, true);
  assert.equal(readAgain.payload.unreadCount, 0);
  assert.equal(await Message.countDocuments({ conversation: conv._id, direction: 'in', isRead: false }), 0);
});

test('un agente ajeno no puede marcar como visto un chat restringido por workflow', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner, true);
  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, new mongoose.Types.ObjectId(), {}, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 403);
  assert.equal((await Conversation.findById(conv._id).lean()).unreadCount, 3);
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
