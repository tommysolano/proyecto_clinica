/**
 * IDEMPOTENCIA DE PAGOS Y CONCURRENCIA DE BORRADORES/SUSTITUTIVAS.
 *
 * Cierra los dos riesgos abiertos de la auditoría:
 *   1. un pago reintentado (doble clic, reintento de red, dos peticiones en paralelo) no
 *      puede duplicar Banco, asiento ni aplicación a la CxP;
 *   2. dos borradores/sustitutivas simultáneos con CONTENIDO DISTINTO no pueden pisarse: la
 *      perdedora recibe 409, no el documento de la otra.
 *
 * Cubre además el legacy de nómina: si el rol tiene CxP, su saldo manda sobre el estado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const decls = require('../controllers/taxDeclarationController');
const payrollCtrl = require('../controllers/payrollController');
const payments = require('../controllers/paymentController');
const purchases = require('../controllers/purchaseInvoiceController');
const SriDeclaration = require('../models/SriDeclaration');
const Invoice = require('../models/Invoice');
const Payroll = require('../models/Payroll');
const Payable = require('../models/Payable');
const Payment = require('../models/Payment');
const JournalEntry = require('../models/JournalEntry');
const BankTransaction = require('../models/BankTransaction');
const BankAccount = require('../models/BankAccount');
const ChartOfAccount = require('../models/ChartOfAccount');
const Employee = require('../models/Employee');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = 2026;
const MONTH = 5;
const inM = (month, day = 15) => new Date(YEAR, month - 1, day, 12, 0, 0);
const inMonth = (day = 15) => inM(MONTH, day);
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const bal = (clinicId, code) => H.accountBalanceByCode(clinicId, code);
const settled = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { statusCode: 500, payload: { message: String(r.reason?.message) } }));

/** req con la clave de idempotencia en el HEADER (la vía preferida). */
const reqWithKey = (clinicId, userId, body, key, extra = {}) =>
  H.mockReq(clinicId, userId, body, { ...extra, headers: { 'idempotency-key': key } });

let seq = 0;
async function makeSale(clinicId, { baseGravada = 1000, iva = 150, month = MONTH } = {}) {
  seq += 1;
  return Invoice.create({
    clinic: clinicId,
    claveAcceso: `CLV${Date.now()}${seq}${Math.floor(Math.random() * 1e6)}`,
    secuencial: String(seq).padStart(9, '0'),
    estab: '001', ptoEmi: '001', ambiente: '1',
    fechaEmision: dmy(inM(month)), estado: 'AUTORIZADO',
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: baseGravada, totalImpuesto: iva, importeTotal: baseGravada + iva,
    taxBreakdown: { computed: true, base0: 0, baseGravada, baseExento: 0, baseNoObjeto: 0, iva },
  });
}

async function makeBank(clinicId) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  return BankAccount.create({ clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '1', chartAccount: acc._id });
}

async function seedPayrollClinic() {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await PayrollIncomeTaxTable.create({ clinic: clinicId, year: YEAR, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
  await Employee.create({
    clinic: clinicId, code: `EMP-${Math.floor(Math.random() * 1e6)}`,
    firstName: 'Ana', lastName: 'Pérez', identificacion: `17${Math.floor(Math.random() * 1e8)}`,
    hireDate: new Date(YEAR - 2, 0, 1), baseSalary: 1000, active: true,
  });
  return { clinicId, userId };
}
async function closedPayroll(clinicId, userId, month = MONTH) {
  const gen = ok(await run(payrollCtrl.generatePayroll, H.mockReq(clinicId, userId, { year: YEAR, month })));
  return ok(await run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(gen._id) } })));
}

/** Declaración 104 finalizada con obligación de 150. */
async function finalized104(clinicId, userId, month = MONTH) {
  await makeSale(clinicId, { month });
  const d = ok(await run(decls.draft, H.mockReq(clinicId, userId, { formType: '104', year: YEAR, month })));
  return ok(await run(decls.finalize, H.mockReq(clinicId, userId, {}, { params: { id: String(d.declaration._id) } }))).declaration;
}

/** CxP de compra (una por serie) para el endpoint genérico de pagos. */
async function purchasePayable(clinicId, userId, serie, total = 100) {
  const sup = await H.makeSupplier(clinicId);
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const pi = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: inMonth(), serie,
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: total, ivaRate: 0, subtotal: total }],
  })));
  return { pi, sup };
}

