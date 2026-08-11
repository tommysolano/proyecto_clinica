/**
 * CORREGIR una compra ya contabilizada.
 *
 * El contador necesita poder arreglar una compra mal digitada (proveedor, cantidad,
 * cuenta) aunque ya esté pagada. Antes solo se dejaba editar en estado REGISTRADA:
 * en cuanto se abonaba, la factura quedaba congelada con el error dentro.
 *
 * El único candado que se mantiene es el COMPROBANTE DE RETENCIÓN emitido: es un
 * documento fiscal declarado al SRI y entregado al proveedor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, resetDb, seedClinic, makeSupplier,
  assertLedgerBalanced, mockReq, runController, docDate,
} = require('./_integrationHelpers');

const purchaseCtrl = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');

test.before(async () => { await startDb(); });
test.after(async () => { await stopDb(); });
test.beforeEach(async () => { await resetDb(); });

/** Compra contabilizada de 100 + 15 % de IVA = 115. */
async function compraDe115() {
  const { clinicId, userId } = await seedClinic();
  const supplier = await makeSupplier(clinicId, { ruc: '0990004196001', razonSocial: 'PROVEEDOR SA' });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });

  const r = await runController(
    purchaseCtrl.create,
    mockReq(clinicId, userId, {
      supplier: String(supplier._id),
      serie: '001-001-000000123',
      fechaEmision: docDate(),
      items: [{
        description: 'Suministros', lineType: 'GASTO', account: gasto._id,
        quantity: 1, unitPrice: 100, ivaRate: 15, subtotal: 100,
      }],
    })
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return { clinicId, userId, supplier, gasto, inv: r.payload };
}

const editar = (clinicId, userId, invId, body) =>
  runController(purchaseCtrl.update, mockReq(clinicId, userId, body, { params: { id: String(invId) } }));

// ─────────────────────────────────────────────────────────────────────────────
test('una compra PAGADA se puede corregir y conserva lo abonado', async () => {
  const { clinicId, userId, supplier, gasto, inv } = await compraDe115();

  // Se paga completa (como lo deja el cobro/pago: saldo 0 en la factura y
  // `applied` en la CxP del subledger).
  await PurchaseInvoice.updateOne({ _id: inv._id }, { balance: 0, paid: true, status: 'PAGADA' });
  await Payable.updateOne(
    { clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id },
    { applied: 115 }
  );

  // Se corrige la cantidad: 2 unidades de 100 → 200 + 30 de IVA = 230.
  const r = await editar(clinicId, userId, inv._id, {
    supplier: String(supplier._id),
    fechaEmision: inv.fechaEmision,
    items: [{
      description: 'Suministros', lineType: 'GASTO', account: gasto._id,
      quantity: 2, unitPrice: 100, ivaRate: 15, subtotal: 200,
    }],
  });

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 230);
  // Lo ya abonado NO se pierde: quedan 115 pendientes, no los 230 completos.
  assert.equal(r.payload.balance, 115, 'el saldo descuenta lo que ya se había pagado');
  assert.equal(r.payload.paid, false);
  assert.equal(r.payload.status, 'REGISTRADA', 'vuelve a estar pendiente porque ahora debe más');

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id });
  assert.equal(cxp.total, 230, 'la CxP se refresca con el total nuevo');
  assert.equal(cxp.applied, 115, 'sin tocar lo aplicado');
  assert.equal(cxp.balance, 115);

  const bal = await assertLedgerBalanced(clinicId);
  assert.ok(bal.balanced, 'el mayor sigue cuadrado tras la corrección');
});

test('corregir a la baja una compra pagada la deja saldada (no con saldo a favor)', async () => {
  const { clinicId, userId, supplier, gasto, inv } = await compraDe115();
  await PurchaseInvoice.updateOne({ _id: inv._id }, { balance: 0, paid: true, status: 'PAGADA' });
  await Payable.updateOne(
    { clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id },
    { applied: 115 }
  );

  const r = await editar(clinicId, userId, inv._id, {
    supplier: String(supplier._id),
    fechaEmision: inv.fechaEmision,
    items: [{
      description: 'Suministros', lineType: 'GASTO', account: gasto._id,
      quantity: 1, unitPrice: 50, ivaRate: 15, subtotal: 50,
    }],
  });

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 57.5);
  assert.equal(r.payload.balance, 0, 'nunca queda saldo negativo');
  assert.equal(r.payload.paid, true);
  assert.equal(r.payload.status, 'PAGADA');
});

test('una compra con comprobante de retención emitido NO se puede modificar', async () => {
  const { clinicId, userId, supplier, gasto, inv } = await compraDe115();
  await PurchaseInvoice.updateOne({ _id: inv._id }, { retentionNumber: '001-001-000000045' });

  const r = await editar(clinicId, userId, inv._id, {
    supplier: String(supplier._id),
    fechaEmision: inv.fechaEmision,
    items: [{ description: 'Otro', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 999, ivaRate: 15, subtotal: 999 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /comprobante de retenci/i);
  assert.match(r.payload.message, /001-001-000000045/);
  const sinTocar = await PurchaseInvoice.findById(inv._id);
  assert.equal(sinTocar.total, 115, 'la factura no cambió');
});

test('una compra ANULADA no se puede modificar', async () => {
  const { clinicId, userId, supplier, gasto, inv } = await compraDe115();
  await PurchaseInvoice.updateOne({ _id: inv._id }, { status: 'ANULADA' });

  const r = await editar(clinicId, userId, inv._id, {
    supplier: String(supplier._id),
    fechaEmision: inv.fechaEmision,
    items: [{ description: 'X', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 10, ivaRate: 15, subtotal: 10 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /anulada/i);
});

test('el n° de autorización del SRI se guarda tal cual', async () => {
  const { clinicId, userId } = await seedClinic();
  const supplier = await makeSupplier(clinicId, { ruc: '1790283380001', razonSocial: 'OTRO PROVEEDOR' });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const clave = '0106202601099000419600120022010001186010011860110';

  const r = await runController(
    purchaseCtrl.create,
    mockReq(clinicId, userId, {
      supplier: String(supplier._id),
      serie: '001-001-000000900',
      autorizacion: clave,
      fechaEmision: docDate(),
      items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 10, ivaRate: 0, subtotal: 10 }],
    })
  );

  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await PurchaseInvoice.findById(r.payload._id)).autorizacion, clave);
});
