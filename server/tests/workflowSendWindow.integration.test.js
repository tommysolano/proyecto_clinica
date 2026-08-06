/**
 * VENTANAS HORARIAS de las automatizaciones (estilo "Time Window" de
 * GoHighLevel / "ventanas" de Daplox), extremo a extremo sobre el motor:
 *
 *  - `workflow.sendWindow`: los pasos de ENVÍO fuera de la franja no se saltan
 *    ni se mandan tarde: la inscripción queda `waiting` con nextRunAt en la
 *    próxima apertura y el MISMO paso se ejecuta entonces.
 *  - nodo `window` del diagrama: retiene TODO lo que venga después (aunque no
 *    envíe nada) hasta que la franja abre.
 *
 * Se usan pasos `add_tag` (que no dependen de WhatsApp) para comprobar qué se
 * ejecutó y qué no.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Ventana que NO puede estar abierta hoy: el único día habilitado es el de
// pasado mañana. Así el test no depende del día en que se ejecute.
function ventanaCerradaHoy() {
  const dentroDeDosDias = (new Date().getDay() + 2) % 7;
  return { mode: 'specific', days: [dentroDeDosDias], from: '09:00', to: '18:00' };
}
// Ventana siempre abierta (todos los días, todo el día).
const VENTANA_ABIERTA = { mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' };

async function run(clinicId, wf, patientId, startNode) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: patientId,
    currentNodeId: startNode, startNodeId: 'trigger', status: 'active', context: {},
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

test('ventana del workflow: un paso de ENVÍO fuera de la franja espera a la apertura', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Con ventana', active: true,
    sendWindow: ventanaCerradaHoy(),
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'msg', type: 'send_message', position: { x: 0, y: 130 }, data: { body: 'Hola' } },
      { id: 'tag', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'despues-del-envio' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'msg', sourceHandle: 'default' },
      { id: 'e1', source: 'msg', target: 'tag', sourceHandle: 'default' },
    ],
  });

  const enr = await run(clinic._id, wf, patient._id, 'msg');
  assert.equal(enr.status, 'waiting', 'la inscripción queda esperando, no termina');
  assert.equal(enr.currentNodeId, 'msg', 'se reanuda en el MISMO paso de envío');
  assert.ok(enr.nextRunAt > new Date(), 'la reanudación está en el futuro');
  assert.ok((enr.log || []).some((l) => /Fuera de la ventana de envío/.test(l.info || '')), 'queda constancia en el registro');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok(!(fresh.tags || []).includes('despues-del-envio'), 'no avanzó a los pasos siguientes');
});

test('ventana del workflow: los pasos que NO envían nada se ejecutan igual', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Leo', lastName: 'M', phone: '0990000000' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Ventana solo para envíos', active: true,
    sendWindow: ventanaCerradaHoy(),
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'tag', type: 'add_tag', position: { x: 0, y: 130 }, data: { tag: 'etiquetado' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'tag', sourceHandle: 'default' }],
  });

  const enr = await run(clinic._id, wf, patient._id, 'tag');
  assert.equal(enr.status, 'done');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('etiquetado'), 'etiquetar no depende del horario');
});

test('sin ventana configurada el flujo se comporta como siempre', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Sara', lastName: 'P', phone: '0991112223' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Sin ventana', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'tag', type: 'add_tag', position: { x: 0, y: 130 }, data: { tag: 'sin-ventana' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'tag', sourceHandle: 'default' }],
  });
  assert.equal(wf.sendWindow.mode, 'any', 'por defecto no restringe');

  const enr = await run(clinic._id, wf, patient._id, 'tag');
  assert.equal(enr.status, 'done');
});

test('nodo Ventana horaria: retiene el flujo hasta la apertura y luego continúa', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Iván', lastName: 'R', phone: '0993334445' });
  const cerrada = ventanaCerradaHoy();
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Con nodo ventana', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'win', type: 'window', position: { x: 0, y: 130 }, data: { windowDays: cerrada.days, windowFrom: '09:00', windowTo: '18:00' } },
      { id: 'tag', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'tras-la-ventana' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'win', sourceHandle: 'default' },
      { id: 'e1', source: 'win', target: 'tag', sourceHandle: 'default' },
    ],
  });

  const enr = await run(clinic._id, wf, patient._id, 'win');
  assert.equal(enr.status, 'waiting');
  assert.equal(enr.currentNodeId, 'tag', 'la ventana ya se consumió: al despertar sigue por el paso siguiente');
  assert.ok(enr.nextRunAt > new Date());
  let fresh = await Patient.findById(patient._id).lean();
  assert.ok(!(fresh.tags || []).includes('tras-la-ventana'), 'aún no ejecutó lo que venía después');

  // Al abrir la ventana (se simula con una franja siempre abierta) el flujo sigue.
  await Workflow.updateOne(
    { _id: wf._id, 'nodes.id': 'win' },
    { $set: { 'nodes.$.data': { windowDays: VENTANA_ABIERTA.days, windowFrom: '00:00', windowTo: '23:59' } } }
  );
  const again = await run(clinic._id, wf, patient._id, 'win');
  assert.equal(again.status, 'done');
  fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('tras-la-ventana'), 'con la ventana abierta continúa de inmediato');
});
