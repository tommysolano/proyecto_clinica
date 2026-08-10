const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const { syncWorkflowChatRestrictions } = require('../utils/workflowChatRestriction');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('la asignacion normal sigue compartida; solo la restriccion de workflow oculta el chat', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = new H.mongoose.Types.ObjectId();
  const jaime = new H.mongoose.Types.ObjectId();

  await Conversation.create({ clinic: clinicId, phone: '593111111111', assignedTo: ana, assignedToName: 'Ana' });
  await Conversation.create({ clinic: clinicId, phone: '593222222222', assignedTo: jaime, assignedToName: 'Jaime' });
  await Conversation.create({ clinic: clinicId, phone: '593333333333' });
  await Conversation.create({
    clinic: clinicId,
    phone: '593444444444',
    assignedTo: jaime,
    assignedToName: 'Jaime',
    workflowRestrictedTo: jaime,
  });

  const asAna = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, ana, {}, { role: 'call_center' })
  );
  assert.equal(asAna.statusCode, 200);
  assert.deepEqual(
    new Set(asAna.payload.map((conv) => conv.phone)),
    new Set(['593111111111', '593222222222', '593333333333'])
  );

  const asMarketing = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'marketing' })
  );
  assert.equal(asMarketing.statusCode, 200);
  assert.equal(asMarketing.payload.length, 4);
});

test('un asesor abre asignaciones normales ajenas pero no una restriccion de workflow ajena', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = new H.mongoose.Types.ObjectId();
  const jaime = new H.mongoose.Types.ObjectId();
  const shared = await Conversation.create({
    clinic: clinicId, phone: '593444444444', assignedTo: jaime, assignedToName: 'Jaime',
  });
  const restricted = await Conversation.create({
    clinic: clinicId,
    phone: '593444444445',
    assignedTo: jaime,
    assignedToName: 'Jaime',
    workflowRestrictedTo: jaime,
  });

  const sharedResult = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, ana, {}, { role: 'call_center', params: { id: String(shared._id) } })
  );
  assert.equal(sharedResult.statusCode, 200);

  const denied = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, ana, {}, { role: 'call_center', params: { id: String(restricted._id) } })
  );
  assert.equal(denied.statusCode, 404);

  const owner = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, jaime, {}, { role: 'call_center', params: { id: String(restricted._id) } })
  );
  assert.equal(owner.statusCode, 200);

  const admin = await H.runController(
    chat.getConversation,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'admin', params: { id: String(restricted._id) } })
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
  assert.equal(result.payload.workflowRestrictedTo, null, 'round-robin normal no vuelve privado el chat');
});

test('reasignar manualmente un chat restringido lo devuelve a la bandeja compartida', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const previous = await User.create({
    name: 'Anterior', email: 'anterior@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
  });
  const next = await User.create({
    name: 'Nuevo', email: 'nuevo@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
  });
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593555555556',
    assignedTo: previous._id,
    workflowRestrictedTo: previous._id,
  });
  const result = await H.runController(
    chat.assignConversation,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), { userId: String(next._id) }, {
      role: 'marketing', params: { id: String(conv._id) },
    })
  );
  assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
  assert.equal(String(result.payload.assignedTo), String(next._id));
  assert.equal(result.payload.workflowRestrictedTo, null);
});

test('la cola exclusiva se comparte fuera de turno y vuelve al asesor en su siguiente franja', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const owner = await User.create({
    name: 'Turno partido', email: 'turno-partido@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
    callCenterSchedule: {
      enabled: true,
      days: Array.from({ length: 7 }, (_, day) => ({
        day,
        enabled: day === 1,
        intervals: day === 1
          ? [{ start: '08:00', end: '12:00' }, { start: '16:00', end: '21:00' }]
          : [{ start: '09:00', end: '18:00' }],
      })),
    },
  });
  const backup = await User.create({
    name: 'Respaldo', email: 'respaldo-turno@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
  });
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593555555557',
    assignedTo: owner._id,
    assignedToName: owner.name,
    workflowRestrictedTo: owner._id,
    workflowRestrictionActive: true,
  });

  // Lunes 13:30 de Ecuador: hueco entre 08-12 y 16-21.
  let sync = await syncWorkflowChatRestrictions({
    agentId: owner._id,
    at: new Date('2026-08-10T18:30:00.000Z'),
    emit: false,
  });
  assert.equal(sync.changed, 1);
  let stored = await Conversation.findById(conv._id);
  assert.equal(stored.workflowRestrictionActive, false);

  let ownerList = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, owner._id, {}, { role: 'call_center' })
  );
  let backupList = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, backup._id, {}, { role: 'call_center' })
  );
  assert.equal(ownerList.payload.some((item) => String(item._id) === String(conv._id)), false);
  assert.equal(backupList.payload.some((item) => String(item._id) === String(conv._id)), true);

  // Mismo lunes 17:30 de Ecuador: segunda franja activa.
  sync = await syncWorkflowChatRestrictions({
    agentId: owner._id,
    at: new Date('2026-08-10T22:30:00.000Z'),
    emit: false,
  });
  assert.equal(sync.changed, 1);
  stored = await Conversation.findById(conv._id);
  assert.equal(stored.workflowRestrictionActive, true);

  ownerList = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, owner._id, {}, { role: 'call_center' })
  );
  backupList = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, backup._id, {}, { role: 'call_center' })
  );
  assert.equal(ownerList.payload.some((item) => String(item._id) === String(conv._id)), true);
  assert.equal(backupList.payload.some((item) => String(item._id) === String(conv._id)), false);

  const marketingList = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'marketing' })
  );
  assert.equal(marketingList.payload.some((item) => String(item._id) === String(conv._id)), true);
});
