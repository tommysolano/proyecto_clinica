/**
 * Reclamo ATÓMICO de inscripciones en processDueEnrollments.
 *
 * Bug real de producción: el mensaje de un flujo se reenviaba CADA 5 MIN al mismo
 * contacto. Causa: dos procesos apuntando a la misma base (un 2º backend en el
 * VPS sin la SECRETS_KEY) tomaban la MISMA inscripción vencida a la vez —el job
 * hacía `find()` sin lock—: uno la enviaba y el otro la reprogramaba a +5 min, así
 * quedaba entregada Y en cola. Ahora cada inscripción se reclama con
 * findOneAndUpdate (atómico): un solo proceso la puede tomar por vez.
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

function graphWf(clinicId) {
  return Workflow.create({
    clinic: clinicId, name: 'Claim test', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    trigger: { type: 'appointment_created', audience: 'all' },
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created', audience: 'all' }] } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 130 }, data: { body: 'Hola {{nombre}}' } },
      { id: 'n2', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'x' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' },
      { id: 'e2', source: 'n1', target: 'n2', sourceHandle: 'default' },
    ],
  });
}

test('processDueEnrollments: dos ticks simultáneos procesan cada inscripción UNA sola vez', async () => {
  const clinic = await Clinic.create({ name: 'P' });
  const wf = await graphWf(clinic._id);
  const past = new Date(Date.now() - 1000);
  const N = 5;
  const patients = [];
  for (let i = 0; i < N; i++) {
    // eslint-disable-next-line no-await-in-loop
    const p = await Patient.create({ clinic: clinic._id, firstName: `C${i}`, lastName: 'X', phone: `09900000${10 + i}` });
    patients.push(p);
    // eslint-disable-next-line no-await-in-loop
    await WorkflowEnrollment.create({
      clinic: clinic._id, workflow: wf._id, patient: p._id,
      status: 'waiting', nextRunAt: past, stepIndex: 0, startNodeId: 'trigger',
      context: { phone: p.phone },
    });
  }

  // DOS procesos a la vez (simula dos backends sobre la MISMA base de datos).
  const [a, b] = await Promise.all([engine.processDueEnrollments(), engine.processDueEnrollments()]);

  // Clave: la suma de procesadas es EXACTAMENTE N. Con el bug (find sin lock) cada
  // tick veía las N vencidas → suma 2N y cada mensaje salía dos veces.
  assert.equal(a.processed + b.processed, N, `procesadas ${a.processed}+${b.processed}, esperado ${N}`);

  // Y cada inscripción terminó con UN solo intento de envío registrado.
  for (const p of patients) {
    // eslint-disable-next-line no-await-in-loop
    const e = await WorkflowEnrollment.findOne({ workflow: wf._id, patient: p._id });
    assert.equal(e.status, 'done', `la inscripción de ${p.firstName} no terminó`);
    const sends = (e.log || []).filter((l) => l.type === 'send_message');
    assert.equal(sends.length, 1, `${p.firstName}: ${sends.length} envíos en el log (debe ser 1)`);
  }
});
