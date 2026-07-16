/**
 * Panel de Supervisión del CRM (GET /chats/stats): filtro por fechas, tiempo de
 * respuesta por agente, chats sin responder (por agente y sin asignar) y citas
 * nacidas de un chat.
 *
 * Prueba contra el controller real y un Mongo en memoria: la agregación cruza
 * conversaciones, usuarios y citas, y es fácil que "compile" y cuente mal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');

const MIN = 60 * 1000;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function makeAgent(name) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.com`,
    password: 'x'.repeat(10),
    clinics: [],
  });
}

/**
 * Antedata un documento. OJO: hay que pasar por el driver nativo — mongoose
 * protege `createdAt` y lo descarta en silencio de un $set (el resto de campos
 * del mismo $set sí se aplican, así que el fallo pasa desapercibido).
 */
async function backdate(collection, id, fields) {
  await H.mongoose.connection.db.collection(collection).updateOne({ _id: id }, { $set: fields });
}

async function makeConv(clinicId, { phone, agent, createdAt, firstResponseAt = null, status = 'open', lastMessageDirection = 'out', lastMessageAt = new Date(), contactName = '' }) {
  const conv = await Conversation.create({
    clinic: clinicId,
    phone,
    contactName,
    channel: 'whatsapp',
    status,
    assignedTo: agent?._id || null,
    assignedToName: agent?.name || '',
    lastMessageDirection,
    lastMessageAt,
  });
  await backdate('conversations', conv._id, { createdAt, firstResponseAt });
  return conv;
}

async function makeApptFromChat(clinicId, { conv, agent, status = 'pendiente', createdAt = new Date() }) {
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: `${Math.random()}`.slice(2, 12) });
  const appt = await Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: new Date(),
    startTime: '10:00',
    status,
    createdBy: agent._id,
    conversation: conv._id,
  });
  await backdate('appointments', appt._id, { createdAt });
  return appt;
}

const statsFor = (clinicId, userId, query = {}) =>
  H.runController(chat.getStats, H.mockReq(clinicId, userId, {}, { query }));

