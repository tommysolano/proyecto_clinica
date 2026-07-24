/**
 * REFRESCO EN VIVO DE BORRADORES 103/104 (GET recalcula el DRAFT).
 *
 * Corrige el bug de producción: los borradores mostraban snapshots RANCIOS porque
 * GET /tax-declarations/:id servía lo persistido sin recalcular, y quedaban guardados
 * antes de la última edición de las compras del período. Ahora:
 *   a) GET de un DRAFT recalcula con los datos actuales y sella la definitionVersion vigente,
 *      sin pulsar "Recalcular";
 *   b) GET de una FINALIZED nunca recalcula: snapshot y definitionVersion congelados;
 *   c) si el recálculo falla, se responde el snapshot guardado + aviso (sin 500).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const decls = require('../controllers/taxDeclarationController');
const SriDeclaration = require('../models/SriDeclaration');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Invoice = require('../models/Invoice');
const FiscalPeriod = require('../models/FiscalPeriod');
const { getDefinition } = require('../utils/sriForms/definitions');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = 2026;
const MONTH = 5;
const inMonth = (day = 15) => new Date(YEAR, MONTH - 1, day, 12, 0, 0);
const run = (handler, req) => H.runController(handler, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

let seq = 0;
async function makePurchase(clinicId, supplierId, { subtotal = 100, iva = 15, day = 10 } = {}) {
  seq += 1;
  return PurchaseInvoice.create({
    clinic: clinicId, supplier: supplierId, docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision: inMonth(day),
    subtotal, subtotal15: subtotal, iva, total: subtotal + iva,
    deductible: true, vatCreditAmount: iva, status: 'REGISTRADA', items: [],
  });
}

const draft = async (clinicId, userId, formType) =>
  ok(await run(decls.draft, H.mockReq(clinicId, userId, { formType, year: YEAR, month: MONTH })));
const get = (clinicId, userId, id) =>
  run(decls.get, H.mockReq(clinicId, userId, {}, { params: { id: String(id) } }));

// ─────────────────────────────────────────────────────────────────────────────
test('a) GET de un DRAFT 104 recalcula con la compra editada y sella la definitionVersion vigente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  const p = await makePurchase(clinicId, sup._id, { subtotal: 100, iva: 15 });

  const d = await draft(clinicId, userId, '104');
  assert.equal(d.cells['530'], 15, 'el borrador ve la compra inicial (IVA disponible 15)');

  // Simula que el borrador quedó etiquetado con una definición VIEJA (como en prod).
  await SriDeclaration.updateOne({ _id: d.declaration._id }, { $set: { definitionVersion: '104-borrador-2026.1' } });
  // La contadora EDITA la compra DESPUÉS de haber guardado el borrador.
  await PurchaseInvoice.updateOne({ _id: p._id }, { $set: { subtotal: 400, subtotal15: 400, iva: 60, total: 460, vatCreditAmount: 60 } });

  // Solo abrir el borrador (GET) ya lo recalcula, sin pulsar "Recalcular".
  const r = ok(await get(clinicId, userId, d.declaration._id));
  assert.equal(r.cells['530'], 60, 'GET recalculó: IVA disponible ahora 60');
  assert.equal(r.cells['500'], 400, 'compras gravadas con derecho = 400 (monto nuevo)');
  assert.equal(r.declaration.definitionVersion, getDefinition('104').definitionVersion, 'definitionVersion viva');
  assert.notEqual(r.declaration.definitionVersion, '104-borrador-2026.1');
  assert.ok(!r.recomputeStale, 'sin aviso de rancio: el recálculo funcionó');

  // Persistido: el snapshot quedó actualizado en la base (no solo en la respuesta).
  const saved = await SriDeclaration.findById(d.declaration._id);
  assert.equal(saved.cellMap()['530'], 60);
  assert.equal(saved.definitionVersion, getDefinition('104').definitionVersion);
});

// ─────────────────────────────────────────────────────────────────────────────
test('a2) GET de un DRAFT 103 refleja la compra editada del período (casillero 332)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  const p = await makePurchase(clinicId, sup._id, { subtotal: 375, iva: 56.25 });

  const d = await draft(clinicId, userId, '103');
  assert.equal(d.cells['332'], 375, 'no sujetos a retención = base neta no retenida');

  await PurchaseInvoice.updateOne({ _id: p._id }, { $set: { subtotal: 500, subtotal15: 500, iva: 75, total: 575 } });
  const r = ok(await get(clinicId, userId, d.declaration._id));
  assert.equal(r.cells['332'], 500, 'GET recalculó el 332 con el monto nuevo');
});

// ─────────────────────────────────────────────────────────────────────────────
test('b) GET de una FINALIZED NO recalcula: snapshot y definitionVersion congelados', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  const p = await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const d = await draft(clinicId, userId, '104');
  const fin = ok(await run(decls.finalize, H.mockReq(clinicId, userId, {}, { params: { id: String(d.declaration._id) } })));
  assert.equal(fin.declaration.status, 'FINALIZED');
  assert.equal(fin.cells['530'], 60, 'la finalizada declaró 60 de IVA disponible');

  // Marca la definición congelada con un sello distintivo y edita una compra del período.
  await SriDeclaration.updateOne({ _id: fin.declaration._id }, { $set: { definitionVersion: '104-CONGELADA-TEST' } });
  await PurchaseInvoice.updateOne({ _id: p._id }, { $set: { subtotal: 999, subtotal15: 999, iva: 149.85, vatCreditAmount: 149.85 } });

  const r = ok(await get(clinicId, userId, fin.declaration._id));
  assert.equal(r.declaration.status, 'FINALIZED');
  assert.equal(r.cells['530'], 60, 'el snapshot NO cambió pese a editar la compra');
  assert.equal(r.declaration.definitionVersion, '104-CONGELADA-TEST', 'la definición congelada se conserva');
  assert.ok(!r.recomputeStale, 'una finalizada no intenta recalcular, no marca aviso');
});

// ─────────────────────────────────────────────────────────────────────────────
test('c) si el recálculo del DRAFT falla, GET responde el snapshot guardado + aviso (sin 500)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const d = await draft(clinicId, userId, '104');
  const cellsAntes = d.cells['530'];

  // Fuerza un fallo de datos en el recálculo: compute104 consulta Invoice.find primero.
  const originalFind = Invoice.find;
  Invoice.find = () => { throw new Error('fallo simulado de datos'); };
  try {
    const r = await get(clinicId, userId, d.declaration._id);
    assert.equal(r.statusCode, 200, 'no revienta con 500: la pantalla no se rompe');
    assert.equal(r.payload.recomputeStale, true, 'marca que no se pudo actualizar');
    assert.match(r.payload.recomputeMessage || '', /último cálculo guardado/i);
    assert.equal(r.payload.cells['530'], cellsAntes, 'sirve el último snapshot guardado');
  } finally {
    Invoice.find = originalFind;
  }

  // Tras restaurar, un GET normal vuelve a recalcular sin aviso.
  const r2 = ok(await get(clinicId, userId, d.declaration._id));
  assert.ok(!r2.recomputeStale);
  assert.equal(r2.cells['530'], 60);

  // Sanity: la BD sigue teniendo una sola declaración coherente.
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1);
  assert.ok(await FiscalPeriod.findOne({ clinic: clinicId }), 'el período existe (seed)');
});
