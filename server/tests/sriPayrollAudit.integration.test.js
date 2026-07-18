/**
 * AUDITORÍA PRE-COMMIT — escenarios contables críticos del módulo de declaraciones
 * SRI y de la nómina proyectable.
 *
 * Cubre lo que la suite anterior no tocaba: sustitutivas sobre declaraciones YA PAGADAS,
 * fuente de verdad del saldo de nómina, rollback transaccional, reapertura + re-cierre,
 * concurrencia, manipulación de casilleros desde el cliente, doble registro del IVA al
 * gasto, fechas efectivas y resolución de cuentas por rol.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const decls = require('../controllers/taxDeclarationController');
const payrollCtrl = require('../controllers/payrollController');
const SriDeclaration = require('../models/SriDeclaration');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payroll = require('../models/Payroll');
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');
const FiscalPeriod = require('../models/FiscalPeriod');
const ChartOfAccount = require('../models/ChartOfAccount');
const AccountingConfig = require('../models/AccountingConfig');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Employee = require('../models/Employee');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');
const { getAccount } = require('../utils/accountMap');
const { ensureAccountByCode } = require('../utils/accounting');
const { nextBusinessDay, effectivePaymentDate } = require('../utils/paymentSchedule');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = 2026;
const MONTH = 5;
const inMonth = (day = 15) => new Date(YEAR, MONTH - 1, day, 12, 0, 0);
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const bal = (clinicId, code) => H.accountBalanceByCode(clinicId, code);

let seq = 0;

async function makeSale(clinicId, { baseGravada = 0, base0 = 0, iva = 0, day = 15 } = {}) {
  seq += 1;
  return Invoice.create({
    clinic: clinicId,
    claveAcceso: `CLV${Date.now()}${seq}${Math.floor(Math.random() * 1e6)}`,
    secuencial: String(seq).padStart(9, '0'),
    estab: '001', ptoEmi: '001', ambiente: '1',
    fechaEmision: dmy(inMonth(day)), estado: 'AUTORIZADO',
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: baseGravada + base0, totalImpuesto: iva, importeTotal: baseGravada + base0 + iva,
    taxBreakdown: { computed: true, base0, baseGravada, baseExento: 0, baseNoObjeto: 0, iva },
  });
}

async function makePurchase(clinicId, supplierId, { subtotal = 100, iva = 15, deductible = true, day = 10 } = {}) {
  seq += 1;
  return PurchaseInvoice.create({
    clinic: clinicId, supplier: supplierId, docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision: inMonth(day),
    subtotal, subtotal15: subtotal, iva, total: subtotal + iva,
    deductible,
    vatCreditAmount: deductible === false ? 0 : iva,
    vatNonCreditAmount: deductible === false ? iva : 0,
    status: 'REGISTRADA',
  });
}

const draft = async (clinicId, userId, formType = '104') =>
  ok(await run(decls.draft, H.mockReq(clinicId, userId, { formType, year: YEAR, month: MONTH })));
const finalize = (clinicId, userId, id, body = {}) =>
  run(decls.finalize, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));
const substitute = (clinicId, userId, id) =>
  run(decls.substitute, H.mockReq(clinicId, userId, {}, { params: { id: String(id) } }));
const payDecl = (clinicId, userId, id, body) =>
  run(decls.pay, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));

async function makeBank(clinicId) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  return BankAccount.create({ clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '1', chartAccount: acc._id });
}

/** Clínica con ventas/compras y una declaración 104 finalizada (impuesto 90). */
async function seedFinalized104(extra = {}) {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });
  const d = await draft(clinicId, userId);
  const v1 = ok(await finalize(clinicId, userId, d.declaration._id, extra)).declaration;
  return { clinicId, userId, sup, v1 };
}

// ═══════════════════ 1. SUSTITUTIVAS ═══════════════════