/**
 * Ciega las N primeras lecturas de la clave de idempotencia de un modelo para forzar que la
 * colisión aflore en el ÍNDICE ÚNICO (E11000) y no en el chequeo previo. Simula la carrera
 * real: la petición perdedora lee ANTES de que la ganadora committee. La lectura del catch
 * NO se ciega: debe encontrar al dueño real de la clave.
 */
function blindKeyReads(Model, field = 'payments.idempotencyKey', times = 2) {
  const original = Model.findOne.bind(Model);
  let reads = 0;
  const nullQuery = () => ({ session: () => nullQuery(), then: (resolve) => resolve(null) });
  Model.findOne = function patched(filter, ...rest) {
    if (reads < times && filter && filter[field] !== undefined) {
      reads += 1;
      return nullQuery();
    }
    return original(filter, ...rest);
  };
  return () => { Model.findOne = original; };
}

// ═════════════════ BLOQUE 1 · IDEMPOTENCIA DE PAGOS (NÓMINA) ═════════════════

test('P1) nómina: misma clave + mismo contenido ⇒ replay, sin duplicar banco ni aplicación', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closedPayroll(clinicId, userId);
  const body = { bankAccountId: String(bank._id), amount: 100, date: '2026-05-20' };

  const first = ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-N1', { params: { id: String(p._id) } })));
  assert.equal(first.payments.length, 1);
  assert.ok(!first.idempotentReplay);

  // Reintento exacto (doble clic / red).
  const replay = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-N1', { params: { id: String(p._id) } }));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true, 'se marca como operación idempotente');
  assert.equal(replay.payload.payments.length, 1, 'un solo registro de pago');

  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^PAY/ }), 1, 'un solo asiento');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1, 'un solo movimiento bancario');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, 100, 'la CxP se redujo UNA sola vez');
  assert.equal(await bal(clinicId, '1.1.01.03'), -100, 'el banco se movió una sola vez');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('P2) nómina: misma clave + contenido DIFERENTE ⇒ 409 y nada cambia', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closedPayroll(clinicId, userId);
  ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, { bankAccountId: String(bank._id), amount: 100 }, 'PAY-N2', { params: { id: String(p._id) } })));

  for (const distinto of [
    { bankAccountId: String(bank._id), amount: 150 },              // otro importe
    { bankAccountId: String(bank._id), amount: 100, date: '2026-05-21' }, // otra fecha
    { confirmNoBank: true, amount: 100 },                          // otro medio de pago
  ]) {
    const r = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, distinto, 'PAY-N2', { params: { id: String(p._id) } }));
    assert.equal(r.statusCode, 409, `debe ser conflicto: ${JSON.stringify(distinto)}`);
    assert.match(r.payload.message, /clave de idempotencia ya fue utilizada/i);
  }

  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, 100, 'la CxP no se tocó');
  assert.equal((await Payroll.findById(p._id)).payments.length, 1);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1);
});

test('P3) nómina: claves DISTINTAS ⇒ dos pagos reales, aunque sean del mismo importe', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closedPayroll(clinicId, userId);
  const body = { bankAccountId: String(bank._id), amount: 100 };

  ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-A', { params: { id: String(p._id) } })));
  const second = ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-B', { params: { id: String(p._id) } })));

  assert.equal(second.payments.length, 2, 'dos pagos de 100 en momentos distintos SÍ se registran');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, 200);
  assert.equal(await bal(clinicId, '1.1.01.03'), -200);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 2);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('P4) nómina: dos pagos parciales SIMULTÁNEOS con la misma clave ⇒ uno solo', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closedPayroll(clinicId, userId);
  const body = { bankAccountId: String(bank._id), amount: 100 };

  const rs = settled(await Promise.allSettled([
    run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-CC', { params: { id: String(p._id) } })),
    run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-CC', { params: { id: String(p._id) } })),
  ]));

  assert.ok(rs.every((r) => r.statusCode === 200), `ambas respuestas controladas: ${JSON.stringify(rs.map((r) => r.payload?.message))}`);
  assert.ok(rs.every((r) => !/E11000|duplicate key/i.test(r.payload?.message || '')), 'ninguna respuesta E11000 cruda');

  const roll = await Payroll.findById(p._id);
  assert.equal(roll.payments.length, 1, 'un solo registro de pago en payments[]');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^PAY/ }), 1, 'un solo asiento');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1, 'un solo movimiento bancario');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.applied, 100, 'la CxP disminuyó una sola vez');
  assert.equal(await bal(clinicId, '1.1.01.03'), -100);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('P5) nómina: un fallo intermedio revierte todo y la clave queda libre para reintentar', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const p = await closedPayroll(clinicId, userId);
  const body = { bankAccountId: String(bank._id), amount: 100 };

  const original = BankTransaction.create;
  BankTransaction.create = () => { throw new Error('fallo simulado del libro de bancos'); };
  let r;
  try {
    r = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-ROLLBACK', { params: { id: String(p._id) } }));
  } finally {
    BankTransaction.create = original;
  }
  assert.ok(r.statusCode >= 400);

  const roll = await Payroll.findById(p._id);
  assert.equal(roll.payments.length, 0, 'la clave NO quedó registrada a medias');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' })).applied, 0);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^PAY/ }), 0);

  // El reintento con la MISMA clave ahora sí procede (no quedó bloqueada).
  const retry = ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'PAY-ROLLBACK', { params: { id: String(p._id) } })));
  assert.equal(retry.payments.length, 1);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' })).applied, 100);
});

