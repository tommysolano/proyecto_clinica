const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startDb, stopDb, resetDb, seedClinic, makeSupplier,
  accountBalanceByCode, assertLedgerBalanced, mockReq, runController, mongoose,
} = require('./_integrationHelpers');

const purchaseCtrl = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const RecurringAccount = require('../models/RecurringAccount');
const Supplier = require('../models/Supplier');

// Los importadores rechazan comprobantes con fecha anterior a hoy (utils/fiscalDocumentDate),
// así que el fichero de prueba se fecha HOY en vez de con una fecha fija del calendario.
const F_HOY = (() => {
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
})();

const SRI_TXT = [
  'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO',
  `0990004196001\tCORPORACION EL ROSADO S.A.\tFactura\t002-201-000118601\t0106202601099000419600120022010001186010011860110\t${F_HOY} 10:03:32\t${F_HOY}\t0993404160001\t100\t15\t115\t`,
  `1790283380001\tBANCO DINERS CLUB DEL ECUADOR S.A.\tFactura\t001-014-016216090\t0106202601179028338000120010140162160901621609012\t${F_HOY} 15:37:19\t${F_HOY}\t0993404160001\t16.24\t2.44\t18.68\t`,
].join('\n');

test('flujo compras: import TXT (pendiente) → autorizar (CxP, recurrente) → corregir la factura (el asiento NO se edita)', async (t) => {
  await startDb();
  t.after(stopDb);
  await resetDb();
  const { clinicId, userId } = await seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  assert.ok(gasto, 'cuenta de gasto 6.1.99 debe existir en el plan');

  // 1) Importar TXT: crea proveedores + facturas POR_AUTORIZAR con montos exactos.
  const imp = await runController(purchaseCtrl.importTxt, mockReq(clinicId, userId, { content: SRI_TXT }));
  assert.equal(imp.statusCode, 200);
  assert.equal(imp.payload.created, 2);
  assert.equal(imp.payload.errors.length, 0);

  const invs = await PurchaseInvoice.find({ clinic: clinicId }).sort({ subtotal: -1 });
  assert.equal(invs.length, 2);
  const inv = invs[0]; // la de 100/15/115
  assert.equal(inv.status, 'POR_AUTORIZAR');
  assert.equal(inv.subtotal, 100);
  assert.equal(inv.iva, 15);
  assert.equal(inv.total, 115);
  assert.equal(inv.fechaEmision.getMonth(), new Date().getMonth(), 'el mes del comprobante, no enero');
  assert.ok(await Supplier.findOne({ clinic: clinicId, ruc: '0990004196001' }), 'proveedor guardado');

  // 2) Autorizar asignando la cuenta de gasto: contabiliza, abre CxP y memoriza recurrente.
  const auth = await runController(
    purchaseCtrl.authorize,
    mockReq(clinicId, userId,
      { items: [{ description: inv.items[0].description, quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 15, account: gasto._id }] },
      { params: { id: String(inv._id) } })
  );
  assert.equal(auth.statusCode, 200, JSON.stringify(auth.payload));
  assert.equal(auth.payload.status, 'REGISTRADA');
  assert.ok(auth.payload.journalEntry, 'debe tener asiento');

  // Mayor cuadra; proveedores (CxP) acreditado por el total; gasto debitado por la base.
  const bal = await assertLedgerBalanced(clinicId);
  assert.ok(bal.balanced, `mayor descuadrado: ${bal.debit} != ${bal.credit}`);
  assert.equal(await accountBalanceByCode(clinicId, '2.1.01.01'), -115, 'Proveedores al haber 115');
  assert.equal(await accountBalanceByCode(clinicId, '6.1.99'), 100, 'Gasto al debe 100');

  // CxP abierta (Payable) por el total.
  const Payable = require('../models/Payable');
  const payable = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id });
  assert.ok(payable, 'debe existir documento de CxP');
  assert.equal(payable.balance, 115);

  // Cuenta recurrente memorizada (global y por proveedor).
  const recCount = await RecurringAccount.countDocuments({ clinic: clinicId, account: gasto._id });
  assert.equal(recCount, 2, 'recurrente a nivel clínica y por proveedor');
  const rec = await runController(purchaseCtrl.recurringAccounts, mockReq(clinicId, userId, {}, { query: { supplier: String(inv.supplier) } }));
  assert.ok(rec.payload.accounts.some((a) => String(a._id) === String(gasto._id)), 'sugerencia recurrente presente');
  assert.ok(rec.payload.defaultAccount && String(rec.payload.defaultAccount._id) === String(gasto._id));

  // 3) El asiento NO se edita a mano: ese endpoint ya no existe. Corregir una compra se hace
  //    sobre el DOCUMENTO: al editar la factura se reversa su asiento y se genera uno nuevo.
  assert.equal(typeof purchaseCtrl.editJournal, 'undefined', 'no debe existir edición manual del asiento');

  //    Se reclasifica el gasto en dos líneas (60 + 40) conservando los totales del SRI.
  const prevEntry = String(auth.payload.journalEntry);
  const edit = await runController(
    purchaseCtrl.update,
    mockReq(clinicId, userId, {
      supplier: String(inv.supplier), fechaEmision: inv.fechaEmision,
      items: [
        { description: 'Gasto ajustado', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 60, ivaRate: 15, subtotal: 60 },
        { description: 'Otro gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 40, ivaRate: 15, subtotal: 40 },
      ],
    }, { params: { id: String(inv._id) } })
  );
  assert.equal(edit.statusCode, 200, JSON.stringify(edit.payload));
  assert.notEqual(String(edit.payload.journalEntry?._id || edit.payload.journalEntry), prevEntry, 'el asiento se regenera');
  assert.equal(edit.payload.items.length, 2, 'la factura quedó con las dos líneas');

  const bal2 = await assertLedgerBalanced(clinicId);
  assert.ok(bal2.balanced, 'mayor sigue cuadrado tras editar la factura');
  // Efecto NETO tras reversa + nuevo asiento: proveedores -115 y gasto 100 (60+40).
  assert.equal(await accountBalanceByCode(clinicId, '2.1.01.01'), -115);
  assert.equal(await accountBalanceByCode(clinicId, '6.1.99'), 100);
  // El asiento original queda REVERSADO y visible (auditoría), nunca sobrescrito.
  const JournalEntry = require('../models/JournalEntry');
  assert.equal((await JournalEntry.findById(prevEntry)).isReversed, true, 'el asiento anterior queda reversado');

  // 4) Reimportar el MISMO archivo no duplica: todas se omiten (caso del usuario).
  const reimport = await runController(purchaseCtrl.importTxt, mockReq(clinicId, userId, { content: SRI_TXT }));
  assert.equal(reimport.statusCode, 200);
  assert.equal(reimport.payload.created, 0, 'no debe crear duplicados');
  assert.equal(reimport.payload.skipped, 2, 'las 2 ya estaban registradas');
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 2, 'sigue habiendo solo 2 facturas');
});