test('S1) sustitutiva por valor MAYOR sobre declaración impaga: reversa y deja una sola obligación', async () => {
  const { clinicId, userId, sup, v1 } = await seedFinalized104();
  assert.equal(v1.totals.impuestoPorPagar, 90);

  // Se anula una compra ⇒ menos crédito ⇒ más impuesto.
  await PurchaseInvoice.updateMany({ clinic: clinicId }, { $set: { status: 'ANULADA' } });
  const sub = ok(await substitute(clinicId, userId, v1._id));
  const v2 = ok(await finalize(clinicId, userId, sub.declaration._id)).declaration;

  assert.equal(v2.totals.impuestoPorPagar, 150, 'sin crédito de compras');
  assert.equal((await SriDeclaration.findById(v1._id)).status, 'SUBSTITUTIVE');
  assert.equal(await bal(clinicId, '2.1.02.06'), -150, 'solo el pasivo de la v2');
  const vivas = (await Payable.find({ clinic: clinicId, sourceModel: 'SriDeclaration' })).filter((p) => p.status !== 'ANULADO');
  assert.equal(vivas.length, 1);
  assert.equal(vivas[0].total, 150);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('S2) sustitutiva por valor MENOR sobre declaración impaga', async () => {
  const { clinicId, userId, sup, v1 } = await seedFinalized104();
  await makePurchase(clinicId, sup._id, { subtotal: 200, iva: 30, day: 20 });

  const sub = ok(await substitute(clinicId, userId, v1._id));
  const v2 = ok(await finalize(clinicId, userId, sub.declaration._id)).declaration;

  assert.equal(v2.totals.impuestoPorPagar, 60, '150 − 90 de crédito');
  assert.equal(await bal(clinicId, '2.1.02.06'), -60);
  const vivas = (await Payable.find({ clinic: clinicId, sourceModel: 'SriDeclaration' })).filter((p) => p.status !== 'ANULADO');
  assert.equal(vivas.length, 1);
  assert.equal(vivas[0].total, 60);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('S3) declaración PAGADA PARCIALMENTE: la sustitutiva se BLOQUEA y el historial queda intacto', async () => {
  const { clinicId, userId, v1 } = await seedFinalized104();
  const bank = await makeBank(clinicId);
  ok(await payDecl(clinicId, userId, v1._id, { bankAccountId: bank._id, amount: 40 }));

  const r = await substitute(clinicId, userId, v1._id);
  assert.equal(r.statusCode, 400, 'no se permite sustituir una declaración con pagos aplicados');
  assert.match(r.payload.message, /pago/i);

  // Nada del historial se tocó.
  assert.equal((await SriDeclaration.findById(v1._id)).status, 'FINALIZED');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.applied, 40, 'la aplicación de pago sigue viva');
  assert.equal(cxp.status, 'PARCIAL');
  assert.equal(await bal(clinicId, '1.1.01.03'), -40, 'el movimiento bancario histórico se conserva');
  assert.equal(await bal(clinicId, '2.1.02.06'), -50, '90 − 40 pagado');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1, 'no se creó una versión nueva');
});

test('S4) declaración PAGADA POR COMPLETO: la sustitutiva se BLOQUEA sin duplicar el pago', async () => {
  const { clinicId, userId, sup, v1 } = await seedFinalized104();
  const bank = await makeBank(clinicId);
  ok(await payDecl(clinicId, userId, v1._id, { bankAccountId: bank._id }));

  // Aparece una compra olvidada (la sustitutiva tendría un valor MENOR)…
  await makePurchase(clinicId, sup._id, { subtotal: 200, iva: 30, day: 20 });
  const menor = await substitute(clinicId, userId, v1._id);
  assert.equal(menor.statusCode, 400);

  // …y también con impuesto ADICIONAL (valor mayor).
  await PurchaseInvoice.updateMany({ clinic: clinicId }, { $set: { status: 'ANULADA' } });
  const mayor = await substitute(clinicId, userId, v1._id);
  assert.equal(mayor.statusCode, 400);
  assert.match(mayor.payload.message, /revers/i, 'el mensaje explica el procedimiento contable requerido');

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.status, 'PAGADO');
  assert.equal(cxp.balance, 0, 'nunca queda saldo negativo');
  assert.equal(await bal(clinicId, '1.1.01.03'), -90, 'un solo pago al banco');
  assert.equal(await bal(clinicId, '2.1.02.06'), 0, 'obligación liquidada, sin pasivo residual');
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('S5) finalizar una sustitutiva creada ANTES del pago también se bloquea', async () => {
  const { clinicId, userId, v1 } = await seedFinalized104();
  const bank = await makeBank(clinicId);
  // Borrador sustitutivo creado primero…
  const sub = ok(await substitute(clinicId, userId, v1._id));
  // …y el pago ocurre después.
  ok(await payDecl(clinicId, userId, v1._id, { bankAccountId: bank._id }));

  const r = await finalize(clinicId, userId, sub.declaration._id);
  assert.equal(r.statusCode, 400, 'no se puede finalizar: reversaría un asiento ya pagado');
  assert.equal((await SriDeclaration.findById(v1._id)).status, 'FINALIZED', 'la original sigue vigente');
  assert.equal((await JournalEntry.findById(v1.journalEntry)).isReversed, false, 'su asiento NO se reversó');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.status, 'PAGADO');
});

test('S6) sustitutiva de una declaración con SALDO A FAVOR (sin obligación)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 100, iva: 15 });
  await makePurchase(clinicId, sup._id, { subtotal: 600, iva: 90 });

  const d = await draft(clinicId, userId);
  const v1 = ok(await finalize(clinicId, userId, d.declaration._id)).declaration;
  assert.equal(v1.totals.creditoTributario, 75);
  assert.equal(await bal(clinicId, '1.1.03.05'), 75);

  await makeSale(clinicId, { baseGravada: 1000, iva: 150, day: 20 });
  const sub = ok(await substitute(clinicId, userId, v1._id));
  const v2 = ok(await finalize(clinicId, userId, sub.declaration._id)).declaration;

  assert.equal(v2.totals.impuestoPorPagar, 75, '165 − 90');
  assert.equal(await bal(clinicId, '1.1.03.05'), 0, 'el crédito de la v1 se reversó');
  assert.equal(await bal(clinicId, '2.1.02.06'), -75);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('S7) período CERRADO: la corrección se contabiliza en la fecha abierta que se indique', async () => {
  const { clinicId, userId, sup, v1 } = await seedFinalized104();
  await FiscalPeriod.updateOne({ clinic: clinicId, year: YEAR, month: MONTH }, { $set: { status: 'CERRADO' } });
  await makePurchase(clinicId, sup._id, { subtotal: 200, iva: 30, day: 20 });

  // Guardar/crear el borrador sustitutivo NO contabiliza: se permite.
  const sub = ok(await substitute(clinicId, userId, v1._id));
  assert.equal(sub.declaration.status, 'DRAFT');

  // Finalizar con la fecha del período cerrado: bloqueado.
  const blocked = await finalize(clinicId, userId, sub.declaration._id);
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.payload.message, /no esta abierto/i);
  assert.equal((await JournalEntry.findById(v1.journalEntry)).isReversed, false, 'no se reversó nada');

  // Con fecha contable en un período ABIERTO: la corrección procede.
  const openDate = new Date(YEAR, MONTH, 15, 12); // mes siguiente, abierto
  const v2 = ok(await finalize(clinicId, userId, sub.declaration._id, { accountingDate: iso(openDate) })).declaration;
  const rev = await JournalEntry.findOne({ clinic: clinicId, reverses: v1.journalEntry });
  assert.equal(iso(rev.date), iso(openDate), 'la reversa se registra en el período abierto');
  assert.equal(iso((await JournalEntry.findById(v2.journalEntry)).date), iso(openDate));
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ═══════════════════ 2. NÓMINA: FUENTE DE VERDAD ═══════════════════

async function seedPayrollClinic() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date(YEAR, MONTH - 1, 15) });
  await PayrollIncomeTaxTable.create({ clinic: clinicId, year: YEAR, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
  await Employee.create({
    clinic: clinicId, code: `EMP-${Math.floor(Math.random() * 1e6)}`,
    firstName: 'Ana', lastName: 'Pérez', identificacion: `17${Math.floor(Math.random() * 1e8)}`,
    hireDate: new Date(YEAR - 2, 0, 1), baseSalary: 1000, active: true,
  });
  return { clinicId, userId };
}
async function closeNewPayroll(clinicId, userId, body = {}) {
  const gen = ok(await run(payrollCtrl.generatePayroll, H.mockReq(clinicId, userId, { year: YEAR, month: MONTH })));
  return ok(await run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, body, { params: { id: String(gen._id) } })));
}
const payPayroll = (clinicId, userId, id, body) =>
  run(payrollCtrl.markPaid, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));

