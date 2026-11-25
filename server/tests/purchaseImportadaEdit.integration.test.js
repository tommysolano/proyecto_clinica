/**
 * EDITAR UNA COMPRA IMPORTADA DE CONTÍFICO (nov-2026).
 *
 * Las compras importadas sin asiento propio tienen su compra y su pago en los asientos
 * importados (CTF-…) y no tienen CxP en el sistema. El 24-11-2026 el contador abrió 7 notas
 * de venta pagadas solo para completar la autorización y, al guardar, la edición completa:
 *   · creó OTRO asiento de compra (gasto duplicado), y
 *   · abrió una CxP por el total: compras PAGADAS volvieron a «por pagar».
 *
 * Desde ahora en esas compras solo se guardan los datos del comprobante, y cambiar importes
 * se bloquea. Y en cualquier compra sin CxP previa, la edición conserva lo ya pagado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, resetDb, seedClinic, makeSupplier, mockReq, runController, docDate,
} = require('./_integrationHelpers');

const purchaseCtrl = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');

test.before(async () => { await startDb(); });
test.after(async () => { await stopDb(); });
test.beforeEach(async () => { await resetDb(); });

/** Nota de venta de $50 ya pagada, con la forma que deja la importación de Contífico. */
async function notaImportadaPagada() {
  const { clinicId, userId } = await seedClinic();
  const supplier = await makeSupplier(clinicId, { ruc: '0959391939001', razonSocial: 'DOMENICA PARRALES GANCHOZO' });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const r = await runController(purchaseCtrl.create, mockReq(clinicId, userId, {
    supplier: String(supplier._id), docType: 'NOTA_VENTA', serie: '001-001-000000024', autorizacion: '',
    fechaEmision: docDate(),
    items: [{ description: 'Servicios prestados', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 50, ivaRate: 0, subtotal: 50 }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const id = r.payload._id;
  // Lo que deja la importación: sin asiento propio, sin CxP, pagada.
  await JournalEntry.deleteMany({ sourceRef: id });
  await Payable.deleteMany({ sourceRef: id });
  await PurchaseInvoice.updateOne({ _id: id }, {
    $set: { sourceModel: 'ContificoRecord', journalEntry: null, status: 'PAGADA', paid: true, balance: 0 },
  });
  return { clinicId, userId, supplier, gasto, id };
}

/** Lo que manda el formulario de Compras al guardar sin tocar las líneas. */
async function payloadDelFormulario(id, cambios = {}) {
  const d = JSON.parse(JSON.stringify((await PurchaseInvoice.findById(id)).toObject()));
  return {
    ...d,
    items: d.items.map((it) => ({
      lineType: it.lineType, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice,
      discount: it.discount, ivaRate: it.ivaRate, costCenter: it.costCenter || null, retentions: [],
      account: it.account, accountSplits: [],
    })),
    fechaEmision: new Date(String(d.fechaEmision).slice(0, 10)).toISOString(),
    ...cambios,
  };
}

const editar = (clinicId, userId, id, body) =>
  runController(purchaseCtrl.update, mockReq(clinicId, userId, body, { params: { id: String(id) } }));

test('completar la autorización de una compra importada NO crea asiento ni la deja por pagar', async () => {
  const { clinicId, userId, id } = await notaImportadaPagada();
  const asientosAntes = await JournalEntry.countDocuments({});

  const r = await editar(clinicId, userId, id, await payloadDelFormulario(id, { autorizacion: '1133314874' }));
  assert.equal(r.statusCode || 200, 200, JSON.stringify(r.payload));

  const inv = await PurchaseInvoice.findById(id).lean();
  assert.equal(inv.autorizacion, '1133314874', 'la autorización se guarda');
  assert.equal(inv.status, 'PAGADA', 'sigue pagada');
  assert.equal(inv.balance, 0, 'sin saldo');
  assert.equal(inv.journalEntry, null, 'no se le crea asiento propio');
  assert.equal(await JournalEntry.countDocuments({}), asientosAntes, 'ningún asiento nuevo (sería gasto duplicado)');
  assert.equal(await Payable.countDocuments({ sourceRef: id }), 0, 'no se abre CxP');
});

test('cambiar importes de una compra importada se bloquea con un mensaje claro', async () => {
  const { clinicId, userId, id } = await notaImportadaPagada();
  const body = await payloadDelFormulario(id);
  body.items[0].unitPrice = 80;
  const r = await editar(clinicId, userId, id, body);
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.match(r.payload.message, /Contífico/);
  assert.equal((await PurchaseInvoice.findById(id).lean()).total, 50, 'no cambió nada');
});

test('cambiar el proveedor o la cuenta de una compra importada también se bloquea', async () => {
  const { clinicId, userId, id } = await notaImportadaPagada();
  const otroProv = await makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'OTRO' });
  const r1 = await editar(clinicId, userId, id, await payloadDelFormulario(id, { supplier: String(otroProv._id) }));
  assert.equal(r1.statusCode, 409);

  const otraCuenta = await ChartOfAccount.findOne({ clinic: clinicId, code: { $ne: '6.1.99' }, type: { $in: ['GASTO', 'gasto', 'EXPENSE'] } })
    || await ChartOfAccount.findOne({ clinic: clinicId, code: { $ne: '6.1.99' } });
  const body = await payloadDelFormulario(id);
  body.items[0].account = String(otraCuenta._id);
  const r2 = await editar(clinicId, userId, id, body);
  assert.equal(r2.statusCode, 409);
});

test('una compra con asiento propio pero sin CxP (pagada fuera) conserva lo pagado al editarla', async () => {
  const { clinicId, userId, id } = await notaImportadaPagada();
  // Compra con asiento propio (no es «importada sin asiento») pero sin CxP y ya pagada.
  await PurchaseInvoice.updateOne({ _id: id }, { $set: { sourceModel: null } });
  const r = await editar(clinicId, userId, id, await payloadDelFormulario(id, { autorizacion: '1133314874', notes: 'x' }));
  assert.equal(r.statusCode || 200, 200, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(id).lean();
  assert.equal(inv.status, 'PAGADA', 'no vuelve a «por pagar»');
  assert.equal(inv.balance, 0);
  const cxp = await Payable.findOne({ sourceRef: id }).lean();
  assert.ok(cxp, 'se abre la CxP');
  assert.equal(cxp.applied, cxp.total, 'pero nace saldada');
});
