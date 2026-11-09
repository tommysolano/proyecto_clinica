/**
 * Automatizaciones: disparador «Cumpleaños del paciente» (nov-2026).
 *
 * - El job emite el evento de los pacientes que cumplen HOY (hora de Ecuador);
 *   los nacidos el 29 de febrero se saludan el 28 en años no bisiestos.
 * - El saludo no sale a la hora en que corrió el job: la inscripción queda en
 *   espera hasta la «Hora del saludo» del disparador (por defecto 09:00).
 * - Una sola inscripción por día aunque el job vuelva a correr.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const workflowEngine = require('../utils/workflowEngine');
const { runBirthdayCheck, diasQueSeCelebran } = require('../utils/birthdayJob');
const { clearCache } = require('../utils/callCenterClinic');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Conversation = require('../models/Conversation');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');

test.before(async () => {
  await H.startDb();
  workflowEngine.subscribeDomainEvents();
});
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => {
  await H.resetDb();
  clearCache();
});

async function waitFor(fn, { timeout = 4000, every = 50 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

function flujoCumple(clinicId, sendHour) {
  const tr = { type: 'patient_birthday', audience: 'all', ...(sendHour ? { sendHour } : {}) };
  return Workflow.create({
    clinic: clinicId,
    name: 'Feliz cumpleaños',
    active: true,
    triggers: [tr],
    trigger: tr,
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [tr] } },
      { id: 'n1', type: 'add_tag', position: { x: 0, y: 130 }, data: { tag: 'cumple-saludado' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' }],
  });
}

/** Fecha de nacimiento como la guarda la ficha: medianoche UTC del día. */
const nacido = (year, month, day) => new Date(Date.UTC(year, month - 1, day));

test('29 de febrero: se celebra el 28 en años no bisiestos', () => {
  // 28-02-2027 a mediodía de Ecuador (17:00 UTC).
  const dias = diasQueSeCelebran(new Date(Date.UTC(2027, 1, 28, 17))).dias;
  assert.deepEqual(dias, [{ month: 2, day: 28 }, { month: 2, day: 29 }]);
  // En 2028 (bisiesto) el 28 es solo el 28.
  assert.deepEqual(diasQueSeCelebran(new Date(Date.UTC(2028, 1, 28, 17))).dias, [{ month: 2, day: 28 }]);
  // A las 23:00 de Ecuador del 4 de nov ya son las 04:00 UTC del 5: sigue siendo el 4 en Ecuador.
  assert.deepEqual(diasQueSeCelebran(new Date(Date.UTC(2026, 10, 5, 4))).dias, [{ month: 11, day: 4 }]);
});

test('la hora del saludo: la del disparador, por defecto 09:00; si ya pasó, sale ya', () => {
  const wf = {
    nodes: [{ id: 't', type: 'trigger', data: { triggers: [{ type: 'patient_birthday', sendHour: '10:30' }] } }],
    edges: [],
  };
  const temprano = new Date('2026-11-05T05:15:00Z');
  const at = workflowEngine.horaSaludoCumple(wf, { startNodeId: 't' }, temprano);
  assert.equal(at.toISOString(), '2026-11-05T15:30:00.000Z');
  const sinHora = { nodes: [{ id: 't', type: 'trigger', data: { triggers: [{ type: 'patient_birthday' }] } }], edges: [] };
  assert.equal(workflowEngine.horaSaludoCumple(sinHora, { startNodeId: 't' }, temprano).toISOString(), '2026-11-05T14:00:00.000Z');
  assert.equal(workflowEngine.horaSaludoCumple(wf, { startNodeId: 't' }, new Date('2026-11-05T16:00:00Z')), null);
});