test('N1) el saldo de la CxP manda: pendingAmount del rol siempre coincide con ella', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closeNewPayroll(clinicId, userId);
  const neto = p.totalNeto;

  const check = async () => {
    const roll = await Payroll.findById(p._id);
    const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: p._id });
    assert.equal(roll.pendingAmount, cxp.balance, 'pendingAmount == saldo de la CxP');
    assert.equal(roll.paidAmount, cxp.applied, 'paidAmount == aplicado en la CxP');
    return { roll, cxp };
  };
  await check();

  ok(await payPayroll(clinicId, userId, p._id, { bankAccountId: bank._id, amount: 100 }));
  await check();
  ok(await payPayroll(clinicId, userId, p._id, { bankAccountId: bank._id, amount: 50 }));
  const mid = await check();
  assert.equal(mid.cxp.balance, +(neto - 150).toFixed(2));

  ok(await payPayroll(clinicId, userId, p._id, { bankAccountId: bank._id }));
  const end = await check();
  assert.equal(end.cxp.balance, 0);
  assert.equal(end.roll.status, 'PAGADO');
  assert.equal(await bal(clinicId, '1.1.01.03'), -neto, 'el banco pagó exactamente el neto');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('N2) un fallo dentro de la transacción de pago hace rollback COMPLETO', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closeNewPayroll(clinicId, userId);

  const original = BankTransaction.create;
  BankTransaction.create = () => { throw new Error('fallo simulado del libro de bancos'); };
  let r;
  try {
    r = await payPayroll(clinicId, userId, p._id, { bankAccountId: bank._id, amount: 100 });
  } finally {
    BankTransaction.create = original;
  }
  assert.ok(r.statusCode >= 400, 'el pago falla');

  // Nada quedó a medias: ni asiento, ni movimiento bancario, ni aplicación, ni pago en el rol.
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^PAY/ }), 0);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 0);
  const roll = await Payroll.findById(p._id);
  assert.equal(roll.payments.length, 0);
  assert.equal(roll.status, 'CERRADO');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, 0, 'la obligación sigue intacta');
  assert.equal(await bal(clinicId, '1.1.01.03'), 0, 'el banco no se movió');

  // Y el pago se puede reintentar limpiamente.
  ok(await payPayroll(clinicId, userId, p._id, { bankAccountId: bank._id, amount: 100 }));
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' })).applied, 100);
});

