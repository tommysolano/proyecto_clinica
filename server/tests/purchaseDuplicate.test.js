/**
 * Bloqueo de doble registro de compras: una misma factura de proveedor no puede
 * registrarse dos veces (p.ej. importada por XML/SRI y luego creada a mano).
 * Identidad: clave de acceso / autorización / proveedor+serie / estab-pto-secuencial.
 * No cuenta ANULADA. En intento duplicado NO se crea asiento ni CxP ni inventario.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const JournalEntry = require('../models/JournalEntry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const gastoLine = (acc, val = 100) => ({ description: 'Gasto', lineType: 'GASTO', account: acc, quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val });

async function createRegistrada(clinicId, userId, sup, { serie, claveAcceso, estab, ptoEmi, secuencial } = {}) {
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  return H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie, claveAcceso, estab, ptoEmi, secuencial,
    items: [gastoLine(gasto._id, 100)],
  }));
}

// ── Helper directo ────────────────────────────────────────────────────────────
test('helper: detecta duplicado por clave; excluye ANULADA; sin falsos positivos', async () => {
  const { clinicId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const otro = await H.makeSupplier(clinicId);
  await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-000000900', claveAcceso: 'CLAVEACCESO0000000000000000000000000000000001',
    estab: '001', ptoEmi: '001', secuencial: '000000900', fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'x', subtotal: 100, quantity: 1, unitPrice: 100, ivaRate: 0 }], subtotal: 100, total: 100, balance: 100, status: 'REGISTRADA',
  });
  const find = (args) => purchase._findDuplicatePurchaseInvoice({ clinicId, ...args });

  assert.ok(await find({ supplier: sup._id, claveAcceso: 'CLAVEACCESO0000000000000000000000000000000001' }), 'por clave de acceso');
  assert.ok(await find({ supplier: sup._id, serie: '001-001-000000900' }), 'por proveedor+serie');
  assert.ok(await find({ supplier: sup._id, estab: '001', ptoEmi: '001', secuencial: '000000900' }), 'por estab-pto-secuencial');
  assert.equal(await find({ supplier: otro._id, serie: '001-001-000000900' }), null, 'proveedor distinto: no es duplicado');
  assert.equal(await find({ supplier: sup._id, serie: '001-001-000000999' }), null, 'secuencial distinto: no es duplicado');

  // Anulada: deja de contar como duplicado.
  await PurchaseInvoice.updateMany({ clinic: clinicId }, { $set: { status: 'ANULADA' } });
  assert.equal(await find({ supplier: sup._id, claveAcceso: 'CLAVEACCESO0000000000000000000000000000000001' }), null, 'ANULADA no bloquea un nuevo registro');
});

// ── Import (POR_AUTORIZAR) + create manual → retorna la existente ──────────────
test('1) XML importado (POR_AUTORIZAR) + create manual del mismo comprobante: retorna la existente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const imported = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-000000123', claveAcceso: 'CLV123',
    fechaEmision: new Date('2026-06-05'), status: 'POR_AUTORIZAR', importedFromXml: true,
    items: [{ description: 'importado', subtotal: 100, quantity: 1, unitPrice: 100, ivaRate: 0 }], subtotal: 100, total: 100, balance: 100,
  });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, serie: '001-001-000000123' }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.duplicate, true);
  assert.equal(String(r.payload._id), String(imported._id), 'devuelve la factura importada pendiente');
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 1, 'no se creó otra');
});

// ── create manual REGISTRADA + intento duplicado → 409, sin asiento nuevo ──────
test('2) create manual y luego duplicado por proveedor+serie: 409 sin asiento nuevo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const first = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000200' });
  assert.equal(first.statusCode, 201, JSON.stringify(first.payload));
  const journalsBefore = await JournalEntry.countDocuments({ clinic: clinicId, source: 'COMPRA' });

  const dup = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000200' });
  assert.equal(dup.statusCode, 409, JSON.stringify(dup.payload));
  assert.match(dup.payload.message, /Ya existe una compra registrada/i);
  assert.ok(dup.payload.existing, 'devuelve referencia a la existente');
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 1, 'no se creó una segunda compra');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'COMPRA' }), journalsBefore, 'no se creó asiento en el intento duplicado');
});

// ── Duplicado por clave de acceso con serie distinta → 409 ────────────────────
test('3) duplicado por clave de acceso (serie distinta): 409', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const first = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000300', claveAcceso: 'CLAVEUNICA300' });
  assert.equal(first.statusCode, 201, JSON.stringify(first.payload));
  const dup = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000999', claveAcceso: 'CLAVEUNICA300' });
  assert.equal(dup.statusCode, 409, JSON.stringify(dup.payload));
});

// ── Autorizar un POR_AUTORIZAR cuyo comprobante ya está REGISTRADO → 409 ───────
test('4) no se puede autorizar un POR_AUTORIZAR duplicado de uno ya registrado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const CLAVE = '0605202601099999999900110010010000004001234567814'; // 49 chars (clave realista)
  const first = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000400', claveAcceso: CLAVE });
  assert.equal(first.statusCode, 201);
  // Un POR_AUTORIZAR con la MISMA clave de acceso pero serie distinta (p.ej. importado aparte).
  const pending = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-000000401', claveAcceso: CLAVE,
    fechaEmision: new Date('2026-06-05'), status: 'POR_AUTORIZAR',
    items: [{ description: 'g', subtotal: 100, quantity: 1, unitPrice: 100, ivaRate: 0, account: gasto._id, lineType: 'GASTO' }], subtotal: 100, total: 100, balance: 100,
  });
  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId, {}, { params: { id: String(pending._id) } }));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.match(r.payload.message, /duplicado/i);
});

// ── ANULADA permite registrar de nuevo (misma clave, serie distinta) ──────────
test('5) tras anular, se permite registrar un nuevo comprobante (misma clave)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  const first = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000500', claveAcceso: 'CLV500' });
  assert.equal(first.statusCode, 201);
  const vd = await H.runController(purchase.void, H.mockReq(clinicId, userId, {}, { params: { id: String(first.payload._id) } }));
  assert.equal(vd.statusCode, 200, JSON.stringify(vd.payload));
  // Nuevo comprobante con la misma clave pero serie distinta: el helper ignora la anulada.
  const again = await createRegistrada(clinicId, userId, sup, { serie: '001-001-000000501', claveAcceso: 'CLV500' });
  assert.equal(again.statusCode, 201, JSON.stringify(again.payload));
});
