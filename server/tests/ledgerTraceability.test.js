/**
 * Trazabilidad del Libro Mayor (Punto 5): cada movimiento del mayor debe traer los
 * datos necesarios para abrir su asiento y su documento origen, y los asientos
 * ANTIGUOS sin origen no deben romper el endpoint.
 *
 * Verifica:
 *   - una COMPRA produce un asiento con source/sourceModel/sourceRef y el endpoint
 *     `ledger` expone entryId + sourceModel='PurchaseInvoice' + sourceRef en la fila;
 *   - un asiento MANUAL sin origen aparece en el mayor con sourceModel null y el
 *     endpoint responde 200 (no se rompe por datos viejos).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const je = require('../controllers/journalEntryController');
const { createEntry } = require('../utils/accounting');

const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function accId(clinicId, code) {
  const a = await ChartOfAccount.findOne({ clinic: clinicId, code });
  return a?._id;
}

// ── Compra → asiento con origen → el mayor expone cómo abrir el documento ───────
test('el mayor devuelve entryId/sourceModel/sourceRef para navegar al documento origen', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const invAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  const invCat = await InventoryCategory.create({ clinic: clinicId, code: 'INV', name: 'Insumos', kind: 'INVENTARIO', assetAccount: invAcc._id });
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });

  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100 }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const purchaseId = String(r.payload._id);

  const led = await H.runController(je.ledger, H.mockReq(clinicId, userId, {}, {
    query: { account: String(invAcc._id), startDate: '2026-06-01', endDate: '2026-06-30' },
  }));
  assert.equal(led.statusCode, 200, JSON.stringify(led.payload));
  const row = (led.payload.rows || []).find((x) => x.debit === 100);
  assert.ok(row, 'hay una fila de inventario debitada por la compra');
  assert.ok(row.entryId, 'la fila trae entryId para abrir el asiento');
  assert.equal(row.sourceModel, 'PurchaseInvoice', 'la fila identifica el documento origen');
  assert.equal(String(row.sourceRef), purchaseId, 'sourceRef apunta a la factura de compra');
  assert.equal(row.source, 'COMPRA');
});

// ── Asiento MANUAL sin origen: el mayor no se rompe y lo marca sin documento ────
test('un asiento manual sin origen aparece en el mayor sin sourceModel y no rompe', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const debitAcc = await accId(clinicId, '1.1.04.01');
  const creditAcc = await accId(clinicId, '2.1.01.01');

  await createEntry({
    clinicId, date: new Date('2026-06-10'), description: 'Ajuste manual sin documento',
    lines: [
      { account: debitAcc, debit: 50, credit: 0 },
      { account: creditAcc, debit: 0, credit: 50 },
    ],
    userId,
  });

  const led = await H.runController(je.ledger, H.mockReq(clinicId, userId, {}, {
    query: { account: String(debitAcc), startDate: '2026-06-01', endDate: '2026-06-30' },
  }));
  assert.equal(led.statusCode, 200, JSON.stringify(led.payload));
  const row = (led.payload.rows || []).find((x) => x.debit === 50);
  assert.ok(row, 'la fila del ajuste manual está en el mayor');
  assert.equal(row.sourceModel, null, 'sin documento origen enlazado');
  assert.equal(row.source, 'MANUAL');
  assert.ok(row.entryId, 'aun así se puede abrir el asiento');
});