// ═════════════════ BLOQUE 1 · IDEMPOTENCIA DE PAGOS (DECLARACIÓN) ═════════════════

test('D1) declaración: replay, 409 por contenido distinto y pagos simultáneos con la misma clave', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const bank = await makeBank(clinicId);
  const decl = await finalized104(clinicId, userId);
  const params = { params: { id: String(decl._id) } };
  const body = { bankAccountId: String(bank._id), amount: 50 };

  // Replay.
  ok(await run(decls.pay, reqWithKey(clinicId, userId, body, 'SRI-1', params)));
  const replay = await run(decls.pay, reqWithKey(clinicId, userId, body, 'SRI-1', params));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(replay.payload.declaration.payments.length, 1);
  assert.equal(replay.payload.obligacion.applied, 50, 'la CxP se aplicó una sola vez');

  // Misma clave, otro importe ⇒ 409.
  const conflicto = await run(decls.pay, reqWithKey(clinicId, userId, { ...body, amount: 60 }, 'SRI-1', params));
  assert.equal(conflicto.statusCode, 409);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' })).applied, 50, 'nada cambió');

  // Simultáneos con la misma clave nueva ⇒ un solo pago.
  const rs = settled(await Promise.allSettled([
    run(decls.pay, reqWithKey(clinicId, userId, { ...body, amount: 30 }, 'SRI-2', params)),
    run(decls.pay, reqWithKey(clinicId, userId, { ...body, amount: 30 }, 'SRI-2', params)),
  ]));
  assert.ok(rs.every((r) => r.statusCode === 200), JSON.stringify(rs.map((r) => r.payload?.message)));
  const declFinal = await SriDeclaration.findById(decl._id);
  assert.equal(declFinal.payments.length, 2, 'el pago concurrente se registró una sola vez (50 + 30)');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' });
  assert.equal(cxp.applied, 80);
  assert.equal(await bal(clinicId, '1.1.01.03'), -80, 'el banco se movió exactamente 80');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 2);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ═════════════════ BLOQUE 1 · ENDPOINT GENÉRICO DE PAGOS ═════════════════

test('G1) pago genérico de CxP: misma clave + contenido distinto ⇒ 409 (antes devolvía otro pago)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const sup = await H.makeSupplier(clinicId);
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const pi = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: inMonth(), serie: '001-001-000000501',
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100 }],
  })));

  const base = {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: String(sup._id), partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 60 }],
  };
  const first = await run(payments.create, reqWithKey(clinicId, userId, base, 'GEN-1'));
  assert.equal(first.statusCode, 201);

  // Mismo contenido ⇒ replay (comportamiento previo, preservado).
  const replay = await run(payments.create, reqWithKey(clinicId, userId, base, 'GEN-1'));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);

  // Contenido distinto con la misma clave ⇒ 409 (ya no devuelve el pago que no corresponde).
  const otro = { ...base, applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 40 }] };
  const conflicto = await run(payments.create, reqWithKey(clinicId, userId, otro, 'GEN-1'));
  assert.equal(conflicto.statusCode, 409);
  assert.match(conflicto.payload.message, /clave de idempotencia ya fue utilizada/i);

  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 1, 'un solo pago');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice' })).applied, 60);
});

