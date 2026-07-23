/**
 * (1) Crear una oportunidad deja una MARCA INTERNA en el hilo (kind='event'),
 *     visible solo para el equipo y que NUNCA se envía al contacto por WhatsApp.
 * (2) Los contadores de no leídos (mine/all) para los badges del riel.
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

test('crear oportunidad deja un evento interno en el hilo (no se envía al contacto)', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999111222', channel: 'whatsapp' });

  const res = await H.runController(
    chat.addOpportunity,
    H.mockReq(clinicId, userId, { stage: 'nuevo', notes: 'Interesada en bioresonancia' }, {
      role: 'admin',
      params: { id: String(conv._id) },
    })
  );
  assert.equal(res.statusCode, 201);

  // Se creó un mensaje de tipo evento…
  const events = await Message.find({ conversation: conv._id, kind: 'event' }).lean();
  assert.equal(events.length, 1, 'debe existir exactamente un evento interno');
  const ev = events[0];
  assert.equal(ev.eventType, 'opportunity_created');
  assert.match(ev.body, /Oportunidad creada/);
  // …que NO es un mensaje enviable: sin dirección, sin id externo (no tocó al proveedor).
  assert.equal(ev.direction, undefined, 'un evento no tiene dirección in/out');
  assert.ok(!ev.externalId, 'el evento nunca se mandó a WhatsApp (sin wamid)');

  // La conversación NO se movió por el evento (lastMessageDirection sigue por defecto 'in').
  const fresh = await Conversation.findById(conv._id).lean();
  assert.ok(!fresh.lastMessagePreview || !/Oportunidad creada/.test(fresh.lastMessagePreview),
    'el evento no ensucia la vista previa de la lista');
});

test('contadores de no leídos: mine vs all', async () => {
  const clinicId = new mongoose.Types.ObjectId();
  const me = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();

  await Conversation.create({ clinic: clinicId, phone: '111', channel: 'whatsapp', unreadCount: 2, assignedTo: me });
  await Conversation.create({ clinic: clinicId, phone: '222', channel: 'whatsapp', unreadCount: 1, assignedTo: other });
  await Conversation.create({ clinic: clinicId, phone: '333', channel: 'whatsapp', unreadCount: 0, assignedTo: me });
  await Conversation.create({ clinic: clinicId, phone: '444', channel: 'whatsapp', unreadCount: 5 }); // sin asignar

  const res = await H.runController(chat.unreadCounts, H.mockReq(clinicId, me, {}, { role: 'call_center' }));
  assert.equal(res.statusCode, 200);
  // all = chats con unreadCount>0 = 111, 222, 444 = 3. mine = solo 111 = 1.
  assert.equal(res.payload.all, 3);
  assert.equal(res.payload.mine, 1);
});
