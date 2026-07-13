/**
 * BLOQUES B–E — declaraciones SRI persistentes (Formularios 103 y 104).
 *
 * Verifica el ciclo completo sobre los controllers reales: borrador sin efectos
 * contables, finalización idempotente y balanceada, IVA no deducible al gasto,
 * obligación con el SRI sin mover Banco, crédito tributario sin deuda ficticia,
 * sustitutiva que conserva la versión anterior, conciliación del 103 con compras y
 * nómina, período cerrado y aislamiento entre clínicas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const decls = require('../controllers/taxDeclarationController');
const SriDeclaration = require('../models/SriDeclaration');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payroll = require('../models/Payroll');
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');
const FiscalPeriod = require('../models/FiscalPeriod');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = 2026;
const MONTH = 5;
const inMonth = (day = 15) => new Date(YEAR, MONTH - 1, day, 12, 0, 0);
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

let seq = 0;

/** Venta autorizada con desglose por tarifa. */
async function makeSale(clinicId, { baseGravada = 0, base0 = 0, iva = 0, day = 15 } = {}) {
  seq += 1;
  return Invoice.create({
    clinic: clinicId,
    claveAcceso: `CLV${Date.now()}${seq}${Math.floor(Math.random() * 1e6)}`,
    secuencial: String(seq).padStart(9, '0'),
    estab: '001', ptoEmi: '001', ambiente: '1',
    fechaEmision: dmy(inMonth(day)),
    estado: 'AUTORIZADO',
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: baseGravada + base0, totalImpuesto: iva, importeTotal: baseGravada + base0 + iva,
    taxBreakdown: { computed: true, base0, baseGravada, baseExento: 0, baseNoObjeto: 0, iva },
  });
}

/** Compra registrada (los importes se fijan directo: aquí interesa la declaración). */
async function makePurchase(clinicId, supplierId, {
  subtotal = 100, iva = 15, deductible = true, vatCreditAmount, retentions = [], day = 10,
} = {}) {
  seq += 1;
  const retentionTotal = retentions.reduce((s, r) => s + (r.amount || 0), 0);
  return PurchaseInvoice.create({
    clinic: clinicId, supplier: supplierId, docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision: inMonth(day),
    subtotal, subtotal15: subtotal, iva, total: subtotal + iva,
    deductible,
    vatCreditAmount: vatCreditAmount != null ? vatCreditAmount : (deductible === false ? 0 : iva),
    vatNonCreditAmount: deductible === false ? iva : 0,
    retentions, retentionTotal,
    status: 'REGISTRADA',
  });
}

const run = (handler, req) => H.runController(handler, req);
const okPayload = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function draft(clinicId, userId, formType) {
  const r = await run(decls.draft, H.mockReq(clinicId, userId, { formType, year: YEAR, month: MONTH }));
  return okPayload(r);
}
async function finalize(clinicId, userId, id, body = {}) {
  return run(decls.finalize, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));
}

/** Saldo (debe−haber) de una cuenta por código. */
const bal = (clinicId, code) => H.accountBalanceByCode(clinicId, code);

