/**
 * Verificación de compras importadas contra los totales del SRI.
 * Al importar TXT/XML se guarda un snapshot (`sriTotals`); al contabilizar
 * (autorizar), si los valores editados no coinciden, el backend responde 409 con
 * el detalle (SRI vs ingresado vs diferencia) y solo continúa con la aceptación
 * explícita del usuario, que queda marcada en la factura y en el log de auditoría.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const AuditLog = require('../models/AuditLog');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// El comprobante se fecha HOY: el importador ya no acepta comprobantes atrasados
// (utils/fiscalDocumentDate). Antes iba con una fecha fija, que caducaba con el calendario.
const HOY = H.docDate();
const F = `${String(HOY.getDate()).padStart(2, '0')}/${String(HOY.getMonth() + 1).padStart(2, '0')}/${HOY.getFullYear()}`;
const SRI_TXT = [
  'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO',
  `0990004196001\tCORPORACION EL ROSADO S.A.\tFactura\t002-201-000118601\t0106202601099000419600120022010001186010011860110\t${F} 10:03:32\t${F}\t0993404160001\t400\t60\t460\t`,
].join('\n');

async function importOne(clinicId, userId) {
  const imp = await H.runController(purchase.importTxt, H.mockReq(clinicId, userId, { content: SRI_TXT }));
  assert.equal(imp.statusCode, 200, JSON.stringify(imp.payload));
  assert.equal(imp.payload.created, 1);
  return PurchaseInvoice.findOne({ clinic: clinicId });
}

const gastoItems = (accountId, { unitPrice, ivaRate = 15 } = {}) => ([
  { description: 'Compra importada', quantity: 1, unitPrice, subtotal: unitPrice, ivaRate, account: accountId },
]);

// ─────────────────────────────────────────────────────────────────────────────
test('1) el import TXT guarda el snapshot sriTotals del comprobante', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const inv = await importOne(clinicId, userId);
  assert.equal(inv.sriTotals.subtotal, 400);
  assert.equal(inv.sriTotals.iva, 60);
  assert.equal(inv.sriTotals.total, 460);
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) autorizar con valores distintos al SRI → 409 SRI_MISMATCH con el detalle y NO contabiliza', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = await importOne(clinicId, userId);

  // El usuario edita: 553 + IVA 15% (82.95) = 635.95 en vez de 400/60/460 del SRI.
  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId,
    { items: gastoItems(gasto._id, { unitPrice: 553 }) },
    { params: { id: String(inv._id) } }));

  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'SRI_MISMATCH');
  assert.deepEqual(r.payload.sri, { subtotal: 400, iva: 60, total: 460 });
  assert.deepEqual(r.payload.entered, { subtotal: 553, iva: 82.95, total: 635.95 });
  assert.deepEqual(r.payload.diff, { subtotal: 153, iva: 22.95, total: 175.95 });

  // No contabilizó: sigue POR_AUTORIZAR, sin asiento y con el mayor intacto.
  const after = await PurchaseInvoice.findById(inv._id);
  assert.equal(after.status, 'POR_AUTORIZAR');
  assert.equal(after.journalEntry, null);
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.99'), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) confirmar bajo responsabilidad (acceptSriMismatch) contabiliza, marca la factura y audita', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = await importOne(clinicId, userId);

  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId,
    { items: gastoItems(gasto._id, { unitPrice: 553 }), acceptSriMismatch: true },
    { params: { id: String(inv._id) } }));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.status, 'REGISTRADA');
  assert.equal(r.payload.sriMismatchAccepted, true, 'la factura queda marcada');
  assert.ok(r.payload.journalEntry, 'contabilizada');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  // Registro de auditoría con el detalle de la diferencia.
  const log = await AuditLog.findOne({ clinic: clinicId, entity: 'purchase-invoices', entityId: String(inv._id) });
  assert.ok(log, 'debe existir el registro de auditoría');
  assert.match(log.description, /valores distintos al SRI/i);
  assert.equal(log.after.diff.total, 175.95);
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) valores que coinciden con el SRI contabilizan directo (sin confirmación)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = await importOne(clinicId, userId);

  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId,
    { items: gastoItems(gasto._id, { unitPrice: 400 }) }, // 400 + 15% = 460, igual al SRI
    { params: { id: String(inv._id) } }));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.status, 'REGISTRADA');
  assert.equal(r.payload.sriMismatchAccepted, false);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) diferencias de un centavo NO piden confirmación (tolerancia 0.01)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = await importOne(clinicId, userId);
  // Fuerza un SRI con centavo de diferencia respecto a lo que calculará el sistema.
  await PurchaseInvoice.updateOne({ _id: inv._id }, { $set: { 'sriTotals.iva': 60.01, 'sriTotals.total': 460.01 } });

  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId,
    { items: gastoItems(gasto._id, { unitPrice: 400 }) },
    { params: { id: String(inv._id) } }));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.status, 'REGISTRADA');
  assert.equal(r.payload.sriMismatchAccepted, false, 'un centavo no cuenta como diferencia');
});
