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

  // La sesión QR no está viva en el test → qr_not_connected es TRANSITORIO: la
  // inscripción queda EN ESPERA reintentando (no quema el turno del paciente).
  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'waiting' })
  );
  assert.ok(enrollment, 'no se inscribió el workflow');
  assert.ok(
    (enrollment.log || []).some((l) => l.type === 'retry' && /QR/i.test(l.info || '')),
    'el registro debe explicar que el QR está caído y que se reintenta'
  );

  // Agotar los reintentos: el fallo se vuelve definitivo y el flujo CONTINÚA
  // (el add_tag posterior debe correr aunque el envío muriera).
  await WorkflowEnrollment.updateOne(
    { _id: enrollment._id },
    { $set: { 'context.sendRetries': 36, nextRunAt: new Date(Date.now() - 1000) } }
  );
  await require('../utils/workflowEngine').processDueEnrollments();
  const done = await WorkflowEnrollment.findOne({ _id: enrollment._id, status: 'done' });
  assert.ok(done, 'agotados los reintentos, el flujo termina en vez de colgarse');
  const sendLog = (done.log || []).find((l) => l.type === 'send_message');
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
// Disparador "mensaje desde anuncio (Meta Ads)": un flujo puede vincularse a
// VARIOS anuncios (adFilter = IDs separados por coma). Dispara con cualquiera de
// ellos y NO con anuncios ajenos ni con mensajes normales (sin anuncio).
function ctwaWorkflow(clinicId, adFilter) {
  const tr = { type: 'ctwa_ad', audience: 'all', adFilter };
  return Workflow.create({
    clinic: clinicId,
    name: 'Anuncio Meta',
    active: true,
    triggers: [tr],
    trigger: tr,
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [tr] } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 130 }, data: { body: 'Gracias por escribir desde el anuncio' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' }],
  });
}

test('Trigger "mensaje desde anuncio" (ctwa_ad) con VARIOS IDs: dispara con cualquiera de ellos, no con otros', async () => {
  const Conversation = require('../models/Conversation');
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await ctwaWorkflow(clinic._id, 'ad_1, ad_2, ad_3');

  // Mensaje que llega desde el anuncio ad_2 (uno de los vinculados) → inscribe.
  const conv1 = await Conversation.create({ clinic: clinic._id, phone: '593990000001', channel: 'whatsapp' });
  const r1 = await workflowEngine.enrollForChatMessage({
    clinicId: clinic._id, conversation: conv1, patient: null,
    phone: conv1.phone, text: 'Hola, vi su anuncio', isNew: true,
    referral: { adId: 'ad_2' },
  });
  assert.equal(r1.enrolled, 1, 'un anuncio vinculado (ad_2) debía disparar el flujo');
  assert.ok(await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv1._id }));

  // Mensaje desde un anuncio NO vinculado (ad_9) → no inscribe.
  const conv2 = await Conversation.create({ clinic: clinic._id, phone: '593990000002', channel: 'whatsapp' });
  const r2 = await workflowEngine.enrollForChatMessage({
    clinicId: clinic._id, conversation: conv2, patient: null,
    phone: conv2.phone, text: 'Hola', isNew: true,
    referral: { adId: 'ad_9' },
  });
  assert.equal(r2.enrolled, 0, 'un anuncio ajeno (ad_9) no debía disparar el flujo');

  // Mensaje normal SIN anuncio (chat común) → tampoco dispara el ctwa_ad.
  const conv3 = await Conversation.create({ clinic: clinic._id, phone: '593990000003', channel: 'whatsapp' });
  const r3 = await workflowEngine.enrollForChatMessage({
    clinicId: clinic._id, conversation: conv3, patient: null,
    phone: conv3.phone, text: 'Hola', isNew: true,
    referral: null,
  });
  assert.equal(r3.enrolled, 0, 'un mensaje sin anuncio no debía disparar el ctwa_ad');
});