// ═════════════════ BLOQUE 2 · BORRADORES Y SUSTITUTIVAS CONCURRENTES ═════════════════

const draftReq = (clinicId, userId, body = {}) =>
  H.mockReq(clinicId, userId, { formType: '104', year: YEAR, month: MONTH, ...body });

test('B1) dos borradores IGUALES en paralelo ⇒ uno solo, respuesta idempotente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId);

  const rs = settled(await Promise.allSettled([
    run(decls.draft, draftReq(clinicId, userId)),
    run(decls.draft, draftReq(clinicId, userId)),
  ]));
  assert.ok(rs.every((r) => r.statusCode === 200), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1);
  assert.ok(rs.some((r) => r.payload.idempotentReplay), 'la perdedora recibe el borrador existente marcado como idempotente');
});

test('B2) dos borradores con CASILLERO EDITABLE distinto ⇒ la perdedora recibe 409', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId);
  const sup = await H.makeSupplier(clinicId);

  const rs = settled(await Promise.allSettled([
    run(decls.draft, draftReq(clinicId, userId, { cells: { 605: 10 } })),
    run(decls.draft, draftReq(clinicId, userId, { cells: { 605: 99 } })),
  ]));
  const okCount = rs.filter((r) => r.statusCode === 200).length;
  const conflictCount = rs.filter((r) => r.statusCode === 409).length;
  assert.equal(okCount, 1, 'solo una gana');
  assert.equal(conflictCount, 1, 'la otra recibe 409 y NO el borrador ajeno');
  const perdedora = rs.find((r) => r.statusCode === 409);
  assert.match(perdedora.payload.message, /contenido DIFERENTE/i);

  const drafts = await SriDeclaration.find({ clinic: clinicId });
  assert.equal(drafts.length, 1, 'no se sobrescribió el ganador');
  const cells = drafts[0].editableCells.find((c) => c.box === '605');
  assert.ok([10, 99].includes(cells.value), 'el borrador conserva el valor de la ganadora');
});

test('B3) dos borradores con FECHA PLANIFICADA distinta ⇒ 409 para la perdedora', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId);

  const rs = settled(await Promise.allSettled([
    run(decls.draft, draftReq(clinicId, userId, { plannedPaymentDate: '2026-06-10' })),
    run(decls.draft, draftReq(clinicId, userId, { plannedPaymentDate: '2026-06-20' })),
  ]));
  assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(rs.filter((r) => r.statusCode === 409).length, 1);
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1);
});

test('B4) colisión que sale del ÍNDICE ÚNICO (no del chequeo previo): equivalente ⇒ replay, distinta ⇒ 409', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  await makeSale(clinicId);
  ok(await run(decls.draft, draftReq(clinicId, userId, { cells: { 605: 10 } })));

  // Se simula la carrera real: la petición perdedora hace sus lecturas ANTES de que la
  // ganadora committee, así que no ve nada y llega al save con los mismos datos derivados
  // (versión 1). La colisión aflora entonces en el ÍNDICE ÚNICO (E11000), no en el chequeo
  // previo. Se ocultan solo las 2 lecturas iniciales de `draft`; la del catch debe ver al
  // ganador.
  const originalFindOne = SriDeclaration.findOne.bind(SriDeclaration);
  const blindFirstTwoReads = () => {
    let reads = 0;
    SriDeclaration.findOne = function patched(filter, ...rest) {
      if (reads < 2 && filter && filter.periodKey) {
        reads += 1;
        return filter.status === 'DRAFT'
          ? { then: (resolve) => resolve(null) }                       // borrador existente
          : { sort: () => ({ then: (resolve) => resolve(null) }) };    // última versión
      }
      return originalFindOne(filter, ...rest);
    };
  };

  let equivalente;
  let diferente;
  try {
    blindFirstTwoReads();
    equivalente = await run(decls.draft, draftReq(clinicId, userId, { cells: { 605: 10 } }));
    blindFirstTwoReads();
    diferente = await run(decls.draft, draftReq(clinicId, userId, { cells: { 605: 77 } }));
  } finally {
    SriDeclaration.findOne = originalFindOne;
  }

  assert.equal(equivalente.statusCode, 200, 'huella igual ⇒ se devuelve el existente');
  assert.equal(equivalente.payload.idempotentReplay, true);
  assert.ok(!/E11000|duplicate key/i.test(equivalente.payload?.message || ''));
  assert.equal(diferente.statusCode, 409, 'huella distinta ⇒ conflicto, sin E11000 crudo');
  assert.match(diferente.payload.message, /contenido DIFERENTE/i);
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId }), 1);
});

