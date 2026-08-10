/**
 * Transferir chat: cualquier usuario de la bandeja puede pasarle una
 * conversación a otro compañero (antes solo admin/supervisor podían reasignar;
 * el asesor únicamente podía "tomar" el chat para sí).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const makeUser = (clinicId, name, role = 'call_center', extra = {}) =>
  User.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`,
    password: 'secreto1',
    clinics: [{ clinic: clinicId, role }],
    ...extra,
  });

const transfer = (clinicId, actorId, role, convId, userId) =>
  H.runController(
    chat.assignConversation,
    H.mockReq(clinicId, actorId, { userId }, { role, params: { id: String(convId) } })
  );

// ─────────────────────────────────────────────────────────────────────────────
test('un asesor puede pasarle su chat a otro asesor', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = await makeUser(clinicId, 'Ana');
  const jaime = await makeUser(clinicId, 'Jaime');
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999000111', assignedTo: ana._id, assignedToName: 'Ana',
  });

  const r = await transfer(clinicId, ana._id, 'call_center', conv._id, String(jaime._id));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.assignedToName, 'Jaime');
  const saved = await Conversation.findById(conv._id);
  assert.equal(String(saved.assignedTo), String(jaime._id));
});

test('un asesor puede pasarle a un supervisor un chat que no es suyo', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = await makeUser(clinicId, 'Ana');
  const jaime = await makeUser(clinicId, 'Jaime');
  const supervisora = await makeUser(clinicId, 'Sofia', 'marketing');
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999000222', assignedTo: jaime._id, assignedToName: 'Jaime',
  });

  // La bandeja es compartida: Ana ve el chat de Jaime y puede escalarlo.
  const r = await transfer(clinicId, ana._id, 'call_center', conv._id, String(supervisora._id));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.assignedToName, 'Sofia');
});

test('no se puede transferir a alguien que no atiende la bandeja', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = await makeUser(clinicId, 'Ana');
  const contable = await makeUser(clinicId, 'Contable', 'contabilidad');
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999000333' });

  const r = await transfer(clinicId, ana._id, 'call_center', conv._id, String(contable._id));

  assert.equal(r.statusCode, 404);
  assert.match(r.payload.message, /no atiende chats|no existe/i);
  assert.equal((await Conversation.findById(conv._id)).assignedTo, null);
});

test('transferir libera la restricción de workflow y devuelve el chat a la bandeja', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const duenio = await makeUser(clinicId, 'Duenio');
  const nuevo = await makeUser(clinicId, 'Nuevo');
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999000444',
    assignedTo: duenio._id,
    assignedToName: 'Duenio',
    workflowRestrictedTo: duenio._id,
    workflowRestrictionActive: true,
  });

  const r = await transfer(clinicId, duenio._id, 'call_center', conv._id, String(nuevo._id));

  assert.equal(r.statusCode, 200);
  const saved = await Conversation.findById(conv._id);
  assert.equal(saved.workflowRestrictedTo, null);
  assert.equal(saved.workflowRestrictionActive, false);
  assert.equal(String(saved.assignedTo), String(nuevo._id));
});

test('tomar el chat (sin userId) sigue asignándomelo a mí', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ana = await makeUser(clinicId, 'Ana');
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999000555' });

  const r = await H.runController(
    chat.assignConversation,
    H.mockReq(clinicId, ana._id, {}, { role: 'call_center', params: { id: String(conv._id) } })
  );

  assert.equal(r.statusCode, 200);
  assert.equal(String(r.payload.assignedTo), String(ana._id));
});

// ─── Lista de destinatarios ──────────────────────────────────────────────────
test('la lista de destinatarios trae asesores y supervisores, y marca quién está en turno', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  // Horario que nunca cubre el momento actual (todos los días deshabilitados).
  const sinTurno = { enabled: true, days: Array.from({ length: 7 }, (_, i) => ({ day: i, enabled: false, ranges: [] })) };
  await makeUser(clinicId, 'Ana');                                       // sin horario → siempre disponible
  await makeUser(clinicId, 'Bruno', 'call_center', { callCenterSchedule: sinTurno });
  await makeUser(clinicId, 'Sofia', 'marketing');
  await makeUser(clinicId, 'Contable', 'contabilidad');                  // no atiende chats
  await makeUser(clinicId, 'Inactivo', 'call_center', { active: false });

  const r = await H.runController(
    chat.listAssignableUsers,
    H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'call_center' })
  );

  assert.equal(r.statusCode, 200);
  const names = r.payload.map((u) => u.name);
  assert.deepEqual(new Set(names), new Set(['Ana', 'Bruno', 'Sofia']));
  const byName = Object.fromEntries(r.payload.map((u) => [u.name, u]));
  assert.equal(byName.Ana.inShift, true);
  assert.equal(byName.Bruno.inShift, false);
  assert.equal(byName.Sofia.isAgent, false, 'la supervisora no es asesora de call center');
  assert.equal(byName.Ana.isAgent, true);
  // Los que están en turno salen primero.
  assert.notEqual(names[names.length - 1], 'Ana');
});