// ─────────────────────────────────────────────────────────────────────────────
test('1) borrador: calcula casilleros y NO genera asiento ni CxP', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const data = await draft(clinicId, userId, '104');
  assert.equal(data.declaration.status, 'DRAFT');
  assert.equal(data.declaration.version, 1);
  assert.equal(data.cells['401'], 1000, 'ventas gravadas');
  assert.equal(data.cells['499'], 150, 'IVA generado');
  assert.equal(data.cells['530'], 60, 'IVA disponible de compras');
  assert.equal(data.cells['609'], 90, 'impuesto a pagar = 150 − 60');
  // La definición viaja para que la UI se dibuje con ella (no hardcodeada en JSX).
  assert.ok(data.definition.cells.length > 5);
  assert.equal(data.definition.verified, false, 'la definición se declara NO verificada');

  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0, 'el borrador no contabiliza');
  assert.equal(await Payable.countDocuments({ clinic: clinicId }), 0, 'el borrador no abre CxP');

  // Recalcular sigue sin efectos contables.
  const again = okPayload(await run(decls.recompute, H.mockReq(clinicId, userId, {}, { params: { id: String(data.declaration._id) } })));
  assert.equal(again.cells['609'], 90);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) F104 finalizado: asiento balanceado, SRI por pagar y Banco intacto', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const d = await draft(clinicId, userId, '104');
  const fin = okPayload(await finalize(clinicId, userId, d.declaration._id));

  assert.equal(fin.declaration.status, 'FINALIZED');
  assert.ok(fin.declaration.journalEntry, 'generó asiento');
  assert.ok(fin.declaration.payableRef, 'generó CxP al SRI');
  assert.equal(fin.declaration.totals.impuestoPorPagar, 90);
  assert.ok(fin.declaration.xmlHash, 'guarda hash del borrador técnico');

  const ledger = await H.assertLedgerBalanced(clinicId);
  assert.ok(ledger.balanced, 'el mayor cuadra');

  // IVA ventas (pasivo) e IVA compras (activo) quedan cerrados por el asiento.
  assert.equal(await bal(clinicId, '2.1.02.01'), 150, 'IVA ventas debitado por el cierre');
  assert.equal(await bal(clinicId, '1.1.03.01'), -60, 'IVA compras acreditado por el cierre');
  assert.equal(await bal(clinicId, '2.1.02.06'), -90, 'SRI por pagar acreditado (pasivo)');
  assert.equal(await bal(clinicId, '1.1.01.03'), 0, 'Banco NO se movió');

  // La CxP es submayor: no hay segundo crédito contable.
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.total, 90);
  assert.equal(cxp.balance, 90);
  const sriAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.02.06' });
  assert.equal(String(cxp.account), String(sriAcc._id), 'la CxP apunta a la cuenta de control');
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) finalizar dos veces no duplica asiento ni obligación', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId, { baseGravada: 200, iva: 30 });

  const d = await draft(clinicId, userId, '104');
  okPayload(await finalize(clinicId, userId, d.declaration._id));

  // Segundo intento: la declaración ya no es borrador → se rechaza.
  const second = await finalize(clinicId, userId, d.declaration._id);
  assert.equal(second.statusCode, 400);

  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 1);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 1);
  // Tampoco se puede abrir otro borrador del mismo período (evita duplicados equivalentes).
  const dup = await run(decls.draft, H.mockReq(clinicId, userId, { formType: '104', year: YEAR, month: MONTH }));
  assert.equal(dup.statusCode, 400);
  assert.match(dup.payload.message, /sustitutiva/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) IVA no deducible se envía al gasto contra IVA compras', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  // Ventas mixtas: 1000 gravadas + 1000 en 0% SIN derecho a crédito → factor 0.5.
  await makeSale(clinicId, { baseGravada: 1000, base0: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const d = await draft(clinicId, userId, '104');
  assert.equal(d.cells['403'], 1000, 'por defecto la base 0% no da derecho a crédito');
  assert.equal(d.cells['563'], 0.5, 'factor de proporcionalidad');
  assert.equal(d.cells['565'], 30, 'IVA al gasto sugerido = 60 × (1 − 0.5)');
  assert.equal(d.cells['564'], 30, 'IVA utilizable');

  // No admite negativos ni más que el IVA disponible.
  const neg = await run(decls.update, H.mockReq(clinicId, userId, { cells: { 565: -1 } }, { params: { id: String(d.declaration._id) } }));
  assert.equal(neg.statusCode, 400);
  const tooMuch = await run(decls.update, H.mockReq(clinicId, userId, { cells: { 565: 61 } }, { params: { id: String(d.declaration._id) } }));
  assert.equal(tooMuch.statusCode, 400);
  assert.match(tooMuch.payload.message, /no puede superar/i);

  const fin = okPayload(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(fin.declaration.totals.ivaAlGasto, 30);
  assert.equal(await bal(clinicId, '6.3.03'), 30, 'IVA al gasto debitado');
  assert.equal(await bal(clinicId, '1.1.03.01'), -60, 'IVA compras cerrado completo (utilizable + al gasto)');
  assert.equal(fin.declaration.totals.impuestoPorPagar, 120, '150 − 30 utilizable');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) crédito tributario: saldo a favor sin deuda ficticia ni CxP', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 100, iva: 15 });
  await makePurchase(clinicId, sup._id, { subtotal: 600, iva: 90 });

  const d = await draft(clinicId, userId, '104');
  assert.equal(d.cells['609'], 0, 'no hay impuesto a pagar');
  assert.equal(d.cells['615'], 75, 'crédito tributario 90 − 15');

  const fin = okPayload(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(fin.declaration.totals.creditoTributario, 75);
  assert.equal(fin.declaration.totals.totalAPagar, 0);
  assert.equal(fin.declaration.payableRef, null, 'sin obligación: no se abre CxP');
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 0);
  assert.equal(await bal(clinicId, '1.1.03.05'), 75, 'crédito tributario queda como activo');
  assert.equal(await bal(clinicId, '2.1.02.06'), 0, 'SRI por pagar sin deuda ficticia');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('6) sustitutiva: nueva versión, reversa la anterior y conserva su snapshot', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });

  const d = await draft(clinicId, userId, '104');
  const v1 = okPayload(await finalize(clinicId, userId, d.declaration._id)).declaration;
  const snapshotV1 = JSON.stringify(v1.snapshot.ventas);

  // Aparece una compra olvidada → sustitutiva.
  await makePurchase(clinicId, sup._id, { subtotal: 200, iva: 30, day: 20 });
  const sub = okPayload(await run(decls.substitute, H.mockReq(clinicId, userId, {}, { params: { id: String(v1._id) } })));
  assert.equal(sub.declaration.version, 2);
  assert.equal(sub.declaration.status, 'DRAFT');
  assert.equal(String(sub.declaration.replaces), String(v1._id));
  assert.equal(sub.cells['530'], 90, 'la v2 ve las dos compras');

  const v2 = okPayload(await finalize(clinicId, userId, sub.declaration._id)).declaration;
  assert.equal(v2.status, 'FINALIZED');
  assert.equal(v2.totals.impuestoPorPagar, 60, '150 − 90');

  const original = await SriDeclaration.findById(v1._id);
  assert.equal(original.status, 'SUBSTITUTIVE', 'la anterior queda marcada como sustituida');
  assert.equal(String(original.replacedBy), String(v2._id));
  assert.equal(JSON.stringify(original.snapshot.ventas), snapshotV1, 'su snapshot NO se modificó');

  // El asiento de la v1 fue reversado: no queda pasivo duplicado.
  const entryV1 = await JournalEntry.findById(original.journalEntry);
  assert.equal(entryV1.isReversed, true);
  assert.equal(await bal(clinicId, '2.1.02.06'), -60, 'solo el pasivo de la v2');
  const cxps = await Payable.find({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  const vivas = cxps.filter((c) => c.status !== 'ANULADO');
  assert.equal(vivas.length, 1, 'una sola obligación vigente');
  assert.equal(vivas[0].total, 60);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('7) F103: concilia con compras y con nómina cerrada, y cierra contra SRI por pagar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  // Compra CON retención de renta y compra SIN retención (no sujeta).
  await makePurchase(clinicId, sup._id, {
    subtotal: 1000, iva: 150,
    retentions: [{ type: 'RENTA', code: '303', description: 'Honorarios', baseAmount: 1000, percentage: 10, amount: 100 }],
  });
  await makePurchase(clinicId, sup._id, { subtotal: 500, iva: 75, day: 12 });

  // Nómina cerrada del período con IR retenido.
  await Payroll.create({
    clinic: clinicId, year: YEAR, month: MONTH, period: `${YEAR}-0${MONTH}`, status: 'CERRADO',
    totalNeto: 900,
    items: [{
      employee: new H.mongoose.Types.ObjectId(), employeeName: 'Ana Pérez', identificacion: '0102030405',
      baseSalary: 1000, decimoTercero: 83.33, iessPersonal: 94.5, impuestoRenta: 25, netoPagar: 963.83,
    }],
  });

  const d = await draft(clinicId, userId, '103');
  assert.equal(d.cells['302'], 1000, 'base laboral = ingresos gravados (sin décimo tercero)');
  assert.equal(d.cells['332'], 500, 'compra sin retención va a no sujetos');
  assert.equal(d.cells['399'], 125, 'total retenido = 100 proveedores + 25 nómina');

  const snap = d.declaration.snapshot;
  assert.equal(snap.proveedores.rows.length, 1);
  assert.equal(snap.proveedores.rows[0].code, '303');
  assert.equal(snap.proveedores.rows[0].docs.length, 1, 'cada retención con su documento origen');
  assert.equal(snap.dependencia.baseImponibleNeta, 905.5, 'también expone la base neta de IESS (1000 − 94.5)');
  // Décimo tercero excluido con motivo auditable.
  assert.ok(snap.dependencia.excluidos.some((e) => e.rubro === 'Décimo tercero' && e.motivo));
  assert.ok(d.conciliaciones.every((c) => c.ok), 'todas las conciliaciones pasan');

  const fin = okPayload(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(fin.declaration.totals.totalAPagar, 125);
  assert.equal(await bal(clinicId, '2.1.02.04'), 100, 'retención renta proveedores debitada (cierra el pasivo)');
  assert.equal(await bal(clinicId, '2.1.02.05'), 25, 'IR de empleados debitado');
  assert.equal(await bal(clinicId, '2.1.02.06'), -125, 'obligación con el SRI');
  assert.equal(await bal(clinicId, '1.1.01.03'), 0, 'Banco intacto');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.total, 125);
});

// ─────────────────────────────────────────────────────────────────────────────
test('8) el pago de la declaración es lo único que mueve el Banco', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  const bankAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const bank = await BankAccount.create({
    clinic: clinicId, name: 'Cta Corriente', bank: 'Pichincha', accountNumber: '123', chartAccount: bankAcc._id,
  });

  const d = await draft(clinicId, userId, '104');
  const fin = okPayload(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(await bal(clinicId, '1.1.01.03'), 0, 'finalizar no toca Banco');

  // Pago parcial y luego el resto.
  okPayload(await run(decls.pay, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: 50 }, { params: { id: String(fin.declaration._id) } })));
  let cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.balance, 100, '150 − 50');
  assert.equal(await bal(clinicId, '1.1.01.03'), -50);

  okPayload(await run(decls.pay, H.mockReq(clinicId, userId, { bankAccountId: bank._id }, { params: { id: String(fin.declaration._id) } })));
  cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.balance, 0);
  assert.equal(cxp.status, 'PAGADO');
  assert.equal(await bal(clinicId, '1.1.01.03'), -150, 'Banco pagó el total');
  assert.equal(await bal(clinicId, '2.1.02.06'), 0, 'SRI por pagar liquidado');

  // Un tercer pago ya no procede (sin saldo).
  const extra = await run(decls.pay, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: 10 }, { params: { id: String(fin.declaration._id) } }));
  assert.equal(extra.statusCode, 400);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('9) período cerrado: no se puede finalizar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId, { baseGravada: 100, iva: 15 });
  const d = await draft(clinicId, userId, '104');

  await FiscalPeriod.updateOne({ clinic: clinicId, year: YEAR, month: MONTH }, { $set: { status: 'CERRADO' } }, { upsert: true });

  const r = await finalize(clinicId, userId, d.declaration._id);
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no esta abierto/i);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 0);
  assert.equal((await SriDeclaration.findById(d.declaration._id)).status, 'DRAFT', 'sigue en borrador');
});

