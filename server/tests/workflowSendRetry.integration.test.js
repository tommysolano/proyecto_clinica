/**
 * UN ENVÍO QUE TROPIEZA NO PUEDE PERDERSE.
 *
 * CASO REAL (ago-2026): la pestaña de WhatsApp Web se recargó a mitad del envío de
 * una automatización. El motor pintó el fallo ("La sesión de WhatsApp Web se
 * recargó en mitad del envío…"), NO reintentó y SIGUIÓ con el paso siguiente del
 * flujo: ese mensaje no le llegó nunca al contacto y nadie se enteró.
 *
 * Aquí se fija que los fallos TRANSITORIOS del canal (sesión recargada, número QR
 * caído) dejan la inscripción esperando y reintentando el MISMO paso, y que un
 * fallo definitivo (opt-out, ventana de 24 h) sí deja continuar el flujo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');
const messaging = require('../utils/messaging');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

const realSend = messaging.send;

test.before(async () => { await H.startDb(); });
test.after(async () => { messaging.send = realSend; await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); messaging.send = realSend; });

/** Flujo: enviar mensaje → etiquetar (la etiqueta delata si el flujo siguió). */
async function flujoConEnvio(clinicId) {
  return Workflow.create({
    clinic: clinicId, name: 'Envío + etiqueta', active: true,
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
}

async function corre(clinicId, wf, patientId) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: patientId,
    currentNodeId: 'msg', startNodeId: 'trigger', status: 'active', context: { phone: '0991234567' },
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

test('sesión de WhatsApp recargada a mitad del envío: se reintenta, NO se pasa al siguiente paso', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Janeth', lastName: 'C', phone: '0991234567' });
  const wf = await flujoConEnvio(clinic._id);
  messaging.send = async () => ({
    ok: false,
    deliveryStatus: 'failed',
    errorCode: 'qr_send_unconfirmed',
    errorMessage: 'La sesión de WhatsApp Web se recargó en mitad del envío y no se pudo comprobar si salió. — enviado vía «Recepcion 2»',
  });

  const enr = await corre(clinic._id, wf, patient._id);
  assert.equal(enr.status, 'waiting', 'la inscripción espera para reintentar');
  assert.equal(enr.currentNodeId, 'msg', 'se reintenta el MISMO envío');
  assert.equal(enr.context.sendRetries, 1);
  assert.ok(enr.nextRunAt > new Date(), 'con hora de reintento');
  assert.ok(
    (enr.log || []).some((l) => l.type === 'retry' && /Se reintenta en 5 min/.test(l.info || '')),
    'el registro explica que se reintenta'
  );
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok(!(fresh.tags || []).includes('despues-del-envio'), 'el flujo NO siguió sin haber enviado');
});

test('la sesión comprobó que el mensaje no salió: mismo trato (reintento)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Luis', lastName: 'M', phone: '0991234567' });
  const wf = await flujoConEnvio(clinic._id);
  messaging.send = async () => ({ ok: false, errorCode: 'qr_send_failed', errorMessage: 'no salió' });

  const enr = await corre(clinic._id, wf, patient._id);
  assert.equal(enr.status, 'waiting');
  assert.equal(enr.currentNodeId, 'msg');
});

test('un adjunto sin confirmar también se reintenta', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'P', phone: '0991234567' });
  const wf = await flujoConEnvio(clinic._id);
  messaging.send = async () => ({ ok: false, errorCode: 'qr_media_unconfirmed', errorMessage: 'sin confirmar' });

  const enr = await corre(clinic._id, wf, patient._id);
  assert.equal(enr.status, 'waiting');
});

test('un fallo DEFINITIVO (opt-out) no se reintenta: se registra y el flujo continúa', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Eva', lastName: 'Q', phone: '0991234567' });
  const wf = await flujoConEnvio(clinic._id);
  messaging.send = async () => ({ ok: false, skipped: true, reason: 'opt_out' });

  const enr = await corre(clinic._id, wf, patient._id);
  assert.equal(enr.status, 'done', 'no tiene sentido reintentar un opt-out');
  const sendLog = (enr.log || []).find((l) => l.type === 'send_message');
  assert.equal(sendLog?.ok, false);
  assert.match(String(sendLog?.info || ''), /opt-out/i);
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('despues-del-envio'), 'el resto del flujo sí se ejecuta');
});

test('agotados los reintentos el flujo continúa (nadie se queda colgado para siempre)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Tito', lastName: 'B', phone: '0991234567' });
  const wf = await flujoConEnvio(clinic._id);
  messaging.send = async () => ({ ok: false, errorCode: 'qr_send_unconfirmed', errorMessage: 'sin confirmar' });

  const enr = await WorkflowEnrollment.create({
    clinic: clinic._id, workflow: wf._id, patient: patient._id,
    currentNodeId: 'msg', startNodeId: 'trigger', status: 'active',
    context: { phone: '0991234567', sendRetries: 36 }, // ya se agotaron
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  const after = await WorkflowEnrollment.findById(enr._id);
  assert.equal(after.status, 'done');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('despues-del-envio'));
});
