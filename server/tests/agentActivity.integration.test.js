/**
 * CUMPLIMIENTO DE HORARIO en Supervisión (/api/chats/agent-activity).
 *
 * La pregunta que contesta el panel es «¿a qué hora empezó y a qué hora terminó
 * cada asesor, y cuántos chats atendió de verdad?». Se rompe en silencio si:
 *  · cuela un mensaje automático → el asesor "trabajó" hasta la madrugada porque
 *    un workflow mandó un recordatorio a las 3 a.m.;
 *  · cuela una difusión → mandar lo mismo a 300 chats cuenta como 300 atendidos;
 *  · un chat con veinte mensajes cuenta veinte veces;
 *  · un día de turno SIN actividad no aparece → justo el que hay que ver.
 *
 * Las horas se escriben en UTC a propósito: Ecuador es UTC-5 todo el año, así que
 * 13:00 UTC son las 08:00 en Guayaquil. El panel debe leerlas en hora local.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const chats = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** Un día concreto en el pasado, para que el rango sea estable entre ejecuciones. */
const DIA = '2026-08-24'; // lunes
const OTRO_DIA = '2026-08-25'; // martes

/** Instante UTC a partir de una hora ECUATORIANA del día indicado. */
const ec = (dayKey, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 5, m)); // UTC-5 fijo
};

/** Turno de lunes a viernes 08:00–17:00. */
const turno9a5 = () => ({
  enabled: true,
  timezone: 'America/Guayaquil',
  days: Array.from({ length: 7 }, (_, day) => ({
    day,
    enabled: day >= 1 && day <= 5,
    start: '08:00',
    end: '17:00',
    intervals: [{ start: '08:00', end: '17:00' }],
  })),
});