// ═══════════════════ 3. REAPERTURA / ANULACIÓN ═══════════════════

test('R1) reabrir y volver a cerrar genera un asiento NUEVO (no reutiliza el reversado)', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const p = await closeNewPayroll(clinicId, userId);
  const firstEntry = p.journalEntry;

  ok(await run(payrollCtrl.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } })));
  const reclosed = ok(await run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } })));

  assert.equal(reclosed.status, 'CERRADO');
  assert.notEqual(String(reclosed.journalEntry), String(firstEntry), 'el rol NO apunta al asiento reversado');
  const nuevo = await JournalEntry.findById(reclosed.journalEntry);
  assert.equal(nuevo.isReversed, false, 'el asiento vigente no está reversado');
  assert.ok(nuevo.totalDebit > 0, 'el gasto se volvió a reconocer');

  // El pasivo vuelve a existir UNA vez y respalda la obligación reabierta.
  assert.equal(await bal(clinicId, '2.1.03.01'), -reclosed.totalNeto, 'Sueldos por pagar respaldado por el mayor');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.status, 'ABIERTO');
  assert.equal(cxp.balance, reclosed.totalNeto);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('R2) reapertura: bloqueada con pagos, y no se puede reabrir dos veces', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closeNewPayroll(clinicId, userId);

  // Sin pagos: se reabre. Dos veces seguidas: la segunda falla.
  ok(await run(payrollCtrl.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } })));
  const twice = await run(payrollCtrl.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } }));
  assert.equal(twice.statusCode, 400);

  // Con pago parcial: bloqueada, y el pago no se toca.
  const reclosed = ok(await run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } })));
  ok(await payPayroll(clinicId, userId, reclosed._id, { bankAccountId: bank._id, amount: 100 }));
  const blocked = await run(payrollCtrl.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } }));
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.payload.message, /pagos/i);
  const roll = await Payroll.findById(p._id);
  assert.equal(roll.payments.length, 1, 'el pago sigue conectado al rol');
  assert.equal(await bal(clinicId, '1.1.01.03'), -100);

  // Anular tampoco procede con pagos.
  const voided = await run(payrollCtrl.voidPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } }));
  assert.equal(voided.statusCode, 400);
});