test('Trigger "mensaje desde anuncio" (ctwa_ad) SIN filtro: dispara con cualquier anuncio', async () => {
  const Conversation = require('../models/Conversation');
  const clinic = await Clinic.create({ name: 'Principal' });
  const wf = await ctwaWorkflow(clinic._id, ''); // vacío = cualquier anuncio

  const conv = await Conversation.create({ clinic: clinic._id, phone: '593990000004', channel: 'whatsapp' });
  const r = await workflowEngine.enrollForChatMessage({
    clinicId: clinic._id, conversation: conv, patient: null,
    phone: conv.phone, text: 'Hola', isNew: true,
    referral: { adId: 'cualquier_id_de_anuncio' },
  });
  assert.equal(r.enrolled, 1, 'sin filtro, cualquier anuncio debía disparar el flujo');
  assert.ok(await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv._id }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Nodos de Marketing (Meta): se ejecutan a través de performAction y, sin
// credenciales configuradas, registran el motivo en el log sin romper el flujo.
function metaNodeWorkflow(clinicId, node) {
  return Workflow.create({
    clinic: clinicId, name: 'Meta node', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    trigger: { type: 'appointment_created', audience: 'all' },
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created', audience: 'all' }] } },
      { id: 'n1', ...node, position: { x: 0, y: 130 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' }],
  });
}

test('Nodo "API de conversión de Meta" (meta_capi): se ejecuta y registra que CAPI no está configurada', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Capi', lastName: 'Test', phone: '0997778888' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await metaNodeWorkflow(clinic._id, { type: 'meta_capi', data: { metaEventName: 'Schedule' } });

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: futureDate(3), startTime: '10:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enr = await waitFor(() => WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' }));
  assert.ok(enr, 'no se inscribió el workflow con nodo meta_capi');
  const log = (enr.log || []).find((l) => l.type === 'meta_capi');
  assert.ok(log, 'no hay rastro del paso meta_capi en el registro');
  assert.equal(log.ok, false);
  assert.match(log.info, /CAPI/);
});

test('Nodo "Añadir a público de Facebook" (fb_audience_add): se ejecuta y registra que la Marketing API no está configurada', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Aud', lastName: 'Test', phone: '0996665555' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await metaNodeWorkflow(clinic._id, { type: 'fb_audience_add', data: { audienceId: '2384812345' } });

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: futureDate(3), startTime: '11:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enr = await waitFor(() => WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' }));
  assert.ok(enr, 'no se inscribió el workflow con nodo fb_audience_add');
  const log = (enr.log || []).find((l) => l.type === 'fb_audience_add');
  assert.ok(log, 'no hay rastro del paso fb_audience_add en el registro');
  assert.equal(log.ok, false);
  assert.match(log.info, /Marketing API/);
});

/** Día calendario futuro (YYYY-MM-DD) a N días de hoy: las citas no pueden agendarse en el pasado. */
function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
test('Botón "No asistió" (markNoShow) dispara el workflow de no-show', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Noe', lastName: 'Show', phone: '0995556666' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await graphWorkflow(clinic._id, { triggerType: 'appointment_no_show', body: 'Te extrañamos {{nombre}}' });

  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: futureDate(3), startTime: '10:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // Nadie debe inscribirse todavía (el trigger es no-show, no cita agendada).
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 0);

  const rNo = await H.runController(
    appointmentCtrl.markNoShow,
    H.mockReq(clinic._id, userId, {}, { params: { id: String(r.payload._id) } })
  );
  assert.equal(rNo.statusCode, 200, JSON.stringify(rNo.payload));

  // ANTES: markNoShow no emitía APPOINTMENT_NO_SHOW y el workflow jamás corría
  // (solo el job nocturno de citas vencidas lo disparaba).
  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'marcar "no asistió" a mano debe inscribir el workflow de no-show');
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.ok(sendLog, 'el paso de envío debe dejar rastro en el log');

  // UN envío por cita y por evento: ni el doble clic (markNoShow idempotente) ni
  // un evento repetido del mismo tipo (p. ej. botón + barrido automático) deben
  // crear otra inscripción aunque la primera ya haya terminado.
  const rNo2 = await H.runController(
    appointmentCtrl.markNoShow,
    H.mockReq(clinic._id, userId, {}, { params: { id: String(r.payload._id) } })
  );
  assert.equal(rNo2.statusCode, 200);
  await workflowEngine.enrollForEvent('appointment_no_show', {
    clinicId: String(clinic._id),
    patientId: String(patient._id),
    appointmentId: String(r.payload._id),
    appointmentDate: new Date(),
    isFirstVisit: false,
    services: [],
  });
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(
    await WorkflowEnrollment.countDocuments({ workflow: wf._id }),
    1,
    'el mismo evento de la misma cita no debe generar otra inscripción (otro mensaje)'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
test('Filtro por sucursal en el disparador: cada sede corre SOLO su flujo (un video por sucursal)', async () => {
  const clinicA = await Clinic.create({ name: 'Matriz' }); // la más antigua = ancla del CRM
  const clinicB = await Clinic.create({ name: 'Extensión' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinicA._id, firstName: 'Multi', lastName: 'Sede', phone: '0993214321' });
  const prod = await H.makeProduct(clinicA._id, { category: 'servicio', unlimited: true });
  const trigA = { type: 'appointment_created', audience: 'all', serviceFilter: null, clinicFilter: clinicA._id };
  const trigB = { type: 'appointment_created', audience: 'all', serviceFilter: null, clinicFilter: clinicB._id };
  const wf = await Workflow.create({
    clinic: clinicA._id,
    name: 'Video de bienvenida por sede',
    active: true,
    triggers: [trigA, trigB],
    trigger: trigA,
    steps: [],
    nodes: [
      { id: 'trigA', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [trigA] } },
      { id: 'mA', type: 'send_media', position: { x: 0, y: 130 }, data: { mediaUrl: 'https://cdn/videoA.mp4', mediaType: 'video' } },
      { id: 'trigB', type: 'trigger', position: { x: 240, y: 0 }, data: { triggers: [trigB] } },
      { id: 'mB', type: 'send_media', position: { x: 240, y: 130 }, data: { mediaUrl: 'https://cdn/videoB.mp4', mediaType: 'video' } },
    ],
    edges: [
      { id: 'eA', source: 'trigA', target: 'mA', sourceHandle: 'default' },
      { id: 'eB', source: 'trigB', target: 'mB', sourceHandle: 'default' },
    ],
  });

  // Cita agendada en la sucursal B (Extensión) → solo el flujo B debe correr.
  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinicB._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: futureDate(4), startTime: '10:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'la cita en la sucursal B debió inscribir su flujo');
  assert.equal(enrollment.startNodeId, 'trigB', 'debe correr el flujo de la sucursal B (no el de A)');
  assert.equal(String(enrollment.context.eventClinicId), String(clinicB._id));
  const mediaLog = (enrollment.log || []).find((l) => l.type === 'send_media');
  assert.ok(mediaLog, 'el nodo de imagen/video debe dejar rastro en el log');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1, 'el flujo de la sucursal A no debe correr');
});

