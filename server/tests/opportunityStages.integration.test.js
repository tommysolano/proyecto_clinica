/**
 * "LAS ETAPAS DE LAS OPORTUNIDADES NO FUNCIONAN".
 *
 * Dos síntomas, una sola causa: la etapa vivía en DOS sitios (el array canónico
 * `opportunities[]` y el espejo legacy `opportunity`) y cada trozo del sistema
 * escribía o leía uno u otro.
 *
 *  · «Pongo en el flujo "cuando la oportunidad esté en agendado" y no se cumple»
 *    — la condición miraba SOLO la última oportunidad del array.
 *  · «El conteo de personas con oportunidad en agendado está mal» — el embudo
 *    agrupaba por el espejo (una por chat como mucho) y agendar fuera del chat
 *    no movía la etapa a 'agendado'.
 *
 * Ahora el array es la única fuente y todo el mundo pasa por utils/opportunities.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const chatController = require('../controllers/chatController');
const opportunities = require('../utils/opportunities');
const { markScheduled } = require('../utils/opportunityAutoStage');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const stageCount = (payload, stage) => payload.opportunities.find((o) => o._id === stage)?.count || 0;

// ─────────── 1. el embudo cuenta oportunidades, no conversaciones ───────────

test('el embudo cuenta UNA POR OPORTUNIDAD, no una por chat', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Un chat con tres oportunidades en tres etapas distintas.
  await Conversation.create({
    clinic: clinicId, phone: '593980000001',
    opportunities: [
      { isOpportunity: true, stage: 'interesado', expectedValue: 100 },
      { isOpportunity: true, stage: 'agendado', expectedValue: 200 },
      { isOpportunity: true, stage: 'agendado', expectedValue: 300 },
    ],
    opportunity: { isOpportunity: true, stage: 'agendado', expectedValue: 300 },
  });
  // Otro chat con una sola.
  await Conversation.create({
    clinic: clinicId, phone: '593980000002',
    opportunities: [{ isOpportunity: true, stage: 'agendado', expectedValue: 50 }],
    opportunity: { isOpportunity: true, stage: 'agendado', expectedValue: 50 },
  });
  // Y un chat antiguo que solo tiene el espejo legacy.
  await Conversation.create({
    clinic: clinicId, phone: '593980000003',
    opportunity: { isOpportunity: true, stage: 'agendado', expectedValue: 25 },
  });

  const { payload } = await H.runController(chatController.getStats, H.mockReq(clinicId, userId));
  assert.equal(stageCount(payload, 'agendado'), 4, 'las 4 oportunidades agendadas, no 3 chats');
  assert.equal(stageCount(payload, 'interesado'), 1, 'la que no es la última del chat también cuenta');
  const agendado = payload.opportunities.find((o) => o._id === 'agendado');
  assert.equal(agendado.value, 575, 'y el valor esperado suma todas');
});

// ─────────── 2. agendar desde el chat escribe en el array, no solo en el espejo ───────────

test('agendar desde el chat deja la etapa "agendado" en la oportunidad de verdad', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const paciente = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera', phone: '593980000004' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593980000004', patient: paciente._id,
    opportunities: [{ isOpportunity: true, stage: 'interesado', name: 'Botox — Ana' }],
    opportunity: { isOpportunity: true, stage: 'interesado', name: 'Botox — Ana' },
  });

  const servicio = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, name: 'Botox' });
  const d = H.docDate(1);
  const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const { statusCode, payload } = await H.runController(
    chatController.createAppointmentFromChat,
    H.mockReq(
      clinicId, userId,
      { appointments: [{ date: fecha, startTime: '10:00', services: [{ product: String(servicio._id), quantity: 1 }] }] },
      { params: { id: String(conv._id) } }
    )
  );
  assert.equal(statusCode, 201, JSON.stringify(payload));

  const despues = await Conversation.findById(conv._id).lean();
  assert.equal(despues.opportunities[0].stage, 'agendado', 'la oportunidad CANÓNICA se movió');
  assert.ok(despues.opportunities[0].appointment, 'y quedó enlazada a la cita');
  assert.equal(despues.opportunity.stage, 'agendado', 'el espejo va detrás');
  assert.equal(despues.opportunities.length, 1, 'sin duplicar la oportunidad');

  // Y una edición manual posterior YA NO borra el "agendado" (antes el espejo se
  // recalculaba desde un array que nunca se había enterado).
  await H.runController(
    chatController.updateOpportunityAt,
    H.mockReq(clinicId, userId, { notes: 'confirmada por teléfono' }, { params: { id: String(conv._id), idx: '0' } })
  );
  const final = await Conversation.findById(conv._id).lean();
  assert.equal(final.opportunity.stage, 'agendado', 'la etapa sobrevive a la siguiente edición');
  assert.ok(final.opportunity.appointment, 'y el enlace a la cita, también');
});

// ─────────── 3. agendar FUERA del chat también cuenta como agendado ───────────

test('una cita creada desde el calendario mueve la oportunidad del chat a "agendado"', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const paciente = await Patient.create({ clinic: clinicId, firstName: 'Luis', lastName: 'Paz', phone: '593980000005' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593980000005', patient: paciente._id,
    opportunities: [{ isOpportunity: true, stage: 'contactado' }],
    opportunity: { isOpportunity: true, stage: 'contactado' },
  });
  const cita = await Appointment.create({
    clinic: clinicId, patient: paciente._id, date: H.docDate(1), startTime: '09:00', status: 'pendiente',
  });

  const r = await markScheduled({
    clinicId: String(clinicId), patientId: String(paciente._id), appointmentId: String(cita._id),
  });
  assert.equal(r.moved, true);

  const despues = await Conversation.findById(conv._id).lean();
  assert.equal(despues.opportunities[0].stage, 'agendado');
  assert.equal(String(despues.opportunities[0].appointment), String(cita._id));

  const { payload } = await H.runController(chatController.getStats, H.mockReq(clinicId, userId));
  assert.equal(stageCount(payload, 'agendado'), 1, 'y el embudo ya lo cuenta');
});

test('agendar NO inventa oportunidades ni reabre las ya cerradas', async () => {
  const { clinicId } = await H.seedClinic();
  const sinOportunidad = await Patient.create({ clinic: clinicId, firstName: 'Sin', lastName: 'Lead', phone: '593980000006' });
  await Conversation.create({ clinic: clinicId, phone: '593980000006', patient: sinOportunidad._id });
  const cerrada = await Patient.create({ clinic: clinicId, firstName: 'Ya', lastName: 'Compro', phone: '593980000007' });
  const convCerrada = await Conversation.create({
    clinic: clinicId, phone: '593980000007', patient: cerrada._id,
    opportunities: [{ isOpportunity: true, stage: 'ganado' }],
    opportunity: { isOpportunity: true, stage: 'ganado' },
  });

  assert.equal((await markScheduled({ clinicId, patientId: sinOportunidad._id })).moved, false);
  assert.equal((await markScheduled({ clinicId, patientId: cerrada._id })).moved, false);

  const chatSin = await Conversation.findOne({ phone: '593980000006' }).lean();
  assert.deepEqual(chatSin.opportunities, [], 'un paciente de control no entra al embudo');
  const chatCerrado = await Conversation.findById(convCerrada._id).lean();
  assert.equal(chatCerrado.opportunities[0].stage, 'ganado', 'una venta cerrada no retrocede');
});

// ─────────── 4. la bandeja filtra por etapa mirando TODAS las oportunidades ───────────

test('el filtro por etapa de la bandeja encuentra el chat aunque la etapa no sea la última', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Conversation.create({
    clinic: clinicId, phone: '593980000008',
    opportunities: [
      { isOpportunity: true, stage: 'agendado' },
      { isOpportunity: true, stage: 'nuevo' },
    ],
    opportunity: { isOpportunity: true, stage: 'nuevo' },
  });

  const { payload } = await H.runController(
    chatController.listConversations,
    H.mockReq(clinicId, userId, {}, { query: { stage: 'agendado' } })
  );
  assert.equal(payload.length, 1, 'sale en el filtro de "agendado"');

  const otra = await H.runController(
    chatController.listConversations,
    H.mockReq(clinicId, userId, {}, { query: { stage: 'perdido' } })
  );
  assert.equal(otra.payload.length, 0);
});

// ─────────── 5. el escritor único no duplica ni pierde el espejo ───────────

test('applyStage sube al array la oportunidad que solo estaba en el espejo legacy', () => {
  const conv = {
    opportunity: { isOpportunity: true, stage: 'interesado', name: 'Láser', expectedValue: 400 },
    opportunities: [],
    markModified() {},
  };
  const r = opportunities.applyStage(conv, 'agendado');
  assert.equal(r.changed, true);
  assert.equal(r.prevStage, 'interesado');
  assert.equal(conv.opportunities.length, 1, 'no crea una segunda oportunidad');
  assert.equal(conv.opportunities[0].name, 'Láser', 'conserva lo que ya había');
  assert.equal(conv.opportunities[0].stage, 'agendado');
  assert.equal(conv.opportunity.stage, 'agendado', 'y el espejo queda al día');

  // Repetirlo no vuelve a "cambiar" (así no se reinscriben los flujos de más).
  assert.equal(opportunities.applyStage(conv, 'agendado').changed, false);
});
