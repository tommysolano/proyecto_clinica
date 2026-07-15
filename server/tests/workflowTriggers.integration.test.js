/**
 * Integración del CRM: dispara workflows reales desde los controllers (cita
 * agendada) contra un Mongo en memoria, y valida el bloqueo de agenda por cupo
 * de servicio con catálogo compartido entre sucursales.
 *
 * Reproduce los dos bugs reportados:
 *  1. "Creé un workflow con trigger cita agendada, agendé y no pasó nada":
 *     el envío se saltaba en silencio (sin WhatsApp conectado / fuera de ventana
 *     24h) y no quedaba NINGÚN rastro. Ahora la inscripción se crea igual y el
 *     fallo queda en el registro de ejecución (log + lastError).
 *  2. "El bloqueo por cupo de servicio/programa no funciona": el chequeo
 *     filtraba Product por la clínica que agenda, pero el catálogo es
 *     compartido (el producto pertenece a la clínica que lo creó) → nunca
 *     encontraba el servicio y no aplicaba el cupo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appointmentCtrl = require('../controllers/appointmentController');
const workflowEngine = require('../utils/workflowEngine');
const { clearCache } = require('../utils/callCenterClinic');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => {
  await H.startDb();
  workflowEngine.subscribeDomainEvents();
});
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => {
  await H.resetDb();
  clearCache(); // la clínica ancla del CRM se cachea 30s; cada test parte limpio
});

/** Espera hasta que la condición devuelva un valor truthy (o vence el timeout). */
async function waitFor(fn, { timeout = 4000, every = 50 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

function graphWorkflow(clinicId, { triggerType = 'appointment_created', body = 'Hola {{nombre}}' } = {}) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Bienvenida cita',
    active: true,
    triggers: [{ type: triggerType, audience: 'all', serviceFilter: null }],
    trigger: { type: triggerType, audience: 'all', serviceFilter: null },
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: triggerType, audience: 'all' }] } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 130 }, data: { body } },
      { id: 'n2', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'cita-agendada' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' },
      { id: 'e2', source: 'n1', target: 'n2', sourceHandle: 'default' },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
test('Trigger "cita agendada" (grafo): inscribe, registra el fallo de envío y sigue con los demás pasos', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({
    clinic: clinic._id, firstName: 'Ana', lastName: 'Vera', phone: '0991234567',
  });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true, name: 'Limpieza' });
  const wf = await graphWorkflow(clinic._id);

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: '2026-07-20', startTime: '10:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // El evento de dominio corre con setImmediate: esperar a que la inscripción exista.
  const enrollment = await waitFor(async () => {
    const e = await WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id });
    return e && e.status === 'done' ? e : null;
  });
  assert.ok(enrollment, 'no se creó la inscripción del workflow al agendar la cita');

  // El envío falló (no hay WhatsApp configurado) pero quedó REGISTRADO, no en silencio.
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.ok(sendLog, 'el paso send_message no dejó rastro en el log');
  assert.equal(sendLog.ok, false);
  assert.ok(enrollment.lastError, 'lastError vacío pese al envío fallido');

  // Y el flujo NO se abortó: el paso siguiente (etiqueta) sí se aplicó.
  const p = await Patient.findById(patient._id);
  assert.ok((p.tags || []).includes('cita-agendada'), 'el paso add_tag posterior al envío fallido no corrió');

  const wfAfter = await Workflow.findById(wf._id);
  assert.equal(wfAfter.stats.enrolled, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Trigger "cita agendada": paciente SIN teléfono también se inscribe (el fallo queda en el log)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Sin', lastName: 'Fono' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await graphWorkflow(clinic._id);

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: '2026-07-21', startTime: '09:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'sin teléfono ya no debe impedir la inscripción');
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.equal(sendLog?.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Trigger "cita agendada" con contacto de número oculto (LID): el mensaje va a la conversación EXISTENTE del paciente', async () => {
  const Conversation = require('../models/Conversation');
  const WhatsappAccount = require('../models/WhatsappAccount');
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  // Paciente vinculado desde el chat: SIN teléfono en la ficha (el número real
  // de un contacto LID no se conoce).
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Lid', lastName: 'Oculto' });
  const acc = await WhatsappAccount.create({ label: 'Finca', connectionType: 'qr', enabled: true, status: 'connected' });
  await Conversation.create({
    clinic: clinic._id,
    phone: '243142896943159', // dígitos del LID: NO son un teléfono real
    channel: 'whatsapp',
    patient: patient._id,
    externalUserId: '243142896943159@lid',
    whatsappAccount: acc._id,
  });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await graphWorkflow(clinic._id);

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: '2026-07-23', startTime: '09:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'no se inscribió el workflow');
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.ok(sendLog, 'sin rastro del envío en el log');
  // ANTES: fallaba con "destino inválido" (buscaba la conversación por el
  // teléfono de la ficha, vacío en contactos LID) y el mensaje no aparecía en
  // ningún lado. AHORA resuelve la conversación del PACIENTE y llega hasta el
  // proveedor (aquí falla solo porque la sesión QR no está viva en el test).
  assert.match(String(sendLog.info || ''), /QR/i, `motivo inesperado: ${sendLog.info}`);
  assert.doesNotMatch(String(sendLog.info || ''), /destino válido/i);
  // Y el intento quedó en ESA conversación (visible en el chat), sin crear otra.
  const convs = await Conversation.find({ clinic: clinic._id });
  assert.equal(convs.length, 1, 'no debe crearse otra conversación');
  const Message = require('../models/Message');
  const msg = await Message.findOne({ conversation: convs[0]._id, direction: 'out' });
  assert.ok(msg, 'el intento de envío debe quedar como mensaje en la conversación del paciente');
  // El paso add_tag etiqueta al paciente Y a la conversación (la bandeja de
  // chats muestra las etiquetas de la conversación).
  assert.ok((convs[0].tags || []).includes('cita-agendada'), 'la etiqueta debe verse en la conversación (chats)');
  const pLid = await Patient.findById(patient._id);
  assert.ok((pLid.tags || []).includes('cita-agendada'), 'la etiqueta debe quedar también en el paciente');
});

