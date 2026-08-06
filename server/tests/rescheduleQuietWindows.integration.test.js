/**
 * REENCOLADO de las inscripciones que quedaron programadas para dispararse en
 * pleno horario de silencio.
 *
 * Al invertir el significado de las ventanas (ago-2026) el motor deja de enviar
 * de noche… pero las inscripciones YA retenidas guardan su `nextRunAt` calculado
 * con la regla vieja, y 48 de ellas apuntaban dentro de la franja 23:00–06:20.
 * Sin esta tarea, la primera noche tras el despliegue volverían a sonar todos los
 * teléfonos. Aquí se fija que solo se adelantan las que caen en el silencio, que
 * nunca se mueven hacia atrás, y que lo demás no se toca.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const { reschedule, windowsOfWorkflow } = require('../scripts/rescheduleQuietWindowsOnce');

const Clinic = require('../models/Clinic');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const silencio = (log = () => {}) => reschedule({ commit: true, log });

/** Fecha local del PRÓXIMO día a la hora indicada (siempre en el futuro). */
function mañanaALas(h, min = 0) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, min, 0, 0);
  return d;
}

/** Workflow con la ventana REAL de producción: silencio 23:00–06:20 todos los días. */
async function wfConSilencioNocturno(clinicId, name = 'Promo') {
  return Workflow.create({
    clinic: clinicId, name, active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      {
        id: 'win', type: 'window', position: { x: 0, y: 130 },
        data: { windowDays: [0, 1, 2, 3, 4, 5, 6], windowFrom: '23:00', windowTo: '06:20' },
      },
      { id: 'msg', type: 'send_message', position: { x: 0, y: 260 }, data: { body: 'Hola' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'win', sourceHandle: 'default' },
      { id: 'e1', source: 'win', target: 'msg', sourceHandle: 'default' },
    ],
  });
}

async function enrolar(clinicId, wf, cuando) {
  return WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id,
    currentNodeId: 'msg', startNodeId: 'trigger',
    status: 'waiting', nextRunAt: cuando, context: {},
  });
}

test('windowsOfWorkflow recoge la ventana del workflow y las de sus nodos', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  wf.sendWindow = { mode: 'specific', days: [1], from: '09:00', to: '18:00' };
  const wins = windowsOfWorkflow(wf.toObject());
  assert.equal(wins.length, 2, 'la del workflow + la del nodo');
  assert.deepEqual(wins.map((w) => w.from).sort(), ['09:00', '23:00']);
});

test('una inscripción programada de madrugada se adelanta al final del silencio', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  const enr = await enrolar(clinic._id, wf, mañanaALas(2, 30)); // 02:30: pleno silencio

  const r = await silencio();
  assert.equal(r.movidas, 1);
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  const nuevo = new Date(fresh.nextRunAt);
  assert.equal(nuevo.getHours(), 6);
  assert.equal(nuevo.getMinutes(), 20, 'se envía al terminar el silencio, no al empezarlo');
});

test('la que apuntaba justo al inicio del silencio (23:00) también se mueve', async () => {
  // Es EXACTAMENTE el caso de producción: la regla vieja las dejaba a las 23:00,
  // que era la "apertura" de entonces y ahora es el comienzo del silencio.
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  const enr = await enrolar(clinic._id, wf, mañanaALas(23, 0));

  await silencio();
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  const nuevo = new Date(fresh.nextRunAt);
  assert.equal(nuevo.getHours(), 6);
  assert.equal(nuevo.getMinutes(), 20);
  assert.ok(nuevo > mañanaALas(23, 0), 'se fue al día siguiente, no hacia atrás');
});

test('las que ya estaban a buena hora no se tocan', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  const cuando = mañanaALas(15, 0);
  const enr = await enrolar(clinic._id, wf, cuando);

  const r = await silencio();
  assert.equal(r.movidas, 0);
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  assert.equal(new Date(fresh.nextRunAt).getTime(), cuando.getTime(), 'intacta');
});

test('los workflows sin ventana quedan al margen', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Sin ventana', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'msg', type: 'send_message', position: { x: 0, y: 130 }, data: { body: 'Hola' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'msg', sourceHandle: 'default' }],
  });
  const cuando = mañanaALas(3, 0);
  const enr = await enrolar(clinic._id, wf, cuando);

  const r = await silencio();
  assert.equal(r.conVentana, 0);
  assert.equal(r.movidas, 0);
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  assert.equal(new Date(fresh.nextRunAt).getTime(), cuando.getTime());
});

test('el modo DRY-RUN no escribe nada', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  const cuando = mañanaALas(2, 30);
  const enr = await enrolar(clinic._id, wf, cuando);

  const r = await reschedule({ commit: false, log: () => {} });
  assert.equal(r.dryRun, true);
  assert.equal(r.movidas, 1, 'informa lo que movería…');
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  assert.equal(new Date(fresh.nextRunAt).getTime(), cuando.getTime(), '…pero no lo mueve');
});

test('correr la tarea dos veces no vuelve a mover nada (es idempotente)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  await enrolar(clinic._id, wf, mañanaALas(2, 30));

  assert.equal((await silencio()).movidas, 1);
  assert.equal((await silencio()).movidas, 0, 'ya está fuera del silencio: no se toca');
});

test('una ventana imposible (24 h los 7 días) no deja la inscripción sin fecha', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await wfConSilencioNocturno(clinic._id);
  await Workflow.updateOne(
    { _id: wf._id, 'nodes.id': 'win' },
    { $set: { 'nodes.$.data': { windowDays: [0, 1, 2, 3, 4, 5, 6], windowFrom: '08:00', windowTo: '08:00' } } }
  );
  const cuando = mañanaALas(2, 30);
  const enr = await enrolar(clinic._id, wf, cuando);

  const r = await silencio();
  assert.equal(r.movidas, 0, 'sin hueco posible, mejor no tocarla');
  const fresh = await WorkflowEnrollment.findById(enr._id).lean();
  assert.equal(new Date(fresh.nextRunAt).getTime(), cuando.getTime());
});