test('B5) sustitutivas: iguales ⇒ una sola; con valores o fecha contable distintos ⇒ 409', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const v1 = await finalized104(clinicId, userId);
  const params = { params: { id: String(v1._id) } };

  // Iguales en paralelo ⇒ una sola sustitutiva.
  const iguales = settled(await Promise.allSettled([
    run(decls.substitute, H.mockReq(clinicId, userId, {}, params)),
    run(decls.substitute, H.mockReq(clinicId, userId, {}, params)),
  ]));
  assert.ok(iguales.every((r) => r.statusCode === 200), JSON.stringify(iguales.map((r) => r.payload?.message)));
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId, status: 'DRAFT' }), 1);

  // Con valores distintos sobre la sustitutiva ya existente ⇒ 409 (no la pisa).
  const distintoValor = await run(decls.substitute, H.mockReq(clinicId, userId, { cells: { 605: 55 } }, params));
  assert.equal(distintoValor.statusCode, 409);
  assert.match(distintoValor.payload.message, /contenido DIFERENTE/i);

  // Con fecha contable distinta ⇒ 409.
  const distintaFecha = await run(decls.substitute, H.mockReq(clinicId, userId, { accountingDate: '2026-06-30' }, params));
  assert.equal(distintaFecha.statusCode, 409);

  const drafts = await SriDeclaration.find({ clinic: clinicId, status: 'DRAFT' });
  assert.equal(drafts.length, 1, 'la sustitutiva ganadora no se sobrescribió');
  assert.equal(drafts[0].version, 2);
});

test('B6) sustitutivas con distinta fecha contable EN PARALELO ⇒ una gana, la otra 409', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const v1 = await finalized104(clinicId, userId);
  const params = { params: { id: String(v1._id) } };

  const rs = settled(await Promise.allSettled([
    run(decls.substitute, H.mockReq(clinicId, userId, { accountingDate: '2026-06-15' }, params)),
    run(decls.substitute, H.mockReq(clinicId, userId, { accountingDate: '2026-07-15' }, params)),
  ]));
  assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(rs.filter((r) => r.statusCode === 409).length, 1);
  assert.equal(await SriDeclaration.countDocuments({ clinic: clinicId, status: 'DRAFT' }), 1);
});

test('B7) dos clínicas con la MISMA huella y la misma clave no interfieren', async () => {
  const a = await H.seedClinic({ date: inMonth() });
  const b = await H.seedClinic({ date: inMonth() });
  await makeSale(a.clinicId);
  await makeSale(b.clinicId);

  // Mismo borrador (misma huella salvo la clínica) en ambas: las dos lo crean.
  const [ra, rb] = settled(await Promise.allSettled([
    run(decls.draft, draftReq(a.clinicId, a.userId, { cells: { 605: 10 } })),
    run(decls.draft, draftReq(b.clinicId, b.userId, { cells: { 605: 10 } })),
  ]));
  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 200);
  assert.equal(await SriDeclaration.countDocuments({ clinic: a.clinicId }), 1);
  assert.equal(await SriDeclaration.countDocuments({ clinic: b.clinicId }), 1);

  // La misma CLAVE de pago en ambas clínicas también convive.
  const bankA = await makeBank(a.clinicId);
  const bankB = await makeBank(b.clinicId);
  const pa = await Payroll.create({ clinic: a.clinicId, year: YEAR, month: MONTH, period: `${YEAR}-05`, status: 'CERRADO', totalNeto: 0 });
  assert.ok(pa);
  const declA = await finalized104(a.clinicId, a.userId).catch(() => null);
  const declB = await finalized104(b.clinicId, b.userId).catch(() => null);
  if (declA && declB) {
    const r1 = await run(decls.pay, reqWithKey(a.clinicId, a.userId, { bankAccountId: String(bankA._id), amount: 10 }, 'SAME-KEY', { params: { id: String(declA._id) } }));
    const r2 = await run(decls.pay, reqWithKey(b.clinicId, b.userId, { bankAccountId: String(bankB._id), amount: 10 }, 'SAME-KEY', { params: { id: String(declB._id) } }));
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200, 'la misma clave en otra clínica no colisiona');
    assert.equal((await Payable.findOne({ clinic: a.clinicId, sourceModel: 'SriDeclaration' })).applied, 10);
    assert.equal((await Payable.findOne({ clinic: b.clinicId, sourceModel: 'SriDeclaration' })).applied, 10);
  }
});