// ─────────────────────────────────────────────────────────────────────────────
test('10) dos clínicas: sin contaminación de datos', async () => {
  const a = await H.seedClinic({ date: inMonth() });
  const b = await H.seedClinic({ date: inMonth() });
  const supA = await H.makeSupplier(a.clinicId);

  await makeSale(a.clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(a.clinicId, supA._id, { subtotal: 400, iva: 60 });
  await makeSale(b.clinicId, { baseGravada: 200, iva: 30 });

  const da = await draft(a.clinicId, a.userId, '104');
  const db = await draft(b.clinicId, b.userId, '104');

  assert.equal(da.cells['499'], 150);
  assert.equal(db.cells['499'], 30, 'la clínica B solo ve sus ventas');
  assert.equal(db.cells['530'], 0, 'la compra de A no entra en B');

  okPayload(await finalize(a.clinicId, a.userId, da.declaration._id));
  okPayload(await finalize(b.clinicId, b.userId, db.declaration._id));

  assert.equal(await bal(a.clinicId, '2.1.02.06'), -90);
  assert.equal(await bal(b.clinicId, '2.1.02.06'), -30);
  assert.equal(await Payable.countDocuments({ clinic: a.clinicId, sourceModel: 'SriDeclaration' }), 1);
  assert.equal(await Payable.countDocuments({ clinic: b.clinicId, sourceModel: 'SriDeclaration' }), 1);

  // Una declaración de A no es accesible desde B.
  const cross = await run(decls.get, H.mockReq(b.clinicId, b.userId, {}, { params: { id: String(da.declaration._id) } }));
  assert.equal(cross.statusCode, 404);
});