// ─────────────────────────────────────────────────────────────────────────────
test('Cita creada DESDE EL CHAT (createAppointmentFromChat) también dispara el workflow de "cita agendada"', async () => {
  const chatCtrl = require('../controllers/chatController');
  const Conversation = require('../models/Conversation');
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Chat', lastName: 'Agenda', phone: '0993334444' });
  const conv = await Conversation.create({
    clinic: clinic._id,
    phone: '593993334444',
    channel: 'whatsapp',
    patient: patient._id,
  });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true, name: 'Botox' });
  const wf = await graphWorkflow(clinic._id);

  const r = await H.runController(
    chatCtrl.createAppointmentFromChat,
    H.mockReq(clinic._id, userId, {
      appointments: [
        { date: '2026-07-24', startTime: '11:00', services: [{ product: String(prod._id), quantity: 1 }] },
      ],
    }, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // ANTES: este camino creaba la cita sin emitir el evento de dominio y el
  // workflow jamás se enteraba (el usuario probaba justo desde el chat).
  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'la cita creada desde el chat no inscribió el workflow');
  assert.equal(String(enrollment.context?.appointmentId || ''), String(r.payload.appointment._id));
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.ok(sendLog, 'sin rastro del paso de envío');
});

// ─────────────────────────────────────────────────────────────────────────────
test('Cupo por servicio: bloquea la 2ª cita en el mismo horario aunque el servicio sea de OTRA sucursal', async () => {
  const owner = await Clinic.create({ name: 'Matriz' }); // dueña del producto
  const branch = await Clinic.create({ name: 'Sucursal Norte' }); // donde se agenda
  const userId = new H.mongoose.Types.ObjectId();
  const p1 = await Patient.create({ clinic: branch._id, firstName: 'P1', lastName: 'Uno', phone: '0990000001' });
  const p2 = await Patient.create({ clinic: branch._id, firstName: 'P2', lastName: 'Dos', phone: '0990000002' });
  const serv = await H.makeProduct(owner._id, {
    category: 'servicio', unlimited: true, name: 'Ecografía', maxAppointmentsPerDay: 1,
  });

  const r1 = await H.runController(appointmentCtrl.createAppointment, H.mockReq(branch._id, userId, {
    patient: p1._id, services: [String(serv._id)], date: '2026-07-22', startTime: '10:00',
  }));
  assert.equal(r1.statusCode, 201, JSON.stringify(r1.payload));

  // Misma fecha y hora → cupo (1) agotado, aunque el producto pertenezca a Matriz.
  const r2 = await H.runController(appointmentCtrl.createAppointment, H.mockReq(branch._id, userId, {
    patient: p2._id, services: [String(serv._id)], date: '2026-07-22', startTime: '10:00',
  }));
  assert.equal(r2.statusCode, 400, 'el cupo no bloqueó la segunda cita');
  assert.match(String(r2.payload.message), /Cupo agotado/);

  // Otra hora del mismo día sí se permite (el cupo es por horario).
  const r3 = await H.runController(appointmentCtrl.createAppointment, H.mockReq(branch._id, userId, {
    patient: p2._id, services: [String(serv._id)], date: '2026-07-22', startTime: '11:00',
  }));
  assert.equal(r3.statusCode, 201, JSON.stringify(r3.payload));

  // Cancelar la primera libera el cupo de las 10:00.
  const Appointment = require('../models/Appointment');
  await Appointment.updateOne({ _id: r1.payload._id }, { status: 'cancelada' });
  const r4 = await H.runController(appointmentCtrl.createAppointment, H.mockReq(branch._id, userId, {
    patient: p2._id, services: [String(serv._id)], date: '2026-07-22', startTime: '10:00',
  }));
  assert.equal(r4.statusCode, 201, 'una cita cancelada debe liberar su cupo');
});
