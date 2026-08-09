const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('un call center solo lista chats libres o asignados a él; marketing ve todos', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = new H.mongoose.Types.ObjectId();
  const jaime = new H.mongoose.Types.ObjectId();

  await Conversation.create({ clinic: clinicId, phone: '593111111111', assignedTo: ana, assignedToName: 'Ana' });
  await Conversation.create({ clinic: clinicId, phone: '593222222222', assignedTo: jaime, assignedToName: 'Jaime' });
  await Conversation.create({ clinic: clinicId, phone: '593333333333' });

  const asAna = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, ana, {}, { role: 'call_center' })
  );
  assert.equal(asAna.statusCode, 200);
  assert.deepEqual(
    new Set(asAna.payload.map((conv) => conv.phone)),
    new Set(['593111111111', '593333333333'])
  );

  const asMarketing = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'marketing' })
  );
  assert.equal(asMarketing.statusCode, 200);
  assert.equal(asMarketing.payload.length, 3);
});

test('un asesor no puede abrir por ID el chat asignado a otro', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = new H.mongoose.Types.ObjectId();
  const jaime = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593444444444', assignedTo: jaime, assignedToName: 'Jaime',
  });

  const denied = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, ana, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(denied.statusCode, 404);

  const owner = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, jaime, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.equal(owner.statusCode, 200);

  const admin = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'admin', params: { id: String(conv._id) } })
  );
  assert.equal(admin.statusCode, 200);
});

test('round-robin asigna únicamente a asesores que están en turno', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const daysOff = Array.from(
    { length: 7 },
    (_, day) => ({ day, enabled: false, start: '09:00', end: '18:00' })
  );
  await User.create({
    name: 'Fuera de turno', email: 'off-shift@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
    callCenterSchedule: { enabled: true, days: daysOff },
  });
  const available = await User.create({
    name: 'Disponible 24/7', email: 'available@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
    callCenterSchedule: { enabled: false },
  });
  const conv = await Conversation.create({ clinic: clinicId, phone: '593555555555' });

  const result = await H.runController(
    chat.autoAssign,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, {
      role: 'marketing', params: { id: String(conv._id) },
    })
  );
  assert.equal(result.statusCode, 200);
  assert.equal(String(result.payload.assignedTo), String(available._id));
});
