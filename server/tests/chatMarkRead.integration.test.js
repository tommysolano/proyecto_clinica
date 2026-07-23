/**
 * "Marcar como visto" es una acción de BANDEJA, no administrativa: cualquier
 * agente con acceso al chat puede bajarle el pendiente a una conversación, esté
 * asignada a quien esté. Antes exigía ser el agente asignado y rebotaba con 403 a
 * los demás — justo lo que reportaron los usuarios.
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

test('un agente NO asignado puede marcar como visto un chat de otro', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const owner = new mongoose.Types.ObjectId();
  const otherAgent = new mongoose.Types.ObjectId();
  const conv = await seedAssignedConversation(clinicId, owner);

  const res = await H.runController(
    chat.markConversationRead,
    H.mockReq(clinicId, otherAgent, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );

  assert.equal(res.statusCode, 200, 'debe permitirlo (bandeja compartida)');
  assert.equal(res.payload.unreadCount, 0);

  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.unreadCount, 0, 'el pendiente quedó en 0');
  const unreadMsgs = await Message.countDocuments({ conversation: conv._id, direction: 'in', isRead: false });
  assert.equal(unreadMsgs, 0, 'los entrantes quedaron marcados como leídos');
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