// ═════════════════ BLOQUE 3 · LEGACY DE NÓMINA ═════════════════

test('L1) rol legacy PAGADO cuya CxP todavía tiene saldo: manda la CxP, no el estado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const cuenta = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.03.01' });
  const roll = await Payroll.create({
    clinic: clinicId, year: YEAR, month: MONTH, period: `${YEAR}-05`,
    status: 'PAGADO', totalNeto: 900, payments: [], // legacy: sin pagos registrados
  });
  const cxp = await Payable.create({
    clinic: clinicId, party: { model: 'Employee', ref: null, name: 'Empleados' },
    sourceModel: 'Payroll', sourceRef: roll._id, docType: 'OTRO',
    issueDate: inMonth(), total: 900, applied: 300, account: cuenta._id,
  });
  await Payroll.updateOne({ _id: roll._id }, { $set: { payableRef: cxp._id } });

  const r = ok(await run(payrollCtrl.getPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(roll._id) } })));
  assert.equal(r.pendingAmount, 600, 'muestra el saldo REAL de la CxP (900 − 300), no cero');
  assert.equal(r.paidAmount, 300);
  assert.equal(r.obligacion.balance, 600);
  assert.equal(r.obligacion.status, 'PARCIAL');
});

test('L2) rol legacy PAGADO sin CxP ni pagos: se usa el estado como fallback documentado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const roll = await Payroll.create({
    clinic: clinicId, year: YEAR, month: MONTH, period: `${YEAR}-05`,
    status: 'PAGADO', totalNeto: 900, payments: [], payableRef: null,
  });

  const r = ok(await run(payrollCtrl.getPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(roll._id) } })));
  assert.equal(r.obligacion, null, 'no hay cartera de la que tirar');
  assert.equal(r.paidAmount, 900, 'fallback legacy: el estado PAGADO indica el neto pagado');
  assert.equal(r.pendingAmount, 0);
});

// ═════════════ BLOQUE 4 · LA CLAVE NO PUEDE CRUZAR DE OBLIGACIÓN ═════════════
//
// El índice único de la clave es POR CLÍNICA, no por obligación. Reutilizar una clave contra
// OTRA obligación tiene que dar 409: nunca puede reproducir (devolver) el pago ajeno, ni
// reventar con un E11000 crudo, ni registrar el pago dos veces.

