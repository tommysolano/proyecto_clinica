/**
 * Cancelar una inscripción viva desde el panel de "Inscritos": libera al contacto
 * para que el próximo envío/importación lo vuelva a inscribir (el dedup lo saltaba
 * mientras tuviera una inscripción viva — causa de "a este contacto no le llega").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/workflowController');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await Workflow.create({
    clinic: clinicId, name: 'Flujo', active: true,
    trigger: { type: 'contact_import' }, steps: [{ type: 'add_tag', tag: 'x' }],
  });
  const enroll = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting',
    nextRunAt: new Date(Date.now() + 3600 * 1000),
    context: { phone: '593999111222', contactId: 'c1' },
  });
  return { clinicId, userId, wf, enroll };
}

test('cancelEnrollment: una inscripción en espera pasa a cancelled y sin nextRunAt', async () => {
  const { clinicId, userId, wf, enroll } = await seed();
  const req = H.mockReq(clinicId, userId, {}, { params: { id: String(wf._id), enrollId: String(enroll._id) } });
  const { statusCode, payload } = await H.runController(ctrl.cancelEnrollment, req);
  assert.equal(statusCode, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const fresh = await WorkflowEnrollment.findById(enroll._id).lean();
  assert.equal(fresh.status, 'cancelled');
  assert.equal(fresh.nextRunAt, null);
});

test('cancelEnrollment: una inscripción ya completada no se toca (400)', async () => {
  const { clinicId, userId, wf, enroll } = await seed();
  enroll.status = 'done';
  await enroll.save();
  const req = H.mockReq(clinicId, userId, {}, { params: { id: String(wf._id), enrollId: String(enroll._id) } });
  const { statusCode } = await H.runController(ctrl.cancelEnrollment, req);
  assert.equal(statusCode, 400);
});

test('cancelEnrollment: no cancela inscripciones de OTRA clínica (404)', async () => {
  const { userId, wf, enroll } = await seed();
  const otra = new H.mongoose.Types.ObjectId();
  const req = H.mockReq(otra, userId, {}, { params: { id: String(wf._id), enrollId: String(enroll._id) } });
  const { statusCode } = await H.runController(ctrl.cancelEnrollment, req);
  assert.equal(statusCode, 404);
});