async function seedAgente(clinicId, name, schedule) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s/g, '')}@test.com`,
    password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'call_center' }],
    ...(schedule ? { callCenterSchedule: schedule } : {}),
  });
}

async function seedChat(clinicId, phone) {
  return Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone, contactName: `Contacto ${phone}` });
}

/**
 * Mensaje saliente con una fecha concreta. El `createdAt` se escribe por el driver
 * (`.collection`), no por Mongoose: los timestamps del esquema lo pisarían con
 * "ahora" tanto al crear como al actualizar.
 */
async function msg(clinicId, conv, at, extra = {}) {
  const doc = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body: 'hola',
    ...extra,
  });
  await Message.collection.updateOne({ _id: doc._id }, { $set: { createdAt: at } });
  return doc;
}

const activity = (clinicId, userId, query) =>
  H.runController(chats.getAgentActivity, H.mockReq(clinicId, userId, {}, { role: 'admin', query }));

test('A1) primer y último mensaje del día, y chats atendidos sin contar dos veces el mismo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const ana = await seedAgente(clinicId, 'Ana Asesora', turno9a5());
  const chatA = await seedChat(clinicId, '593991111111');
  const chatB = await seedChat(clinicId, '593992222222');

  const suyo = { sentBy: ana._id, sentByName: 'Ana Asesora' };
  await msg(clinicId, chatA, ec(DIA, '08:05'), suyo);
  await msg(clinicId, chatA, ec(DIA, '09:30'), suyo); // mismo chat: sigue siendo uno
  await msg(clinicId, chatB, ec(DIA, '16:40'), suyo);

  const data = ok(await activity(clinicId, userId, { from: DIA, to: DIA }));
  const fila = data.rows.find((r) => r.agentName === 'Ana Asesora');

  assert.equal(fila.day, DIA);
  assert.equal(new Date(fila.firstAt).toISOString(), ec(DIA, '08:05').toISOString());
  assert.equal(new Date(fila.lastAt).toISOString(), ec(DIA, '16:40').toISOString());
  assert.equal(fila.manualChats, 2, 'dos chats, no tres mensajes');
  assert.equal(fila.manualMessages, 3);
  assert.equal(fila.shift.start, '08:00');
  assert.equal(fila.shift.end, '17:00');
  // Las FRANJAS reales del día, no solo el bloque de la primera a la última:
  // sin esto, quien trabaja 08–12 y 14–18 aparecía cumpliendo aunque escribiera
  // a las 13:00, en pleno almuerzo.
  assert.deepEqual(fila.shift.intervals, [{ start: '08:00', end: '17:00' }]);
  assert.equal(fila.lateMinutes, 5);
  assert.equal(fila.earlyLeaveMinutes, 20);
  assert.equal(fila.absent, false);
  assert.equal(fila.outOfShiftMessages, 0, 'los tres mensajes caen dentro de su turno');
});

test('A2) automatizaciones, difusiones, entrantes y chips de evento NO cuentan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const ana = await seedAgente(clinicId, 'Ana Asesora', turno9a5());
  const chat = await seedChat(clinicId, '593991111111');
  const suyo = { sentBy: ana._id, sentByName: 'Ana Asesora' };

  await msg(clinicId, chat, ec(DIA, '09:00'), suyo);                              // sí
  await msg(clinicId, chat, ec(DIA, '03:00'), { isAutoReply: true });             // workflow de madrugada
  await msg(clinicId, chat, ec(DIA, '23:30'), { ...suyo, isAutoReply: true });    // automático con autor
  await msg(clinicId, chat, ec(DIA, '22:00'), { ...suyo, isBroadcast: true });    // difusión
  await msg(clinicId, chat, ec(DIA, '07:00'), { direction: 'in' });               // lo escribió el paciente
  await msg(clinicId, chat, ec(DIA, '21:00'), { ...suyo, kind: 'event', eventType: 'opportunity_created', direction: undefined });

  const data = ok(await activity(clinicId, userId, { from: DIA, to: DIA }));
  const fila = data.rows.find((r) => r.agentName === 'Ana Asesora');

  assert.equal(fila.manualMessages, 1, 'solo el que escribió ella');
  assert.equal(new Date(fila.firstAt).toISOString(), ec(DIA, '09:00').toISOString());
  assert.equal(new Date(fila.lastAt).toISOString(), ec(DIA, '09:00').toISOString(),
    'un workflow de las 23:30 no puede alargarle la jornada');
});

test('A3) un día de turno sin un solo mensaje sale marcado como ausencia', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const ana = await seedAgente(clinicId, 'Ana Asesora', turno9a5());
  const chat = await seedChat(clinicId, '593991111111');
  await msg(clinicId, chat, ec(DIA, '08:00'), { sentBy: ana._id, sentByName: 'Ana Asesora' });

  const data = ok(await activity(clinicId, userId, { from: DIA, to: OTRO_DIA }));
  const martes = data.rows.find((r) => r.day === OTRO_DIA && r.agentName === 'Ana Asesora');

  assert.ok(martes, 'el martes tenía turno: la fila debe existir aunque esté vacía');
  assert.equal(martes.absent, true);
  assert.equal(martes.manualMessages, 0);
  assert.equal(martes.firstAt, null);

  const totales = data.totals.find((t) => t.agentName === 'Ana Asesora');
  assert.equal(totales.scheduledDays, 2);
  assert.equal(totales.activeDays, 1);
  assert.equal(totales.absentDays, 1);
});

test('A4) sin horario configurado no se inventan retrasos ni ausencias', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const libre = await seedAgente(clinicId, 'Sin Horario', null);
  const chat = await seedChat(clinicId, '593993333333');
  await msg(clinicId, chat, ec(DIA, '11:00'), { sentBy: libre._id, sentByName: 'Sin Horario' });

  const data = ok(await activity(clinicId, userId, { from: DIA, to: DIA }));
  const fila = data.rows.find((r) => r.agentName === 'Sin Horario');

  assert.equal(fila.shift, null);
  assert.equal(fila.lateMinutes, null);
  assert.equal(fila.absent, false);
  assert.equal(fila.manualChats, 1);
});

test('A5) un rango demasiado largo lo dice en vez de fingir que nadie faltó', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedAgente(clinicId, 'Ana Asesora', turno9a5());

  const corto = ok(await activity(clinicId, userId, { from: DIA, to: OTRO_DIA }));
  assert.equal(corto.scheduleDaysOmitted, false);

  const largo = ok(await activity(clinicId, userId, { from: '2026-01-01', to: '2026-12-31' }));
  assert.equal(largo.scheduleDaysOmitted, true, 'el panel debe avisar de que no calculó ausencias');
  assert.equal(largo.rows.length, 0, 'sin actividad, y sin inventar filas de turno');
});

/**
 * A6) LAS FRANJAS, NO EL BLOQUE.
 *
 * Antes el turno se miraba de la primera franja a la última y el hueco del
 * almuerzo quedaba DENTRO: quien trabaja 08–12 y 14–18 aparecía cumpliendo
 * aunque hubiera escrito a la una de la tarde, y quien solo hace tardes no salía
 * tarde por escribir a las nueve de la mañana.
 */
test('A6) los mensajes escritos fuera de las franjas se cuentan aparte', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const partido = {
    enabled: true,
    timezone: 'America/Guayaquil',
    days: Array.from({ length: 7 }, (_, day) => ({
      day,
      enabled: day >= 1 && day <= 5,
      start: '08:00',
      end: '18:00',
      // Jornada partida: se come de 12:00 a 14:00.
      intervals: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    })),
  };
  const ana = await seedAgente(clinicId, 'Ana Partida', partido);
  const chat = await seedChat(clinicId, '593993333333');
  const suyo = { sentBy: ana._id, sentByName: 'Ana Partida' };

  await msg(clinicId, chat, ec(DIA, '09:00'), suyo);  // dentro
  await msg(clinicId, chat, ec(DIA, '13:00'), suyo);  // ALMUERZO
  await msg(clinicId, chat, ec(DIA, '13:30'), suyo);  // ALMUERZO
  await msg(clinicId, chat, ec(DIA, '15:00'), suyo);  // dentro

  const data = ok(await activity(clinicId, userId, { from: DIA, to: DIA }));
  const fila = data.rows.find((r) => r.agentName === 'Ana Partida');

  assert.deepEqual(
    fila.shift.intervals,
    [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    'se ven las dos franjas, no un 08–18 corrido',
  );
  assert.equal(fila.manualMessages, 4);
  assert.equal(fila.outOfShiftMessages, 2, 'los dos del almuerzo');
});

test('A7) sin horario configurado no se acusa a nadie de escribir fuera de turno', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const libre = await seedAgente(clinicId, 'Sin Horario');
  const chat = await seedChat(clinicId, '593994444444');
  await msg(clinicId, chat, ec(DIA, '03:00'), { sentBy: libre._id, sentByName: 'Sin Horario' });

  const data = ok(await activity(clinicId, userId, { from: DIA, to: DIA }));
  const fila = data.rows.find((r) => r.agentName === 'Sin Horario');
  assert.equal(fila.shift, null);
  assert.equal(fila.outOfShiftMessages, null, 'sin turno no hay "fuera de turno"');
});