test('X1) nómina: la misma clave en OTRO rol ⇒ 409, jamás el pago del primer rol', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const rolA = await closedPayroll(clinicId, userId, MONTH);
  const rolB = await closedPayroll(clinicId, userId, MONTH + 1);
  // Contenido IDÉNTICO salvo el destino: mismo importe, misma fecha, mismo banco.
  const body = { bankAccountId: String(bank._id), amount: 100, date: '2026-05-20' };

  const pagoA = ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'X-CRUCE', { params: { id: String(rolA._id) } })));
  assert.equal(pagoA.payments.length, 1);

  const r = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'X-CRUCE', { params: { id: String(rolB._id) } }));
  assert.equal(r.statusCode, 409, 'la clave de otra obligación es un conflicto');
  assert.match(r.payload.message, /OTRA obligación/i);
  assert.ok(!r.payload.payments, 'no devuelve el pago del rol A disfrazado de pago del rol B');
  assert.ok(!/E11000|duplicate key/i.test(r.payload.message), 'sin E11000 crudo');

  // El rol B quedó intacto y no hubo un segundo movimiento de banco.
  const b = await Payroll.findById(rolB._id);
  assert.equal(b.payments.length, 0, 'el rol B no registró pago');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: rolB._id })).applied, 0);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1, 'un solo movimiento bancario en toda la clínica');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: /^PAY/ }), 1);

  // Caso 4: la MISMA clave sobre su PROPIA obligación sigue siendo replay.
  const replay = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'X-CRUCE', { params: { id: String(rolA._id) } }));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(replay.payload.payments.length, 1);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: rolA._id })).applied, 100);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('X1b) nómina: si la colisión aflora en el ÍNDICE ÚNICO (no en el chequeo previo) ⇒ 409 igual', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const rolA = await closedPayroll(clinicId, userId, MONTH);
  const rolB = await closedPayroll(clinicId, userId, MONTH + 1);
  const body = { bankAccountId: String(bank._id), amount: 100, date: '2026-05-20' };
  ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'X-IDX', { params: { id: String(rolA._id) } })));

  // El rol B no ve la clave del rol A en ninguna de sus 2 lecturas previas → llega al save y
  // choca contra el índice único de la clínica.
  const restore = blindKeyReads(Payroll);
  let r;
  try {
    r = await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, body, 'X-IDX', { params: { id: String(rolB._id) } }));
  } finally { restore(); }

  assert.equal(r.statusCode, 409, 'el E11000 entre documentos se traduce a 409');
  assert.match(r.payload.message, /OTRA obligación/i);
  assert.ok(!/E11000|duplicate key/i.test(r.payload.message));
  assert.equal((await Payroll.findById(rolB._id)).payments.length, 0, 'la transacción del rol B se revirtió entera');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: rolB._id })).applied, 0);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1);
  assert.equal(await bal(clinicId, '1.1.01.03'), -100, 'el banco solo se movió por el rol A');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('X2) declaración: la misma clave en OTRA declaración ⇒ 409 (chequeo previo e índice único)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const bank = await makeBank(clinicId);
  const declA = await finalized104(clinicId, userId, MONTH);
  const declB = await finalized104(clinicId, userId, MONTH + 1);
  const body = { bankAccountId: String(bank._id), amount: 50, date: '2026-06-10' };

  ok(await run(decls.pay, reqWithKey(clinicId, userId, body, 'X-SRI', { params: { id: String(declA._id) } })));

  // (a) Chequeo previo.
  const r = await run(decls.pay, reqWithKey(clinicId, userId, body, 'X-SRI', { params: { id: String(declB._id) } }));
  assert.equal(r.statusCode, 409);
  assert.match(r.payload.message, /OTRA obligación/i);
  assert.ok(!r.payload.declaration, 'no devuelve la declaración A');

  // (b) La misma colisión, pero aflorando en el índice único.
  const restore = blindKeyReads(SriDeclaration);
  let porIndice;
  try {
    porIndice = await run(decls.pay, reqWithKey(clinicId, userId, body, 'X-SRI', { params: { id: String(declB._id) } }));
  } finally { restore(); }
  assert.equal(porIndice.statusCode, 409);
  assert.ok(!/E11000|duplicate key/i.test(porIndice.payload.message));

  assert.equal((await SriDeclaration.findById(declB._id)).payments.length, 0, 'la declaración B no registró pago');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration', sourceRef: declB._id })).applied, 0);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration', sourceRef: declA._id })).applied, 50);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId }), 1);

  // La clave sigue funcionando como replay sobre SU declaración.
  const replay = await run(decls.pay, reqWithKey(clinicId, userId, body, 'X-SRI', { params: { id: String(declA._id) } }));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(replay.payload.declaration.payments.length, 1);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('X3) CxP genérica: la misma clave contra OTRA factura ⇒ 409 (chequeo previo e índice único)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: inMonth() });
  const a = await purchasePayable(clinicId, userId, '001-001-000000601');
  const b = await purchasePayable(clinicId, userId, '001-001-000000602');
  const pagoDe = (target, sup) => ({
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: String(sup._id), partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(target._id), amount: 60 }],
  });

  const first = await run(payments.create, reqWithKey(clinicId, userId, pagoDe(a.pi, a.sup), 'X-CXP'));
  assert.equal(first.statusCode, 201);

  // (a) Chequeo previo: la clave ya está en un pago aplicado a OTRA factura.
  const r = await run(payments.create, reqWithKey(clinicId, userId, pagoDe(b.pi, b.sup), 'X-CXP'));
  assert.equal(r.statusCode, 409);
  assert.ok(!r.payload.number, 'no devuelve el pago de la factura A');

  // (b) La misma colisión aflorando en el índice único (clinic + idempotencyKey).
  const restore = blindKeyReads(Payment, 'idempotencyKey', 1);
  let porIndice;
  try {
    porIndice = await run(payments.create, reqWithKey(clinicId, userId, pagoDe(b.pi, b.sup), 'X-CXP'));
  } finally { restore(); }
  assert.equal(porIndice.statusCode, 409);
  assert.ok(!/E11000|duplicate key/i.test(porIndice.payload.message), 'sin E11000 crudo');

  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 1, 'un solo pago en la clínica');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: a.pi._id })).applied, 60);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: b.pi._id })).applied, 0, 'la factura B no se pagó');

  // Replay sobre su propia factura: sigue funcionando.
  const replay = await run(payments.create, reqWithKey(clinicId, userId, pagoDe(a.pi, a.sup), 'X-CXP'));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 1);
});

