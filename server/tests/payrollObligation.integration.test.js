/**
 * BLOQUE F — nómina proyectable.
 *
 * Verifica que el cierre use las fechas elegidas (no el día 28 fijo), abra UNA sola
 * obligación por el neto sin duplicar el crédito contable, admita pago parcial y total
 * sin doble aplicación, respete el período cerrado y revierta la obligación al reabrir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const Payroll = require('../models/Payroll');
const Payable = require('../models/Payable');
const Employee = require('../models/Employee');
const JournalEntry = require('../models/JournalEntry');
const FiscalPeriod = require('../models/FiscalPeriod');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = 2026;
const MONTH = 5;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const run = (h, req) => H.runController(h, req);
const okPayload = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** Clínica + empleado + tabla de IR (el cierre la exige si hay ingresos). */
async function seedPayrollClinic() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date(YEAR, MONTH - 1, 15) });
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: YEAR, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024,
  });
  await Employee.create({
    clinic: clinicId, code: `EMP-${Math.floor(Math.random() * 1e6)}`,
    firstName: 'Ana', lastName: 'Pérez', identificacion: `17${Math.floor(Math.random() * 1e8)}`,
    hireDate: new Date(YEAR - 2, 0, 1), baseSalary: 1000, active: true,
  });
  return { clinicId, userId };
}

async function generateAndClose(clinicId, userId, body = {}) {
  const gen = okPayload(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: YEAR, month: MONTH })));
  const closed = await run(payroll.closePayroll, H.mockReq(clinicId, userId, body, { params: { id: String(gen._id) } }));
  return { gen, closed };
}

const bal = (clinicId, code) => H.accountBalanceByCode(clinicId, code);

async function makeBank(clinicId) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  return BankAccount.create({ clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '1', chartAccount: acc._id });
}

// ─────────────────────────────────────────────────────────────────────────────
test('1) cierre con fechas elegidas: asiento en la fecha contable y UNA obligación', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const accountingDate = new Date(YEAR, MONTH - 1, 31, 12);
  const scheduled = new Date(YEAR, MONTH, 5, 12); // se paga el 5 del mes siguiente

  const { closed } = await generateAndClose(clinicId, userId, {
    accountingDate: iso(accountingDate),
    scheduledPaymentDate: iso(scheduled),
  });
  const p = okPayload(closed);
  assert.equal(p.status, 'CERRADO');
  assert.equal(iso(p.accountingDate), iso(accountingDate), 'usa la fecha contable elegida (no el día 28)');
  assert.equal(iso(p.scheduledPaymentDate), iso(scheduled));

  const entry = await JournalEntry.findById(p.journalEntry);
  assert.equal(iso(entry.date), iso(accountingDate), 'el asiento se registra en la fecha contable');
  assert.notEqual(new Date(entry.date).getDate(), 28, 'ya no se fuerza el día 28');

  // Obligación única por el neto, con el vencimiento = fecha planificada de pago.
  const cxps = await Payable.find({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxps.length, 1, 'una sola obligación');
  assert.equal(cxps[0].total, p.totalNeto);
  assert.equal(iso(cxps[0].dueDate), iso(scheduled), 'proyectable en el flujo de caja');
  assert.equal(String(p.payableRef), String(cxps[0]._id));

  // El pasivo contable lo reconoció el asiento: la CxP NO agrega un segundo crédito.
  const sueldosPorPagar = await bal(clinicId, '2.1.03.01');
  assert.equal(sueldosPorPagar, -p.totalNeto, 'Sueldos por pagar acreditado UNA vez');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) cerrar es idempotente: no duplica la obligación', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const { gen, closed } = await generateAndClose(clinicId, userId, {});
  okPayload(closed);

  // Segundo cierre: ya no es borrador.
  const again = await run(payroll.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(gen._id) } }));
  assert.equal(again.statusCode, 400);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'Payroll' }), 1);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'Payroll', sourceAction: 'CLOSE' }), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) pago parcial y luego total: aplica la obligación e impide el doble pago', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const { closed } = await generateAndClose(clinicId, userId, {});
  const p = okPayload(closed);
  const neto = p.totalNeto;
  assert.ok(neto > 0);

  // Pago parcial.
  const partial = okPayload(await run(payroll.markPaid, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: 100 }, { params: { id: String(p._id) } })));
  assert.equal(partial.status, 'CERRADO', 'con saldo pendiente sigue CERRADO');
  assert.equal(partial.payments.length, 1);
  let cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.balance, +(neto - 100).toFixed(2));
  assert.equal(cxp.status, 'PARCIAL');
  assert.equal(await bal(clinicId, '1.1.01.03'), -100, 'el banco solo pagó lo aplicado');

  // Pagar más que el saldo: rechazado.
  const excess = await run(payroll.markPaid, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: neto }, { params: { id: String(p._id) } }));
  assert.equal(excess.statusCode, 400);
  assert.match(excess.payload.message, /excede el saldo/i);

  // Pago del resto (sin `amount` = saldo pendiente).
  const full = okPayload(await run(payroll.markPaid, H.mockReq(clinicId, userId, { bankAccountId: bank._id }, { params: { id: String(p._id) } })));
  assert.equal(full.status, 'PAGADO');
  assert.equal(full.payments.length, 2);
  cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.balance, 0);
  assert.equal(cxp.status, 'PAGADO');
  assert.equal(await bal(clinicId, '1.1.01.03'), -neto, 'el banco pagó exactamente el neto');
  assert.equal(await bal(clinicId, '2.1.03.01'), 0, 'Sueldos por pagar queda liquidado');

  // Un pago extra ya no procede (sin doble aplicación).
  const extra = await run(payroll.markPaid, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: 10 }, { params: { id: String(p._id) } }));
  assert.equal(extra.statusCode, 400);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) reabrir: reversa el asiento y cancela la obligación', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const { closed } = await generateAndClose(clinicId, userId, {});
  const p = okPayload(closed);

  const reopened = okPayload(await run(payroll.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } })));
  assert.equal(reopened.status, 'BORRADOR');
  assert.equal(reopened.journalEntry, null);

  const entry = await JournalEntry.findById(p.journalEntry);
  assert.equal(entry.isReversed, true, 'el asiento de cierre quedó reversado');
  const cxp = await Payable.findOne({ clinic: clinicId, sourceModel: 'Payroll' });
  assert.equal(cxp.status, 'ANULADO', 'la obligación se canceló');
  assert.equal(await bal(clinicId, '2.1.03.01'), 0, 'Sueldos por pagar vuelve a cero');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) no se reabre un rol con pagos registrados', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const bank = await makeBank(clinicId);
  const { closed } = await generateAndClose(clinicId, userId, {});
  const p = okPayload(closed);
  okPayload(await run(payroll.markPaid, H.mockReq(clinicId, userId, { bankAccountId: bank._id, amount: 50 }, { params: { id: String(p._id) } })));

  const r = await run(payroll.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(p._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /pagos registrados/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('6) período cerrado: no se cierra el rol', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const gen = okPayload(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: YEAR, month: MONTH })));
  await FiscalPeriod.updateOne({ clinic: clinicId, year: YEAR, month: MONTH }, { $set: { status: 'CERRADO' } }, { upsert: true });

  const r = await run(payroll.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(gen._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no esta abierto/i);
  assert.equal(await Payable.countDocuments({ clinic: clinicId, sourceModel: 'Payroll' }), 0, 'sin obligación');
  assert.equal((await Payroll.findById(gen._id)).status, 'BORRADOR');
});