// ─────────────────────────────────────────────────────────────────────────────
test('tiempo de primera respuesta: promedio por agente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const jaime = await makeAgent('Jaime');
  const base = new Date('2026-07-10T14:00:00Z');

  // Emily: uno a 10 min y otro a 30 min → promedio 20.
  await makeConv(clinicId, { phone: '111', agent: emily, contactName: 'Uno', createdAt: base, firstResponseAt: new Date(+base + 10 * MIN) });
  await makeConv(clinicId, { phone: '222', agent: emily, contactName: 'Dos', createdAt: base, firstResponseAt: new Date(+base + 30 * MIN) });
  // Un chat sin responder no debe arrastrar el promedio de nadie.
  await makeConv(clinicId, { phone: '333', agent: jaime, contactName: 'Tres', createdAt: base, firstResponseAt: null });

  const r = await statsFor(clinicId, userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const emilyAvg = r.payload.responseTimes.find((x) => x.name === 'Emily');
  assert.equal(emilyAvg.avgMinutes, 20);
  assert.equal(emilyAvg.count, 2);
  assert.equal(r.payload.responseTimes.find((x) => x.name === 'Jaime'), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
test('por agente: "sin responder" son los chats abiertos que esperan respuesta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const jaime = await makeAgent('Jaime');
  const base = new Date('2026-07-10T14:00:00Z');

  // Emily: dos esperando respuesta (último mensaje del paciente) y uno contestado.
  await makeConv(clinicId, { phone: '111', agent: emily, createdAt: base, lastMessageDirection: 'in' });
  await makeConv(clinicId, { phone: '222', agent: emily, createdAt: base, lastMessageDirection: 'in' });
  await makeConv(clinicId, { phone: '333', agent: emily, createdAt: base, lastMessageDirection: 'out' });
  // Un chat cerrado con el último mensaje entrante NO cuenta: ya no está en juego.
  await makeConv(clinicId, { phone: '444', agent: emily, createdAt: base, lastMessageDirection: 'in', status: 'closed' });
  // Jaime, al día.
  await makeConv(clinicId, { phone: '555', agent: jaime, createdAt: base, lastMessageDirection: 'out' });

  const r = await statsFor(clinicId, userId);
  const rowEmily = r.payload.byAgent.find((a) => a.name === 'Emily');
  const rowJaime = r.payload.byAgent.find((a) => a.name === 'Jaime');
  assert.equal(rowEmily.unanswered, 2);
  assert.equal(rowEmily.total, 4);
  assert.equal(rowJaime.unanswered, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('por agente: los chats sin asignar salen en su propia fila', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const base = new Date('2026-07-10T14:00:00Z');

  await makeConv(clinicId, { phone: '111', agent: emily, createdAt: base, lastMessageDirection: 'out' });
  // Nadie los ha tomado y el paciente espera: es lo que hay que ver.
  await makeConv(clinicId, { phone: '222', agent: null, createdAt: base, lastMessageDirection: 'in' });
  await makeConv(clinicId, { phone: '333', agent: null, createdAt: base, lastMessageDirection: 'in' });

  const r = await statsFor(clinicId, userId);
  const sinAsignar = r.payload.byAgent.find((a) => a.name === 'Sin asignar');
  assert.ok(sinAsignar, 'debe existir la fila de sin asignar');
  assert.equal(sinAsignar._id, null);
  assert.equal(sinAsignar.total, 2);
  assert.equal(sinAsignar.unanswered, 2);
  // Y no se le cuelgan citas a una fila que no es de nadie.
  assert.equal(sinAsignar.appointmentsCreated, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('sin responder: cuenta los chats abiertos cuyo último mensaje es del paciente y pasó el SLA', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const now = new Date();

  // Entrante hace 2 horas y sin responder → cuenta.
  await makeConv(clinicId, {
    phone: '111', agent: emily, createdAt: now,
    lastMessageDirection: 'in', lastMessageAt: new Date(+now - 120 * MIN),
  });
  // Entrante hace 5 min → dentro del umbral, no cuenta.
  await makeConv(clinicId, {
    phone: '222', agent: emily, createdAt: now,
    lastMessageDirection: 'in', lastMessageAt: new Date(+now - 5 * MIN),
  });
  // Último mensaje NUESTRO → no está pendiente.
  await makeConv(clinicId, {
    phone: '333', agent: emily, createdAt: now,
    lastMessageDirection: 'out', lastMessageAt: new Date(+now - 200 * MIN),
  });

  const r = await statsFor(clinicId, userId);
  assert.equal(r.payload.sla.unanswered, 1);
  assert.equal(r.payload.sla.thresholdMinutes, 60);
});

// ─────────────────────────────────────────────────────────────────────────────
test('citas: cuenta las creadas DESDE UN CHAT y cuáles se asistieron, por agente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const jaime = await makeAgent('Jaime');
  const base = new Date('2026-07-10T14:00:00Z');

  const c1 = await makeConv(clinicId, { phone: '111', agent: emily, createdAt: base });
  const c2 = await makeConv(clinicId, { phone: '222', agent: jaime, createdAt: base });

  // Emily: 3 citas, 2 asistidas ('asistida' y 'completada' cuentan como asistidas).
  await makeApptFromChat(clinicId, { conv: c1, agent: emily, status: 'asistida', createdAt: base });
  await makeApptFromChat(clinicId, { conv: c1, agent: emily, status: 'completada', createdAt: base });
  await makeApptFromChat(clinicId, { conv: c1, agent: emily, status: 'no_asistio', createdAt: base });
  // Jaime: 1 cita pendiente.
  await makeApptFromChat(clinicId, { conv: c2, agent: jaime, status: 'pendiente', createdAt: base });

  const r = await statsFor(clinicId, userId);
  const rowEmily = r.payload.byAgent.find((a) => a.name === 'Emily');
  const rowJaime = r.payload.byAgent.find((a) => a.name === 'Jaime');
  assert.equal(rowEmily.appointmentsCreated, 3);
  assert.equal(rowEmily.appointmentsAttended, 2);
  assert.equal(rowJaime.appointmentsCreated, 1);
  assert.equal(rowJaime.appointmentsAttended, 0);
  // Totales del panel.
  assert.equal(r.payload.appointments.created, 4);
  assert.equal(r.payload.appointments.attended, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
test('citas: una cita agendada FUERA del chat no se cuenta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const base = new Date('2026-07-10T14:00:00Z');
  await makeConv(clinicId, { phone: '111', agent: emily, createdAt: base });

  // Sin `conversation`: nació en la página de Citas, no es trabajo del call center.
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Leo', lastName: 'Paz', cedula: '1234567890' });
  await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(), startTime: '09:00',
    status: 'asistida', createdBy: emily._id,
  });

  const r = await statsFor(clinicId, userId);
  assert.equal(r.payload.appointments.created, 0);
  assert.equal(r.payload.byAgent.find((a) => a.name === 'Emily').appointmentsCreated, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('citas: no se cuentan las de OTRA clínica aunque vengan de un chat', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otra = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const base = new Date('2026-07-10T14:00:00Z');

  const ajena = await makeConv(otra.clinicId, { phone: '999', agent: emily, createdAt: base });
  await makeApptFromChat(otra.clinicId, { conv: ajena, agent: emily, status: 'asistida', createdAt: base });

  const r = await statsFor(clinicId, userId);
  assert.equal(r.payload.appointments.created, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('filtro por fechas: acota chats y citas al rango, e incluye los bordes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const dentro = new Date('2026-07-10T14:00:00');
  const fuera = new Date('2026-06-05T14:00:00');

  const cIn = await makeConv(clinicId, { phone: '111', agent: emily, contactName: 'Julio', createdAt: dentro, firstResponseAt: new Date(+dentro + MIN) });
  const cOut = await makeConv(clinicId, { phone: '222', agent: emily, contactName: 'Junio', createdAt: fuera, firstResponseAt: new Date(+fuera + MIN) });
  await makeApptFromChat(clinicId, { conv: cIn, agent: emily, status: 'asistida', createdAt: dentro });
  await makeApptFromChat(clinicId, { conv: cOut, agent: emily, status: 'asistida', createdAt: fuera });

  const julio = await statsFor(clinicId, userId, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(julio.payload.byAgent.find((a) => a.name === 'Emily').total, 1);
  assert.equal(julio.payload.appointments.created, 1);

  // Sin rango: todo el histórico.
  const todo = await statsFor(clinicId, userId);
  assert.equal(todo.payload.byAgent.find((a) => a.name === 'Emily').total, 2);
  assert.equal(todo.payload.appointments.created, 2);

  // Un rango de un solo día debe incluir ese día completo (hasta las 23:59).
  const soloEseDia = await statsFor(clinicId, userId, { from: '2026-07-10', to: '2026-07-10' });
  assert.equal(soloEseDia.payload.byAgent.find((a) => a.name === 'Emily').total, 1);
  assert.equal(soloEseDia.payload.appointments.created, 1);

  // Un rango sin actividad no rompe: devuelve ceros.
  const vacio = await statsFor(clinicId, userId, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(vacio.payload.appointments.created, 0);
  assert.equal(vacio.payload.byAgent.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('un agente con citas pero sin chats asignados igual aparece en la tabla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emily = await makeAgent('Emily');
  const erick = await makeAgent('Erick');
  const base = new Date('2026-07-10T14:00:00Z');

  // El chat es de Emily, pero quien agendó la cita fue Erick.
  const conv = await makeConv(clinicId, { phone: '111', agent: emily, createdAt: base });
  await makeApptFromChat(clinicId, { conv, agent: erick, status: 'asistida', createdAt: base });

  const r = await statsFor(clinicId, userId);
  const rowErick = r.payload.byAgent.find((a) => a.name === 'Erick');
  assert.ok(rowErick, 'Erick debe aparecer aunque no tenga chats asignados');
  assert.equal(rowErick.total, 0);
  assert.equal(rowErick.appointmentsCreated, 1);
  assert.equal(rowErick.appointmentsAttended, 1);
});
