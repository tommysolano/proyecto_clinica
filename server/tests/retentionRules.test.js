/**
 * Catálogo de reglas de retención: CRUD, validaciones y seed idempotente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/retentionRuleController');
const RetentionRule = require('../models/RetentionRule');
const ChartOfAccount = require('../models/ChartOfAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const setup = async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.02.04' });
  return { clinicId, userId, acc };
};

test('crea una regla válida', async () => {
  const { clinicId, userId, acc } = await setup();
  const r = await H.runController(ctrl.create, H.mockReq(clinicId, userId, {
    type: 'RENTA', code: '312', description: 'Bienes', rate: 1.75, appliesTo: 'BIENES', baseType: 'SUBTOTAL_TOTAL', payableAccount: String(acc._id),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.code, '312');
  assert.equal(r.payload.rate, 1.75);
  assert.equal(String(r.payload.payableAccount), String(acc._id));
});

test('rechaza campos inválidos (código faltante, rate fuera de rango)', async () => {
  const { clinicId, userId } = await setup();
  const noCode = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', rate: 2, baseType: 'SUBTOTAL_TOTAL' }));
  assert.equal(noCode.statusCode, 400);
  assert.match(noCode.payload.message, /código/i);
  const badRate = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '999', rate: 150, baseType: 'SUBTOTAL_TOTAL' }));
  assert.equal(badRate.statusCode, 400);
  assert.match(badRate.payload.message, /0 y 100/);
});

test('edita una regla (rate y descripción)', async () => {
  const { clinicId, userId } = await setup();
  const rule = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '303', rate: 8, baseType: 'SUBTOTAL_TOTAL' });
  const r = await H.runController(ctrl.update, H.mockReq(clinicId, userId, { rate: 10, description: 'Honorarios' }, { params: { id: String(rule._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.rate, 10);
  assert.equal(r.payload.description, 'Honorarios');
});

test('activa / desactiva una regla', async () => {
  const { clinicId, userId } = await setup();
  const rule = await RetentionRule.create({ clinic: clinicId, type: 'IVA', code: '721', rate: 30, baseType: 'IVA', active: true });
  const off = await H.runController(ctrl.toggle, H.mockReq(clinicId, userId, {}, { params: { id: String(rule._id) } }));
  assert.equal(off.statusCode, 200);
  assert.equal(off.payload.active, false);
  const on = await H.runController(ctrl.toggle, H.mockReq(clinicId, userId, { active: true }, { params: { id: String(rule._id) } }));
  assert.equal(on.payload.active, true);
});

test('rechaza cuenta por pagar de otra clínica', async () => {
  const { clinicId, userId } = await setup();
  const foreign = await ChartOfAccount.create({ clinic: new H.mongoose.Types.ObjectId(), code: '2.1.02.04', name: 'x', type: 'PASIVO', nature: 'CREDITO', allowsMovement: true });
  const r = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL', payableAccount: String(foreign._id) }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /cuenta de retención/i);
});

test('seed idempotente: segunda vez no crea duplicados', async () => {
  const { clinicId, userId } = await setup();
  const first = await H.runController(ctrl.seed, H.mockReq(clinicId, userId, {}));
  assert.equal(first.statusCode, 200);
  assert.ok(first.payload.created > 0);
  const second = await H.runController(ctrl.seed, H.mockReq(clinicId, userId, {}));
  assert.equal(second.payload.created, 0, 'no vuelve a crear');
  assert.equal(second.payload.existing, first.payload.created);
});

test('list auto-siembra el catálogo cuando la clínica no tiene ninguna regla', async () => {
  const { clinicId, userId } = await setup();
  assert.equal(await RetentionRule.countDocuments({ clinic: clinicId }), 0, 'arranca sin reglas');
  const r = await H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { query: { active: 'true' } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok(r.payload.length > 0, 'devuelve reglas reales sembradas');
  // Trae códigos concretos seleccionables de ambos tipos (no solo "Renta"/"IVA").
  assert.ok(r.payload.some((x) => x.type === 'RENTA' && x.code && x.rate >= 0));
  assert.ok(r.payload.some((x) => x.type === 'IVA' && x.code && x.rate >= 0));
});

test('no permite dos reglas ACTIVAS del mismo tipo+código con vigencia solapada', async () => {
  const { clinicId, userId } = await setup();
  const a = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 1.75, baseType: 'SUBTOTAL_TOTAL', validFrom: '2024-01-01', validTo: '2024-12-31' }));
  assert.equal(a.statusCode, 201, JSON.stringify(a.payload));
  // Solapada (2024) → falla.
  const overlap = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL', validFrom: '2024-06-01', validTo: '2025-06-30' }));
  assert.equal(overlap.statusCode, 400, JSON.stringify(overlap.payload));
  assert.match(overlap.payload.message, /solapada/i);
  // No solapada (histórico 2025+) → permitida.
  const ok = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL', validFrom: '2025-01-01' }));
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
});

test('permite duplicar código si una está INACTIVA', async () => {
  const { clinicId, userId } = await setup();
  await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '312', rate: 1.75, baseType: 'SUBTOTAL_TOTAL', active: false });
  const r = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL', active: true }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
});

test('regla SIN cuenta puede crearse (contabiliza luego por cuenta de rol)', async () => {
  const { clinicId, userId } = await setup();
  const r = await H.runController(ctrl.create, H.mockReq(clinicId, userId, { type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL' }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.payableAccount, null);
});

test('list filtra por tipo y estado', async () => {
  const { clinicId, userId } = await setup();
  await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '312', rate: 2, baseType: 'SUBTOTAL_TOTAL', active: true });
  await RetentionRule.create({ clinic: clinicId, type: 'IVA', code: '721', rate: 30, baseType: 'IVA', active: false });
  const renta = await H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { query: { type: 'RENTA' } }));
  assert.equal(renta.payload.length, 1);
  assert.equal(renta.payload[0].type, 'RENTA');
  const activas = await H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { query: { active: 'true' } }));
  assert.equal(activas.payload.length, 1);
  assert.equal(activas.payload[0].active, true);
});