// ═══════════════════ 4. CONCURRENCIA ═══════════════════

const settled = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { statusCode: 500, payload: { message: String(r.reason?.message) } }));

test('C1) dos borradores simultáneos del mismo período → uno solo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId, { baseGravada: 100, iva: 15 });

  const rs = settled(await Promise.allSettled([
    run(decls.draft, H.mockReq(clinicId, userId, { formType: '104', year: YEAR, month: MONTH })),
    run(decls.draft, H.mockReq(clinicId, userId, { formType: '104', year: YEAR, month: MONTH })),
  ]));
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1, 'un solo borrador');
  assert.ok(rs.every((r) => r.statusCode < 500), `respuesta controlada: ${JSON.stringify(rs.map((r) => r.payload?.message))}`);
});

test('C2) finalizar la misma declaración dos veces en paralelo → un asiento y una CxP', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  const d = await draft(clinicId, userId);

  const rs = settled(await Promise.allSettled([
    finalize(clinicId, userId, d.declaration._id),
    finalize(clinicId, userId, d.declaration._id),
  ]));
  assert.equal(rs.filter((r) => r.statusCode < 400).length, 1, 'solo una gana');
  assert.ok(rs.some((r) => r.statusCode === 400), 'la perdedora recibe un error controlado');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 1);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 1);
  assert.equal(await bal(clinicId, '2.1.02.06'), -150, 'el pasivo no se duplicó');
});

test('C3) dos sustitutivas simultáneas de la misma versión → una sola', async () => {
  const { clinicId, userId, v1 } = await seedFinalized104();
  const rs = settled(await Promise.allSettled([
    substitute(clinicId, userId, v1._id),
    substitute(clinicId, userId, v1._id),
  ]));
  const drafts = await SriDeclaration.find({ clinic: clinicId, status: 'DRAFT' });
  assert.equal(drafts.length, 1, 'una sola versión sustitutiva');
  assert.equal(drafts[0].version, 2);
  assert.ok(rs.every((r) => r.statusCode < 500), `respuesta controlada: ${JSON.stringify(rs.map((r) => r.payload?.message))}`);
});