// ─────────────────────────────────────────────────────────────────────────────
test('7) servicio de retención en relación de dependencia (Formulario 103)', async () => {
  const { clinicId, userId } = await seedPayrollClinic();
  const { closed } = await generateAndClose(clinicId, userId, {});
  const p = okPayload(closed);

  const data = okPayload(await run(payroll.withholdingSummary, H.mockReq(clinicId, userId, {}, { query: { year: YEAR, month: MONTH } })));
  assert.equal(data.empleados.length, 1);
  const emp = data.empleados[0];
  assert.equal(emp.baseGravada, p.items[0].baseSalary, 'base = ingresos gravados del rol');
  assert.equal(emp.iessPersonal, p.items[0].iessPersonal);
  assert.equal(emp.baseImponibleNeta, +(emp.baseGravada - emp.iessPersonal).toFixed(2), 'también expone la base neta');
  assert.equal(data.total, p.items[0].impuestoRenta, 'valor retenido = IR del rol');
  // Mapeo auditable: cada rubro dice si entró y por qué no.
  assert.ok(emp.detalle.some((d) => d.rubro === 'Sueldo ganado' && d.incluido));
  assert.ok(data.excluidos.every((e) => e.motivo), 'los excluidos siempre traen motivo');

  // Un rol en BORRADOR no se declara.
  await Payroll.updateOne({ _id: p._id }, { $set: { status: 'BORRADOR' } });
  const draftData = okPayload(await run(payroll.withholdingSummary, H.mockReq(clinicId, userId, {}, { query: { year: YEAR, month: MONTH } })));
  assert.equal(draftData.total, 0);
  assert.ok(draftData.warnings.some((w) => w.code === 'NOMINA_BORRADOR_EXCLUIDA'));
});

// ─────────────────────────────────────────────────────────────────────────────
test('8) dos clínicas: la obligación de nómina no se cruza', async () => {
  const a = await seedPayrollClinic();
  const b = await seedPayrollClinic();

  const ca = okPayload((await generateAndClose(a.clinicId, a.userId, {})).closed);
  const cb = okPayload((await generateAndClose(b.clinicId, b.userId, {})).closed);

  assert.equal(await Payable.countDocuments({ clinic: a.clinicId, sourceModel: 'Payroll' }), 1);
  assert.equal(await Payable.countDocuments({ clinic: b.clinicId, sourceModel: 'Payroll' }), 1);
  assert.equal(await bal(a.clinicId, '2.1.03.01'), -ca.totalNeto);
  assert.equal(await bal(b.clinicId, '2.1.03.01'), -cb.totalNeto);

  // Pagar el rol de A desde B no es posible (no lo encuentra).
  const cross = await run(payroll.markPaid, H.mockReq(b.clinicId, b.userId, { confirmNoBank: true }, { params: { id: String(ca._id) } }));
  assert.equal(cross.statusCode, 404);
});