test('X5) dos clínicas pueden usar la MISMA clave sobre sus propios roles sin interferir', async () => {
  const a = await seedPayrollClinic();
  const b = await seedPayrollClinic();
  const bankA = await makeBank(a.clinicId);
  const bankB = await makeBank(b.clinicId);
  const rolA = await closedPayroll(a.clinicId, a.userId);
  const rolB = await closedPayroll(b.clinicId, b.userId);

  const ra = ok(await run(payrollCtrl.markPaid, reqWithKey(a.clinicId, a.userId, { bankAccountId: String(bankA._id), amount: 100 }, 'MISMA-CLAVE', { params: { id: String(rolA._id) } })));
  const rb = ok(await run(payrollCtrl.markPaid, reqWithKey(b.clinicId, b.userId, { bankAccountId: String(bankB._id), amount: 100 }, 'MISMA-CLAVE', { params: { id: String(rolB._id) } })));

  assert.ok(!ra.idempotentReplay && !rb.idempotentReplay, 'ninguno es replay del otro: son pagos reales distintos');
  assert.equal((await Payroll.findById(rolA._id)).payments.length, 1);
  assert.equal((await Payroll.findById(rolB._id)).payments.length, 1);
  assert.equal((await Payable.findOne({ clinic: a.clinicId, sourceModel: 'Payroll' })).applied, 100);
  assert.equal((await Payable.findOne({ clinic: b.clinicId, sourceModel: 'Payroll' })).applied, 100);
  assert.equal(await bal(a.clinicId, '1.1.01.03'), -100);
  assert.equal(await bal(b.clinicId, '1.1.01.03'), -100);
});

test('X6) la misma clave en operaciones de DISTINTO TIPO no produce replay cruzado', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const rol = await closedPayroll(clinicId, userId);
  const decl = await finalized104(clinicId, userId);
  const { pi, sup } = await purchasePayable(clinicId, userId, '001-001-000000701');
  const KEY = 'MISMA-CLAVE-OTRO-TIPO';

  const pagoRol = ok(await run(payrollCtrl.markPaid, reqWithKey(clinicId, userId, { bankAccountId: String(bank._id), amount: 100 }, KEY, { params: { id: String(rol._id) } })));
  const pagoDecl = ok(await run(decls.pay, reqWithKey(clinicId, userId, { bankAccountId: String(bank._id), amount: 50 }, KEY, { params: { id: String(decl._id) } })));
  const pagoCxp = await run(payments.create, reqWithKey(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: String(sup._id), partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 60 }],
  }, KEY));

  // Cada operación es de un tipo distinto (huella distinta, colección distinta): ninguna
  // devuelve el resultado de otra ni se marca como replay.
  assert.ok(!pagoRol.idempotentReplay);
  assert.ok(!pagoDecl.idempotentReplay);
  assert.equal(pagoCxp.statusCode, 201, 'el cobro/pago genérico se crea, no hace replay del pago de nómina');
  assert.ok(!pagoCxp.payload.idempotentReplay);

  assert.ok(pagoRol.payments, 'la respuesta del rol es un rol');
  assert.ok(pagoDecl.declaration, 'la respuesta de la declaración es una declaración');
  assert.equal(pagoDecl.declaration.payments.length, 1);
  assert.equal(pagoCxp.payload.type, 'PAGO');

  // Cada obligación se aplicó por su cuenta, exactamente una vez.
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' })).applied, 100);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceModel: 'SriDeclaration' })).applied, 50);
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: pi._id })).applied, 60);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});