test('C4) cerrar y pagar la misma nómina en paralelo → un asiento, un pago', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const gen = ok(await run(payrollCtrl.generatePayroll, H.mockReq(clinicId, userId, { year: YEAR, month: MONTH })));

  const closes = settled(await Promise.allSettled([
    run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(gen._id) } })),
    run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(gen._id) } })),
  ]));
  assert.equal(closes.filter((r) => r.statusCode < 400).length, 1, 'un solo cierre');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^CLOSE/ }), 1);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'Payroll' }), 1);

  const roll = await Payroll.findById(gen._id);
  const pays = settled(await Promise.allSettled([
    payPayroll(clinicId, userId, roll._id, { bankAccountId: bank._id }),
    payPayroll(clinicId, userId, roll._id, { bankAccountId: bank._id }),
  ]));
  assert.equal(pays.filter((r) => r.statusCode < 400).length, 1, 'un solo pago total');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1, 'un solo movimiento bancario');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, roll.totalNeto, 'sin doble aplicación');
  assert.equal(await bal(clinicId, '1.1.01.03'), -roll.totalNeto);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('C5) ensureAccountByCode en paralelo no duplica la cuenta', async () => {
  const { clinicId } = await H.seedClinic({ date: inMonth() });
  await ChartOfAccount.deleteOne({ clinic: clinicId, code: '2.1.02.06' });

  const rs = await Promise.allSettled(
    Array.from({ length: 5 }, () => ensureAccountByCode(clinicId, '2.1.02.06'))
  );
  assert.ok(rs.every((r) => r.status === 'fulfilled' && r.value), 'todas resuelven la cuenta');
  assert.equal(await ChartOfAccount.countDocuments({ clinic: clinicId, code: '2.1.02.06' }), 1, 'una sola cuenta');
});

// ═══════════════════ 5. SEGURIDAD DE CASILLEROS ═══════════════════

test('X1) el cliente no puede manipular casilleros calculados, totales ni snapshot', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });
  const d = await draft(clinicId, userId);
  const id = String(d.declaration._id);
  const upd = (body) => run(decls.update, H.mockReq(clinicId, userId, body, { params: { id } }));

  // Casilleros calculados: impuesto, crédito, IVA utilizable, factor, ventas y compras.
  for (const box of ['609', '615', '564', '563', '499', '401', '530', '500', '902']) {
    const r = await upd({ cells: { [box]: 1 } });
    assert.equal(r.statusCode, 400, `el casillero calculado ${box} no debe aceptarse`);
  }
  // Casillero inexistente.
  assert.equal((await upd({ cells: { 999: 1 } })).statusCode, 400);
  // Tipos inválidos y negativos.
  assert.equal((await upd({ cells: { 565: 'abc' } })).statusCode, 400, 'valor no numérico');
  assert.equal((await upd({ cells: { 565: -5 } })).statusCode, 400, 'negativo');
  assert.equal((await upd({ cells: { 605: -1 } })).statusCode, 400);

  // computedCells / totals / snapshot enviados por el cliente se ignoran.
  const r = ok(await upd({
    cells: { 565: 10 },
    computedCells: [{ box: '609', value: 0 }],
    totals: { impuestoPorPagar: 0, totalAPagar: 0 },
    snapshot: { ventas: { iva: 0 } },
    status: 'FINALIZED',
  }));
  assert.equal(r.cells['429'], 150, 'las ventas se recalculan del origen');
  assert.equal(r.declaration.totals.impuestoPorPagar, 100, '150 − (60 − 10 al gasto)');
  assert.equal(r.declaration.status, 'DRAFT', 'el estado no se deja pisar');
  assert.equal(r.declaration.snapshot.ventas.iva, 150, 'el snapshot lo escribe el backend');

  // Al finalizar se recalcula todo otra vez: se contabiliza lo recalculado.
  const fin = ok(await finalize(clinicId, userId, id));
  assert.equal(fin.declaration.totals.impuestoPorPagar, 100);
  assert.equal(await bal(clinicId, '2.1.02.06'), -100);
});

// ═══════════════════ 6. IVA Y FACTOR ═══════════════════