test('el cumpleañero queda inscrito, en espera hasta la hora del saludo, una sola vez al día', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const ec = new Date(Date.now() - 5 * 3600 * 1000); // día de hoy en Ecuador
  const cumple = await Patient.create({
    clinic: clinic._id, firstName: 'Ana', lastName: 'Cumple', phone: '0991234567',
    birthDate: nacido(1990, ec.getUTCMonth() + 1, ec.getUTCDate()),
  });
  // Otro día: no se inscribe.
  const otroDia = new Date(ec.getTime() + 40 * 86400000);
  await Patient.create({
    clinic: clinic._id, firstName: 'Luis', lastName: 'Otro',
    birthDate: nacido(1985, otroDia.getUTCMonth() + 1, otroDia.getUTCDate()),
  });
  // Hora del saludo a las 23:59: casi siempre todavía no pasó (queda en espera).
  const wf = await flujoCumple(clinic._id, '23:59');

  assert.equal(await runBirthdayCheck(), 1, 'solo cumple uno');
  const enr = await waitFor(() => WorkflowEnrollment.findOne({ workflow: wf._id, patient: cumple._id }));
  assert.ok(enr, 'no se inscribió al cumpleañero');
  if (ec.getUTCHours() < 23 || ec.getUTCMinutes() < 59) {
    assert.equal(enr.status, 'waiting', 'espera a la hora del saludo');
    assert.equal(new Date(enr.nextRunAt.getTime() - 5 * 3600000).getUTCHours(), 23);
    const p = await Patient.findById(cumple._id);
    assert.ok(!(p.tags || []).includes('cumple-saludado'), 'todavía no corrió ningún paso');
  }

  // El job vuelve a correr (reinicio del servidor): no se crea otra inscripción.
  await runBirthdayCheck();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
});

test('cumpleaños usa el último entrante y el número predeterminado si no existe', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'Prueba', phone: '0991234567' });
  const principal = await WhatsappAccount.create({ label: 'Principal', connectionType: 'qr', isDefault: true });
  const ultimo = await WhatsappAccount.create({ label: 'Último entrante', connectionType: 'qr' });
  await Conversation.create({ clinic: clinic._id, patient: paciente._id, phone: '593991234567', lastInboundAt: new Date(Date.now() - 3600000), lastInboundAccount: principal._id, lastMessageAt: new Date() });
  const reciente = await Conversation.create({ clinic: clinic._id, patient: paciente._id, phone: '123456789', linkedPhone: '593991234567', lastInboundAt: new Date(), lastInboundAccount: ultimo._id, whatsappAccount: principal._id });
  const wf = await Workflow.create({ clinic: clinic._id, name: 'Mensaje', active: true, steps: [{ type: 'send_message', body: 'Feliz cumpleaños' }] });
  const sent = [];
  const original = messaging.send;
  messaging.send = async (args) => { sent.push(args); return { ok: true }; };
  try {
    const crear = () => WorkflowEnrollment.create({ clinic: clinic._id, workflow: wf._id, patient: paciente._id, context: { eventType: 'patient_birthday', phone: paciente.phone } });
    await workflowEngine.executeEnrollment(await crear());
    assert.equal(String(sent[0].conversation._id), String(reciente._id));
    assert.equal(sent[0].whatsappAccount, String(ultimo._id));
    await Conversation.deleteMany({ clinic: clinic._id });
    await workflowEngine.executeEnrollment(await crear());
    assert.equal(sent[1].whatsappAccount, String(principal._id));
  } finally {
    messaging.send = original;
  }
});

test('si la hora del saludo ya pasó, los pasos corren de inmediato', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const ec = new Date(Date.now() - 5 * 3600 * 1000);
  const cumple = await Patient.create({
    clinic: clinic._id, firstName: 'Eva', lastName: 'Tarde', phone: '0991234567',
    birthDate: nacido(1992, ec.getUTCMonth() + 1, ec.getUTCDate()),
  });
  const wf = await flujoCumple(clinic._id, '00:00');
  await runBirthdayCheck();
  const enr = await waitFor(async () => {
    const e = await WorkflowEnrollment.findOne({ workflow: wf._id, patient: cumple._id });
    return e && e.status === 'done' ? e : null;
  });
  assert.ok(enr, 'la inscripción no terminó');
  const p = await Patient.findById(cumple._id);
  assert.ok((p.tags || []).includes('cumple-saludado'));
});
