/**
 * VENTANAS HORARIAS de las automatizaciones, extremo a extremo sobre el motor.
 *
 * La franja configurada es la de SILENCIO (ago-2026): dentro de ella el flujo se
 * calla, fuera envía. Antes significaba lo contrario y en producción todas las
 * ventanas decían `23:00–06:20` con la intención de "no molestar de noche" — el
 * sistema las leía como "enviar SOLO de noche" y hacía justo eso.
 *
 *  - `workflow.sendWindow`: un paso de ENVÍO que cae en el silencio no se salta
 *    ni se manda igual: la inscripción queda `waiting` con nextRunAt al FINAL de
 *    la franja y el MISMO paso se ejecuta entonces.
 *  - nodo `window` del diagrama: retiene TODO lo que venga después (aunque no
 *    envíe nada) mientras dure el silencio.
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

// Silencio que está SEGURO activo ahora mismo: hoy, día completo (from === to =
// 24 h). Así el test no depende de la hora a la que se ejecute.
function silencioAhora() {
  return { mode: 'specific', days: [new Date().getDay()], from: '00:00', to: '00:00' };
}
// Silencio que hoy NO aplica: el único día marcado es el de pasado mañana.
function silencioOtroDia() {
  return { mode: 'specific', days: [(new Date().getDay() + 2) % 7], from: '09:00', to: '18:00' };
}

async function run(clinicId, wf, patientId, startNode) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: patientId,
    currentNodeId: startNode, startNodeId: 'trigger', status: 'active', context: {},
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

test('ventana del workflow: un paso de ENVÍO en pleno silencio espera al final de la franja', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Con ventana', active: true,
    sendWindow: silencioAhora(),
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
  assert.ok((enr.log || []).some((l) => /En horario de silencio/.test(l.info || '')), 'queda constancia en el registro');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok(!(fresh.tags || []).includes('despues-del-envio'), 'no avanzó a los pasos siguientes');
});

test('ventana del workflow: FUERA del silencio el envío sale de inmediato', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Noe', lastName: 'T', phone: '0995556667' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Silencio otro día', active: true,
    sendWindow: silencioOtroDia(),
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
  assert.notEqual(enr.status, 'waiting', 'no retiene: hoy no hay silencio');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('despues-del-envio'), 'siguió al paso posterior');
});

test('ventana del workflow: los pasos que NO envían nada se ejecutan igual', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Leo', lastName: 'M', phone: '0990000000' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Ventana solo para envíos', active: true,
    sendWindow: silencioAhora(),
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
  assert.ok((fresh.tags || []).includes('etiquetado'), 'etiquetar no molesta a nadie: no depende del horario');
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

test('nodo Ventana horaria: calla el flujo durante la franja y luego continúa', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Iván', lastName: 'R', phone: '0993334445' });
  const callando = silencioAhora();
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Con nodo ventana', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'win', type: 'window', position: { x: 0, y: 130 }, data: { windowDays: callando.days, windowFrom: callando.from, windowTo: callando.to } },
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
  assert.ok((enr.log || []).some((l) => /En horario de silencio/.test(l.info || '')));
  let fresh = await Patient.findById(patient._id).lean();
  assert.ok(!(fresh.tags || []).includes('tras-la-ventana'), 'aún no ejecutó lo que venía después');

  // Cuando el silencio ya no aplica (se simula moviéndolo a otro día), sigue.
  const otro = silencioOtroDia();
  await Workflow.updateOne(
    { _id: wf._id, 'nodes.id': 'win' },
    { $set: { 'nodes.$.data': { windowDays: otro.days, windowFrom: otro.from, windowTo: otro.to } } }
  );
  const again = await run(clinic._id, wf, patient._id, 'win');
  assert.equal(again.status, 'done');
  fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('tras-la-ventana'), 'fuera del silencio continúa de inmediato');
});

test('una ventana imposible (24 h los 7 días) no deja preso al contacto', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Eva', lastName: 'Q', phone: '0997778889' });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Ventana imposible', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'win', type: 'window', position: { x: 0, y: 130 }, data: { windowDays: [0, 1, 2, 3, 4, 5, 6], windowFrom: '08:00', windowTo: '08:00' } },
      { id: 'tag', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'paso' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'win', sourceHandle: 'default' },
      { id: 'e1', source: 'win', target: 'tag', sourceHandle: 'default' },
    ],
  });

  const enr = await run(clinic._id, wf, patient._id, 'win');
  assert.equal(enr.status, 'done', 'se ignora la ventana en vez de esperar para siempre');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('paso'));
});
