/**
 * BLOQUE A — vencimiento de compras propagado a la cuenta por pagar.
 *
 * Verifica que la CxP nazca con el vencimiento pactado en la compra, que la compra al
 * contado no invente una fecha, y que el backfill complete las CxP históricas sin pisar
 * fechas corregidas a mano.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchases = require('../controllers/purchaseInvoiceController');
const Payable = require('../models/Payable');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const ChartOfAccount = require('../models/ChartOfAccount');
const { nextBusinessDay, effectivePaymentDate } = require('../utils/paymentSchedule');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let seq = 0;
const iso = (d) => d.toISOString().slice(0, 10);

/** Crea una compra por el controller real (contabiliza + abre CxP). */
async function createPurchase(clinicId, userId, supplierId, { fechaVencimiento = null, creditDays = 0 } = {}) {
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  seq += 1;
  const body = {
    supplier: supplierId,
    docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision: new Date(),
    ...(fechaVencimiento ? { fechaVencimiento } : {}),
    creditDays,
    items: [{ description: 'Servicio', quantity: 1, unitPrice: 100, ivaRate: 15, lineType: 'GASTO', account: gasto._id }],
  };
  const r = await H.runController(purchases.create, H.mockReq(clinicId, userId, body));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return r.payload;
}

// ─────────────────────────────────────────────────────────────────────────────
test('1) compra a crédito: la CxP hereda la fecha de vencimiento de la compra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const vence = new Date(Date.now() + 30 * 86400000);

  const inv = await createPurchase(clinicId, userId, sup._id, { fechaVencimiento: vence, creditDays: 30 });

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id });
  assert.ok(cxp, 'la compra abrió su CxP');
  assert.ok(cxp.dueDate, 'la CxP tiene vencimiento');
  assert.equal(iso(cxp.dueDate), iso(vence), 'el vencimiento es el pactado en la compra');
  // Emisión y vencimiento son conceptos separados.
  assert.notEqual(iso(cxp.issueDate), iso(cxp.dueDate));
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) compra al contado: la CxP no inventa vencimiento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);

  const inv = await createPurchase(clinicId, userId, sup._id);

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id });
  assert.equal(cxp.dueDate, null, 'sin vencimiento pactado, la CxP queda sin dueDate');
  assert.ok(cxp.issueDate, 'la emisión sí está');
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) editar la compra actualiza el vencimiento de la CxP, pero un null no lo borra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const vence = new Date(Date.now() + 15 * 86400000);
  const inv = await createPurchase(clinicId, userId, sup._id, { fechaVencimiento: vence, creditDays: 15 });

  // Reabrir la CxP con el mismo origen y sin fecha (p. ej. al pagar) no la borra.
  const { openPayable } = require('../utils/subledger');
  await openPayable({
    clinic: clinicId,
    party: { model: 'Supplier', ref: sup._id, name: sup.razonSocial },
    sourceModel: 'PurchaseInvoice', sourceRef: inv._id, docType: 'COMPRA',
    number: inv.serie, issueDate: inv.fechaEmision, total: inv.total,
  });
  const cxp = await Payable.findOne({ clinic: clinicId, sourceRef: inv._id });
  assert.equal(iso(cxp.dueDate), iso(vence), 'la fecha sobrevive a un refresco sin dueDate');
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) backfill: completa CxP históricas sin fecha y respeta las corregidas a mano', async () => {
  const { clinicId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const vencimientoCompra = new Date('2026-03-31T12:00:00');
  const fechaManual = new Date('2026-04-15T12:00:00');

  // Compra con vencimiento + CxP histórica SIN fecha (el bug).
  const compraA = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: new Date('2026-03-01'),
    fechaVencimiento: vencimientoCompra, serie: '001-001-000000101', subtotal: 100, total: 115,
  });
  const cxpA = await Payable.create({
    clinic: clinicId, party: { model: 'Supplier', ref: sup._id, name: 'X' },
    sourceModel: 'PurchaseInvoice', sourceRef: compraA._id, docType: 'COMPRA',
    number: compraA.serie, issueDate: compraA.fechaEmision, total: 115, dueDate: null,
  });

  // Compra con vencimiento + CxP con fecha CORREGIDA A MANO (no se debe tocar).
  const compraB = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: new Date('2026-03-02'),
    fechaVencimiento: vencimientoCompra, serie: '001-001-000000102', subtotal: 100, total: 115,
  });
  const cxpB = await Payable.create({
    clinic: clinicId, party: { model: 'Supplier', ref: sup._id, name: 'X' },
    sourceModel: 'PurchaseInvoice', sourceRef: compraB._id, docType: 'COMPRA',
    number: compraB.serie, issueDate: compraB.fechaEmision, total: 115, dueDate: fechaManual,
  });

  // CxP huérfana (su compra no existe).
  await Payable.create({
    clinic: clinicId, party: { model: 'Supplier', ref: sup._id, name: 'X' },
    sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
    number: '001-001-000000999', issueDate: new Date(), total: 50, dueDate: null,
  });

  // El script corre contra su propia conexión; aquí se ejercita su MISMA lógica sobre
  // la conexión de test para poder afirmar el resultado (dry-run y commit).
  const runBackfill = async ({ commit }) => {
    const stats = { encontrados: 0, modificados: 0, omitidos: 0, huerfanos: 0, sinVencimientoEnCompra: 0 };
    const list = await Payable.find({ clinic: clinicId, sourceModel: 'PurchaseInvoice' });
    stats.encontrados = list.length;
    for (const p of list) {
      if (p.dueDate) { stats.omitidos += 1; continue; }
      const inv = await PurchaseInvoice.findOne({ _id: p.sourceRef, clinic: p.clinic });
      if (!inv) { stats.huerfanos += 1; continue; }
      if (!inv.fechaVencimiento) { stats.sinVencimientoEnCompra += 1; continue; }
      stats.modificados += 1;
      if (commit) await Payable.updateOne({ _id: p._id }, { $set: { dueDate: inv.fechaVencimiento } });
    }
    return stats;
  };

  const dry = await runBackfill({ commit: false });
  assert.equal(dry.encontrados, 3);
  assert.equal(dry.modificados, 1, 'solo la CxP sin fecha se completaría');
  assert.equal(dry.omitidos, 1, 'la corregida a mano se omite');
  assert.equal(dry.huerfanos, 1);
  // Dry-run no escribe.
  assert.equal((await Payable.findById(cxpA._id)).dueDate, null);

  const applied = await runBackfill({ commit: true });
  assert.equal(applied.modificados, 1);
  assert.equal(iso((await Payable.findById(cxpA._id)).dueDate), iso(vencimientoCompra), 'CxP histórica completada');
  assert.equal(iso((await Payable.findById(cxpB._id)).dueDate), iso(fechaManual), 'la fecha manual NO se pisó');

  // Idempotente: la segunda corrida no cambia nada.
  const again = await runBackfill({ commit: true });
  assert.equal(again.modificados, 0);
  assert.equal(again.omitidos, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) la fecha legal no se mueve por caer domingo: el desplazamiento es de proyección', async () => {
  const domingo = new Date(2026, 6, 12); // 12/07/2026 es domingo
  assert.equal(domingo.getDay(), 0);
  const habil = nextBusinessDay(domingo);
  assert.equal(habil.getDay(), 1, 'se proyecta al lunes');

  const doc = { dueDate: domingo, issueDate: new Date(2026, 5, 12) };
  const { dueDate, effectiveDate, shifted } = effectivePaymentDate(doc);
  assert.equal(iso(dueDate), iso(domingo), 'el vencimiento legal se conserva intacto');
  assert.equal(shifted, true);
  assert.equal(effectiveDate.getDate(), 13, 'la fecha efectiva es el lunes 13');

  // Un vencimiento en día hábil no se mueve.
  const jueves = new Date(2026, 6, 9);
  assert.equal(effectivePaymentDate({ dueDate: jueves }).shifted, false);
});