// ─────────────────────────────────────────────────────────────────────────────
test('autoNoShow marca las citas de HOY cuya hora ya venció y dispara el workflow de no-show', async () => {
  const Appointment = require('../models/Appointment');
  const { runAutoNoShow } = require('../utils/autoNoShow');
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Tarde', lastName: 'Hoy', phone: '0991112222' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await graphWorkflow(clinic._id, { triggerType: 'appointment_no_show' });

  // Cita hace 3 horas (insertada directo: el controller ya no permite crearla en
  // el pasado). Si el test corre de madrugada la hora cae en el día anterior y
  // la marca el barrido de días pasados: el resultado esperado es el mismo.
  const start = new Date(Date.now() - 3 * 3600000);
  const dateAnchor = new Date(start);
  dateAnchor.setHours(12, 0, 0, 0); // forma de guardado: día calendario a las 12:00 local
  const startHHMM = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  const appt = await Appointment.create({
    clinic: clinic._id, patient: patient._id, date: dateAnchor, startTime: startHHMM,
    services: [{ product: prod._id, name: 'Consulta' }], status: 'pendiente',
  });

  const marked = await runAutoNoShow();
  assert.ok(marked >= 1, 'el barrido debió marcar al menos esta cita');
  const after = await Appointment.findById(appt._id);
  assert.equal(after.status, 'no_asistio', 'la cita de hoy con hora vencida debe pasar a no_asistio');

  // Y el evento inscribió el workflow de no-show.
  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'done' })
  );
  assert.ok(enrollment, 'el no-show automático debe disparar el workflow');
});

