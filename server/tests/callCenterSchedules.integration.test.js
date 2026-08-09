const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const User = require('../models/User');
const Conversation = require('../models/Conversation');
const configController = require('../controllers/callCenterConfigController');
const chatController = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ec = (isoLocal) => new Date(`${isoLocal}-05:00`);
const weekdays = Array.from({ length: 7 }, (_, day) => ({
  day, enabled: day >= 1 && day <= 5, start: '09:00', end: '18:00',
}));

test('marketing puede listar y guardar horarios de todos los asesores del call center compartido', async () => {
  const clinicA = new mongoose.Types.ObjectId();
  const clinicB = new mongoose.Types.ObjectId();
  const marketing = new mongoose.Types.ObjectId();
  const agent = await User.create({
    name: 'Andrea', email: 'andrea-turno@example.com', password: 'secret123',
    clinics: [{ clinic: clinicB, role: 'call_center' }],
  });

  const listed = await H.runController(
    configController.listAgentSchedules,
    H.mockReq(clinicA, marketing, {}, { role: 'marketing' })
  );
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.length, 1, 'la bandeja y sus asesores son globales, no por sucursal');
  assert.equal(listed.payload[0].callCenterSchedule.days.length, 7);

  const saved = await H.runController(
    configController.updateAgentSchedule,
    H.mockReq(clinicA, marketing, {
      callCenterSchedule: { enabled: true, days: weekdays },
    }, { role: 'marketing', params: { id: String(agent._id) } })
  );
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.callCenterSchedule.enabled, true);
  assert.equal(saved.payload.callCenterSchedule.days.filter((d) => d.enabled).length, 5);
});

test('marketing puede guardar varias franjas por dia y se rechazan franjas superpuestas', async () => {
  const clinic = new mongoose.Types.ObjectId();
  const marketing = new mongoose.Types.ObjectId();
  const agent = await User.create({
    name: 'Asesor partido', email: 'asesor-partido@example.com', password: 'secret123',
    clinics: [{ clinic, role: 'call_center' }],
  });
  const splitMonday = [{
    day: 1,
    enabled: true,
    intervals: [
      { start: '08:00', end: '12:00' },
      { start: '16:00', end: '21:00' },
    ],
  }];

  const saved = await H.runController(
    configController.updateAgentSchedule,
    H.mockReq(clinic, marketing, {
      callCenterSchedule: { enabled: true, days: splitMonday },
    }, { role: 'marketing', params: { id: String(agent._id) } })
  );
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.payload));
  assert.deepEqual(saved.payload.callCenterSchedule.days[1].intervals, splitMonday[0].intervals);

  const listed = await H.runController(
    configController.listAgentSchedules,
    H.mockReq(clinic, marketing, {}, { role: 'marketing' })
  );
  const reloaded = listed.payload.find((item) => String(item._id) === String(agent._id));
  assert.deepEqual(reloaded.callCenterSchedule.days[1].intervals, splitMonday[0].intervals);

  const rejected = await H.runController(
    configController.updateAgentSchedule,
    H.mockReq(clinic, marketing, {
      callCenterSchedule: {
        enabled: true,
        days: [{
          day: 1,
          enabled: true,
          intervals: [{ start: '08:00', end: '12:00' }, { start: '11:00', end: '14:00' }],
        }],
      },
    }, { role: 'marketing', params: { id: String(agent._id) } })
  );
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.payload.message, /superponerse/);
});

test('supervisión atribuye la primera respuesta al actor real y descuenta tiempo fuera de turno', async () => {
  const clinic = new mongoose.Types.ObjectId();
  const viewer = new mongoose.Types.ObjectId();
  const agent = await User.create({
    name: 'Emily', email: 'emily-sla@example.com', password: 'secret123',
    clinics: [{ clinic, role: 'call_center' }],
    callCenterSchedule: { enabled: true, days: weekdays },
  });
  const reassigned = await User.create({
    name: 'Otro', email: 'otro-sla@example.com', password: 'secret123',
    clinics: [{ clinic, role: 'call_center' }],
  });

  // Lunes 17:00 -> martes 10:00: el reloj normal dice 17 h; el laboral dice 2 h.
  await Conversation.create({
    clinic,
    phone: '593990001234',
    channel: 'whatsapp',
    assignedTo: reassigned._id, // se reasignó DESPUÉS de la primera respuesta
    firstResponseBy: agent._id,
    firstResponseAt: ec('2026-08-04T10:00:00'),
    createdAt: ec('2026-08-03T17:00:00'),
  });

  const stats = await H.runController(chatController.getStats, H.mockReq(clinic, viewer));
  assert.equal(stats.statusCode, 200, JSON.stringify(stats.payload));
  assert.equal(stats.payload.responseTimes.length, 1);
  assert.equal(stats.payload.responseTimes[0].name, 'Emily');
  assert.equal(stats.payload.responseTimes[0].avgMinutes, 120);
  assert.equal(stats.payload.responseTimes[0].scheduleApplied, true);
});
