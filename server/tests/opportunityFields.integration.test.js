/**
 * Oportunidades COMPLETAS (no solo la etapa):
 *  - `name`: nombre propio de la oportunidad (antes solo se distinguían por
 *    "Oportunidad #1, #2…"). Si se deja vacío, el servidor lo genera con los
 *    servicios de interés y el contacto.
 *  - `valueMode`: 'auto' = suma del precio de venta de los servicios (inventario),
 *    'manual' = importe escrito a mano que NO se recalcula.
 *  - Los datos del contacto salen del chat (no se duplican en la oportunidad).
 *  - Paso de workflow `create_opportunity`: crea/actualiza la oportunidad con
 *    todo eso (sustituye a `move_stage`, que solo movía la etapa).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');
const chat = require('../controllers/chatController');
const engine = require('../utils/workflowEngine');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Conversation = require('../models/Conversation');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const seed = async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({
    clinic: clinic._id, firstName: 'Ana', lastName: 'Vera', phone: '0991234567', email: 'ana@mail.com',
  });
  const botox = await Product.create({ clinic: clinic._id, code: `S${Date.now()}`, name: 'Botox', category: 'servicio', salePrice: 300 });
  const laser = await Product.create({ clinic: clinic._id, code: `S${Date.now() + 1}`, name: 'Láser', category: 'servicio', salePrice: 200 });
  const conv = await Conversation.create({
    clinic: clinic._id, phone: '593991234567', channel: 'whatsapp', patient: patient._id, contactName: 'Ana',
  });
  return { clinic, patient, botox, laser, conv, userId: new mongoose.Types.ObjectId() };
};

test('crear oportunidad: nombre propio y valor automático desde el inventario', async () => {
  const { clinic, botox, laser, conv, userId } = await seed();
  const res = await H.runController(
    chat.addOpportunity,
    H.mockReq(clinic._id, userId, {
      name: 'Paquete verano — Ana',
      stage: 'interesado',
      interestedIn: [{ product: botox._id }, { product: laser._id }],
      tags: ['promo'],
    }, { role: 'admin', params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 201);
  const opp = res.payload.opportunities[0];
  assert.equal(opp.name, 'Paquete verano — Ana');
  assert.equal(opp.valueMode, 'auto');
  assert.equal(opp.expectedValue, 500); // 300 + 200 del inventario
  assert.deepEqual(opp.tags, ['promo']);
  // El espejo legacy queda con los mismos datos (lo leen el panel y el embudo).
  assert.equal(res.payload.opportunity.name, 'Paquete verano — Ana');
});

test('sin nombre, se genera uno con los servicios y el contacto', async () => {
  const { clinic, botox, conv, userId } = await seed();
  const res = await H.runController(
    chat.addOpportunity,
    H.mockReq(clinic._id, userId, { stage: 'nuevo', interestedIn: [{ product: botox._id }] },
      { role: 'admin', params: { id: String(conv._id) } })
  );
  assert.equal(res.statusCode, 201);
  // Los nombres de paciente se guardan en MAYÚSCULAS en todo el sistema.
  assert.equal(res.payload.opportunities[0].name, 'Botox — ANA VERA');
});

test('valor MANUAL: se respeta y no lo pisa el inventario al cambiar servicios', async () => {
  const { clinic, botox, laser, conv, userId } = await seed();
  const created = await H.runController(
    chat.addOpportunity,
    H.mockReq(clinic._id, userId, {
      name: 'Presupuesto cerrado',
      stage: 'agendado',
      valueMode: 'manual',
      expectedValue: 450,
      interestedIn: [{ product: botox._id }],
    }, { role: 'admin', params: { id: String(conv._id) } })
  );
  assert.equal(created.payload.opportunities[0].expectedValue, 450, 'manda el importe manual, no los $300 del inventario');

  // Añadir otro servicio NO recalcula el valor mientras siga en manual.
  const updated = await H.runController(
    chat.updateOpportunityAt,
    H.mockReq(clinic._id, userId, { interestedIn: [{ product: botox._id }, { product: laser._id }] },
      { role: 'admin', params: { id: String(conv._id), idx: '0' } })
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.payload.opportunities[0].expectedValue, 450);

  // Al volver a 'auto' se recalcula desde el inventario (300 + 200).
  const back = await H.runController(
    chat.updateOpportunityAt,
    H.mockReq(clinic._id, userId, { valueMode: 'auto' }, { role: 'admin', params: { id: String(conv._id), idx: '0' } })
  );
  assert.equal(back.payload.opportunities[0].expectedValue, 500);
});

test('el listado global devuelve nombre, etiquetas, valor y datos del contacto', async () => {
  const { clinic, botox, conv, userId } = await seed();
  await H.runController(
    chat.addOpportunity,
    H.mockReq(clinic._id, userId, { name: 'Botox Ana', stage: 'nuevo', tags: ['vip'], valueMode: 'manual', expectedValue: 120, interestedIn: [{ product: botox._id }] },
      { role: 'admin', params: { id: String(conv._id) } })
  );
  const res = await H.runController(chat.listAllOpportunities, H.mockReq(clinic._id, userId, {}, { role: 'admin' }));
  assert.equal(res.statusCode, 200);
  const row = res.payload[0];
  assert.equal(row.name, 'Botox Ana');
  assert.equal(row.index, 0);
  assert.equal(row.valueMode, 'manual');
  assert.equal(row.expectedValue, 120);
  assert.deepEqual(row.tags, ['vip']);
  assert.equal(row.email, 'ana@mail.com'); // datos del contacto
  assert.equal(row.phone, '593991234567');
});

// ─────────── Paso de workflow "Crear oportunidad" ───────────

const opportunityWorkflow = (clinicId, data) => Workflow.create({
  clinic: clinicId, name: 'Crear oportunidad', active: true,
  triggers: [{ type: 'inbound_message', audience: 'all' }],
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'inbound_message' }] } },
    { id: 'op', type: 'create_opportunity', position: { x: 0, y: 130 }, data },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'op', sourceHandle: 'default' }],
});

const runNode = async (wf, clinicId, patientId, conversationId) => {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: patientId, conversation: conversationId,
    currentNodeId: 'op', startNodeId: 'trigger', status: 'active', context: {},
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
};

test('el paso "Crear oportunidad" la crea con nombre (con variables), servicios y valor', async () => {
  const { clinic, patient, botox, laser, conv } = await seed();
  const wf = await opportunityWorkflow(clinic._id, {
    opportunityName: 'Interesado en tratamiento — {{nombre}}',
    stage: 'interesado',
    opportunityProducts: [botox._id, laser._id],
    opportunityValueMode: 'auto',
    opportunityTags: ['desde-automatizacion'],
    opportunityNotes: 'Escribió por WhatsApp',
    ifExists: 'update',
  });

  await runNode(wf, clinic._id, patient._id, conv._id);
  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.opportunities.length, 1);
  const opp = fresh.opportunities[0];
  assert.equal(opp.name, 'Interesado en tratamiento — ANA');
  assert.equal(opp.stage, 'interesado');
  assert.equal(opp.expectedValue, 500);
  assert.equal(opp.interestedIn.length, 2);
  assert.deepEqual(opp.tags, ['desde-automatizacion']);
  assert.equal(opp.notes, 'Escribió por WhatsApp');
  // Espejo legacy sincronizado (lo lee el panel del chat y el embudo).
  assert.equal(fresh.opportunity.name, 'Interesado en tratamiento — ANA');
});

test('"Crear oportunidad" con valor manual, y actualiza la existente o crea otra', async () => {
  const { clinic, patient, botox, conv } = await seed();
  const wfUpdate = await opportunityWorkflow(clinic._id, {
    opportunityName: 'Primera',
    stage: 'nuevo',
    opportunityProducts: [botox._id],
    opportunityValueMode: 'manual',
    opportunityValue: 999,
    ifExists: 'update',
  });
  await runNode(wfUpdate, clinic._id, patient._id, conv._id);
  let fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.opportunities[0].expectedValue, 999, 'usa el importe manual, no los $300 del servicio');
  assert.equal(fresh.opportunities[0].valueMode, 'manual');

  // 'update': vuelve a correr y NO duplica, solo actualiza la principal.
  await runNode(wfUpdate, clinic._id, patient._id, conv._id);
  fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.opportunities.length, 1);

  // 'new': añade una segunda oportunidad al mismo chat.
  const wfNew = await opportunityWorkflow(clinic._id, {
    opportunityName: 'Segunda', stage: 'contactado', ifExists: 'new',
  });
  await runNode(wfNew, clinic._id, patient._id, conv._id);
  fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.opportunities.length, 2);
  assert.equal(fresh.opportunities[1].name, 'Segunda');
  assert.equal(fresh.opportunity.name, 'Segunda', 'la principal pasa a ser la última');
});

test('"Crear oportunidad" sin chat asociado: no revienta y deja el motivo en el registro', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Leo', lastName: 'M', phone: '0990000000' });
  const wf = await opportunityWorkflow(clinic._id, { opportunityName: 'X', stage: 'nuevo' });
  const enr = await runNode(wf, clinic._id, patient._id, null);
  assert.equal(enr.status, 'done');
  assert.ok((enr.log || []).some((l) => l.type === 'create_opportunity' && l.ok === false));
});