// ─────────────────────────────────────────────────────────────────────────────
test('"Esperar hasta la cita" espera a la hora REAL; reagendar mueve la espera y cancelar la anula', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Rea', lastName: 'Genda', phone: '0997778888' });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const trigger = { type: 'appointment_created', audience: 'all', serviceFilter: null };
  const wf = await Workflow.create({
    clinic: clinic._id,
    name: 'Recordatorio 1h antes',
    active: true,
    triggers: [trigger],
    trigger,
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [trigger] } },
      { id: 'w1', type: 'wait_until', position: { x: 0, y: 130 }, data: { waitEvent: 'appointment_date', waitMode: 'offset', offsetMinutes: -60 } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 260 }, data: { body: 'Tu cita es en 1 hora' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'w1', sourceHandle: 'default' },
      { id: 'e2', source: 'w1', target: 'n1', sourceHandle: 'default' },
    ],
  });

  const day = futureDate(5);
  const r = await H.runController(appointmentCtrl.createAppointment, H.mockReq(clinic._id, userId, {
    patient: patient._id, services: [String(prod._id)], date: day, startTime: '10:00',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enrollment = await waitFor(() =>
    WorkflowEnrollment.findOne({ workflow: wf._id, patient: patient._id, status: 'waiting' })
  );
  assert.ok(enrollment, 'la inscripción debió quedar en espera del wait_until');
  // ANTES: la espera se calculaba desde `date` (12:00) y el recordatorio salía a
  // las 11:00 sin importar la hora de la cita. AHORA: 10:00 - 1h = 09:00 Ecuador.
  const expected = new Date(`${day}T09:00:00-05:00`);
  assert.equal(new Date(enrollment.nextRunAt).getTime(), expected.getTime(),
    `la espera debe ser 1h antes de la HORA REAL de la cita (esperado ${expected.toISOString()}, fue ${new Date(enrollment.nextRunAt).toISOString()})`);
  assert.equal(enrollment.context.waitNodeId, 'w1');

  // Reagendar (otro día a las 15:00) debe MOVER la espera a las 14:00 del nuevo día.
  const day2 = futureDate(6);
  const r2 = await H.runController(appointmentCtrl.updateAppointment, H.mockReq(clinic._id, userId, {
    date: day2, startTime: '15:00',
  }, { params: { id: String(r.payload._id) } }));
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.payload));
  const expected2 = new Date(`${day2}T14:00:00-05:00`);
  const moved = await waitFor(async () => {
    const e = await WorkflowEnrollment.findById(enrollment._id);
    return e && new Date(e.nextRunAt).getTime() === expected2.getTime() ? e : null;
  });
  assert.ok(moved, 'reagendar la cita debe recalcular la espera con la nueva fecha/hora');
  assert.equal(String(moved.status), 'waiting');

  // Cancelar la cita ANULA la espera: no debe llegar el recordatorio de una cita muerta.
  const rDel = await H.runController(
    appointmentCtrl.deleteAppointment,
    H.mockReq(clinic._id, userId, {}, { params: { id: String(r.payload._id) } })
  );
  assert.equal(rDel.statusCode, 200, JSON.stringify(rDel.payload));
  const cancelled = await waitFor(async () => {
    const e = await WorkflowEnrollment.findById(enrollment._id);
    return e && e.status === 'cancelled' ? e : null;
  });
  assert.ok(cancelled, 'cancelar la cita debe anular la inscripción en espera del recordatorio');
});

// ─────────────────────────────────────────────────────────────────────────────
test('Disparo MANUAL desde el chat: ejecuta el flujo con la próxima cita en el contexto y evita duplicados vivos', async () => {
  const chatCtrl = require('../controllers/chatController');
  const Conversation = require('../models/Conversation');
  const Appointment = require('../models/Appointment');
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Manu', lastName: 'Al', phone: '0994445555' });
  const conv = await Conversation.create({ clinic: clinic._id, phone: '593994445555', channel: 'whatsapp', patient: patient._id });
  const prod = await H.makeProduct(clinic._id, { category: 'servicio', unlimited: true });
  const wf = await graphWorkflow(clinic._id, { triggerType: 'appointment_no_show', body: 'Te esperamos {{nombre}}' });
  // Próxima cita del paciente: debe entrar al contexto del disparo manual.
  const appt = await Appointment.create({
    clinic: clinic._id, patient: patient._id, date: new Date(`${futureDate(3)}T12:00:00`),
    startTime: '10:00', services: [{ product: prod._id, name: 'Consulta' }], status: 'pendiente',
  });

  const r = await H.runController(
    chatCtrl.runWorkflowManually,
    H.mockReq(clinic._id, userId, { workflowId: String(wf._id), startNodeId: 'trigger' }, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.ok, true);

  const enrollment = await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv._id });
  assert.ok(enrollment, 'el disparo manual debe crear la inscripción');
  assert.equal(String(enrollment.context.eventType), 'manual');
  assert.equal(String(enrollment.context.appointmentId), String(appt._id), 'la próxima cita del paciente entra al contexto');
  assert.equal(enrollment.status, 'done');
  const sendLog = (enrollment.log || []).find((l) => l.type === 'send_message');
  assert.ok(sendLog, 'el paso de envío debe dejar rastro en el log');
  // El fallo de envío (sin WhatsApp en test) vuelve como warning para el agente.
  assert.ok(r.payload.warning, 'el primer fallo del log debe volver como warning');

  // Un workflow pausado no se puede disparar.
  await Workflow.updateOne({ _id: wf._id }, { active: false });
  const paused = await H.runController(
    chatCtrl.runWorkflowManually,
    H.mockReq(clinic._id, userId, { workflowId: String(wf._id) }, { params: { id: String(conv._id) } })
  );
  assert.equal(paused.statusCode, 400);
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