test('V1) el IVA no deducible se carga al gasto UNA sola vez (en la compra, no en el cierre)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 }); // todas gravadas ⇒ factor 1
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60, deductible: true });
  await makePurchase(clinicId, sup._id, { subtotal: 200, iva: 30, deductible: false, day: 12 });

  const d = await draft(clinicId, userId);
  assert.equal(d.cells['563'], 1, 'factor 1: todas las ventas dan derecho a crédito');
  assert.equal(d.cells['529'], 90, 'IVA total de compras (60 + 30)');
  assert.equal(d.cells['530'], 60, 'IVA disponible: excluye el que ya fue al gasto');
  assert.equal(d.cells['565'], 0, 'nada que reclasificar');
  assert.equal(d.cells['564'], 60);
  assert.equal(d.cells['502'], 200, 'la base gravada sin derecho a crédito se reporta en 502');

  // El tope del IVA al gasto es el disponible, no el IVA total.
  const over = await run(decls.update, H.mockReq(clinicId, userId, { cells: { 565: 61 } }, { params: { id: String(d.declaration._id) } }));
  assert.equal(over.statusCode, 400);

  const fin = ok(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(fin.declaration.totals.impuestoPorPagar, 90, '150 − 60');
  // La cuenta de IVA al gasto NO recibe nada del cierre (el asiento de la compra ya lo hizo).
  const gastoAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.3.03' });
  const cierre = await JournalEntry.findById(fin.declaration.journalEntry);
  assert.ok(
    !cierre.lines.some((l) => String(l.account) === String(gastoAcc._id)),
    'el cierre del 104 no vuelve a cargar el IVA al gasto'
  );
  // La conciliación deja explícita la limitación del factor (no hay atribución directa).
  assert.ok(
    (d.warnings || []).some((w) => w.code === 'IVA_ATRIBUCION_DIRECTA'),
    'se advierte que el sistema no distingue IVA de atribución directa vs. común'
  );
});

// ═══════════════════ 7. FECHAS EFECTIVAS ═══════════════════

test('F1) sábado es hábil, domingo se proyecta al lunes y la fecha legal nunca cambia', async () => {
  // Julio 2026: 10 = viernes, 11 = sábado, 12 = domingo, 13 = lunes.
  const viernes = new Date(2026, 6, 10);
  const sabado = new Date(2026, 6, 11);
  const domingo = new Date(2026, 6, 12);
  const lunes = new Date(2026, 6, 13);
  assert.deepEqual([viernes.getDay(), sabado.getDay(), domingo.getDay(), lunes.getDay()], [5, 6, 0, 1]);

  assert.equal(iso(nextBusinessDay(viernes)), iso(viernes), 'viernes no se mueve');
  assert.equal(iso(nextBusinessDay(sabado)), iso(sabado), 'sábado es día válido: NO se mueve');
  assert.equal(iso(nextBusinessDay(domingo)), iso(lunes), 'domingo → lunes');
  assert.equal(iso(nextBusinessDay(lunes)), iso(lunes), 'lunes no se mueve');

  for (const d of [viernes, sabado, lunes]) {
    const r = effectivePaymentDate({ dueDate: d });
    assert.equal(r.shifted, false);
    assert.equal(iso(r.dueDate), iso(d), 'el vencimiento legal se conserva');
  }
  const dom = effectivePaymentDate({ dueDate: domingo });
  assert.equal(iso(dom.dueDate), iso(domingo), 'el dueDate legal NO se modifica');
  assert.equal(iso(dom.effectiveDate), iso(lunes));
  assert.equal(dom.shifted, true);
});

test('F2) la fecha planificada de pago prevalece SOLO para la proyección', async () => {
  const domingo = new Date(2026, 6, 12);
  const planificado = new Date(2026, 6, 20); // lunes siguiente
  const r = effectivePaymentDate({ dueDate: domingo, plannedPaymentDate: planificado });
  assert.equal(iso(r.dueDate), iso(domingo), 'el vencimiento legal sigue siendo el domingo');
  assert.equal(iso(r.effectiveDate), iso(planificado), 'la proyección usa la fecha planificada');

  // Una fecha planificada en domingo también se proyecta al lunes hábil.
  const r2 = effectivePaymentDate({ dueDate: new Date(2026, 6, 10), plannedPaymentDate: domingo });
  assert.equal(iso(r2.effectiveDate), iso(new Date(2026, 6, 13)));
  // Sin vencimiento se cae a la emisión (documentos al contado).
  const r3 = effectivePaymentDate({ issueDate: new Date(2026, 6, 10) });
  assert.equal(iso(r3.effectiveDate), iso(new Date(2026, 6, 10)));
});

// ═══════════════════ 8. CUENTAS Y ROLES ═══════════════════

test('A1) el rol configurado por la clínica manda y NO crea la cuenta por defecto', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  // Plan de cuentas personalizado: la clínica usa su propia cuenta para el fisco y no
  // tiene la del plan estándar.
  await ChartOfAccount.deleteOne({ clinic: clinicId, code: '2.1.02.06' });
  const propia = await ChartOfAccount.create({
    clinic: clinicId, code: '2.1.02.90', name: 'Fisco por pagar (plan propio)',
    type: 'PASIVO', nature: 'CREDITO', allowsMovement: true, level: 4,
  });
  await AccountingConfig.create({ clinic: clinicId, accounts: { sriPorPagar: propia._id } });

  const acc = await getAccount(clinicId, 'sriPorPagar');
  assert.equal(String(acc._id), String(propia._id), 'usa la cuenta configurada');
  assert.equal(
    await ChartOfAccount.countDocuments({ clinic: clinicId, code: '2.1.02.06' }), 0,
    'no crea una segunda cuenta cuando el rol ya está correctamente configurado'
  );

  // Y la declaración contabiliza contra ESA cuenta.
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  const d = await draft(clinicId, userId);
  ok(await finalize(clinicId, userId, d.declaration._id));
  assert.equal(await bal(clinicId, '2.1.02.90'), -150, 'el pasivo va a la cuenta configurada');
  assert.equal(await ChartOfAccount.countDocuments({ clinic: clinicId, code: '2.1.02.06' }), 0);
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(String(cxp.account), String(propia._id), 'la CxP apunta a la cuenta configurada');
});

test('A2) cuenta archivada/agrupadora configurada en un rol → error claro, sin asiento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sri = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.02.06' })
    || await ensureAccountByCode(clinicId, '2.1.02.06');
  await ChartOfAccount.updateOne({ _id: sri._id }, { $set: { active: false } });
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });

  const d = await draft(clinicId, userId);
  const r = await finalize(clinicId, userId, d.declaration._id);
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /inactiva/i);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 0);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'SriDeclaration' }), 0);
  assert.equal((await SriDeclaration.findById(d.declaration._id)).status, 'DRAFT');
});

test('A3) las cuentas de rol están aisladas por clínica', async () => {
  const a = await H.seedClinic({ date: inMonth() });
  const b = await H.seedClinic({ date: inMonth() });
  const accA = await getAccount(a.clinicId, 'sriPorPagar');
  const accB = await getAccount(b.clinicId, 'sriPorPagar');
  assert.notEqual(String(accA._id), String(accB._id));
  assert.equal(String(accA.clinic), String(a.clinicId));
  assert.equal(String(accB.clinic), String(b.clinicId));
});

// ═══════════════════ 9. PERÍODOS CERRADOS ═══════════════════

test('P1) período cerrado: el borrador se puede guardar/recalcular, pero no finalizar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  await makeSale(clinicId, { baseGravada: 1000, iva: 150 });
  await makePurchase(clinicId, sup._id, { subtotal: 400, iva: 60 });
  const d = await draft(clinicId, userId);
  await FiscalPeriod.updateOne({ clinic: clinicId, year: YEAR, month: MONTH }, { $set: { status: 'CERRADO' } });

  // Guardar y recalcular NO contabilizan: se permiten.
  ok(await run(decls.update, H.mockReq(clinicId, userId, { cells: { 565: 10 } }, { params: { id: String(d.declaration._id) } })));
  ok(await run(decls.recompute, H.mockReq(clinicId, userId, {}, { params: { id: String(d.declaration._id) } })));

  // Finalizar sí: bloqueado, sin efectos.
  const r = await finalize(clinicId, userId, d.declaration._id);
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no esta abierto/i);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0);
  assert.equal(await Payable.countDocuments({ clinic: clinicId }), 0);
});
