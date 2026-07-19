/**
 * CONFIGURACIÓN CONTABLE DE NÓMINA POR CONCEPTO × DEPARTAMENTO (revisión de la contadora).
 * Sobre los controllers reales:
 *  - cada valor del rol se carga a la cuenta del CONCEPTO según el DEPARTAMENTO del empleado
 *    (Sueldo y Alimentación en Administrativo vs Costos → cuentas distintas);
 *  - HERENCIA: si el departamento no define su override, se usa la cuenta general del concepto;
 *  - las provisiones y el asiento completo cuadran (debe = haber);
 *  - el cruce con el Formulario 103: base 302 = ingresos gravados − IESS personal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConcept = require('../models/PayrollConcept');
const Employee = require('../models/Employee');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const JournalEntry = require('../models/JournalEntry');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');
const { payrollWithholdingForPeriod } = require('../utils/payrollWithholding');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const req = (clinicId, userId, body = {}, extra = {}) => H.mockReq(clinicId, userId, body, extra);
const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.payload)); return r.payload; };
const r2 = (n) => +(Number(n) || 0).toFixed(2);

async function mkAcc(clinicId, code, name, type) {
  const nature = (type === 'PASIVO' || type === 'PATRIMONIO' || type === 'INGRESO') ? 'CREDITO' : 'DEBITO';
  return ChartOfAccount.create({ clinic: clinicId, code, name, type, nature, level: 3, allowsMovement: true });
}
async function acc(clinicId, code) { return ChartOfAccount.findOne({ clinic: clinicId, code }); }
async function concept(clinicId, code) { return PayrollConcept.findOne({ clinic: clinicId, code }); }

let seq = 0;
async function makeEmployee(clinicId, o = {}) {
  seq += 1;
  return Employee.create({
    clinic: clinicId, code: o.code || `EMP-${seq}`, identificacion: o.identificacion || `172000${String(seq).padStart(4, '0')}`,
    firstName: o.firstName || 'Juan', lastName: o.lastName || 'Pérez',
    hireDate: o.hireDate || new Date('2026-01-01'), baseSalary: o.baseSalary ?? 800,
    paymentFrequency: 'MENSUAL',
    // Sin décimos ni fondos: aísla las cuentas de sueldo/alimentación en las aserciones.
    receivesDecimoTercero: false, receivesDecimoCuarto: false, receivesFondosReserva: false,
    fondosReservaModeSet: true,
    ...o,
  });
}

test('cada valor cae en la cuenta de su departamento; herencia; provisiones cuadran; cruce 103', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });

  // Cuentas específicas por departamento (Admin=gasto, Costos=costo) para Sueldo y Alimentación,
  // más una cuenta GENERAL de Transporte (sin override de depto → prueba la herencia).
  await mkAcc(clinicId, '6.1.90', 'Sueldos Administrativo', 'GASTO');
  await mkAcc(clinicId, '5.1.90', 'Sueldos Costos', 'COSTO');
  await mkAcc(clinicId, '6.1.91', 'Alimentación Administrativo', 'GASTO');
  await mkAcc(clinicId, '5.1.91', 'Alimentación Costos', 'COSTO');
  await mkAcc(clinicId, '6.1.92', 'Transporte (general)', 'GASTO');

  // Departamentos con su cuenta de sueldos base (obligatoria en el posteo).
  const admin = await PayrollDepartment.create({
    clinic: clinicId, name: 'Administración', type: 'ADMINISTRATIVO',
    accounts: { sueldos: (await acc(clinicId, '6.1.01'))._id },
  });
  const costos = await PayrollDepartment.create({
    clinic: clinicId, name: 'Producción', type: 'COSTOS',
    accounts: { sueldos: (await acc(clinicId, '5.1.01'))._id },
  });

  // Catálogo estándar de conceptos (idempotente) y mapeo de cuentas por depto.
  ok(await H.runController(payroll.seedConcepts, req(clinicId, userId)));
  const sueldo = await concept(clinicId, 'ING-SUELDO');
  const alim = await concept(clinicId, 'ING-ALIMENTACION');
  const transp = await concept(clinicId, 'ING-TRANSPORTE');

  // Sueldo: cuenta por departamento (sin cuenta general → obliga a resolver por depto).
  ok(await H.runController(payroll.updateConcept, req(clinicId, userId, {
    deptAccounts: [
      { department: String(admin._id), account: String((await acc(clinicId, '6.1.90'))._id) },
      { department: String(costos._id), account: String((await acc(clinicId, '5.1.90'))._id) },
    ],
  }, { params: { id: String(sueldo._id) } })));
  // Alimentación: cuenta por departamento.
  ok(await H.runController(payroll.updateConcept, req(clinicId, userId, {
    deptAccounts: [
      { department: String(admin._id), account: String((await acc(clinicId, '6.1.91'))._id) },
      { department: String(costos._id), account: String((await acc(clinicId, '5.1.91'))._id) },
    ],
  }, { params: { id: String(alim._id) } })));
  // Transporte: SOLO cuenta general (sin override) → prueba la herencia.
  ok(await H.runController(payroll.updateConcept, req(clinicId, userId, {
    defaultAccount: String((await acc(clinicId, '6.1.92'))._id), deptAccounts: [],
  }, { params: { id: String(transp._id) } })));

  // Empleados: Admin (sueldo 800 + alimentación 50 + transporte 30) y Costos (sueldo 700 + alimentación 40).
  await makeEmployee(clinicId, {
    firstName: 'Ana', departmentRef: admin._id, baseSalary: 800,
    fixedIncomes: [
      { concepto: 'Alimentación', monto: 50, aportaIess: false, concept: alim._id },
      { concepto: 'Transporte', monto: 30, aportaIess: false, concept: transp._id },
    ],
  });
  await makeEmployee(clinicId, {
    firstName: 'Beto', departmentRef: costos._id, baseSalary: 700,
    fixedIncomes: [{ concepto: 'Alimentación', monto: 40, aportaIess: false, concept: alim._id }],
  });

  // Tabla IR (para que el cierre no se bloquee) y generación + contabilización del rol mensual.
  await PayrollIncomeTaxTable.create({ clinic: clinicId, year: 2026, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
  const gen = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  assert.equal(gen.items.length, 2);
  const closed = ok(await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { params: { id: String(gen._id) } })));
  assert.equal(closed.status, 'CERRADO');

  // ── Cada valor cayó en la cuenta configurada de SU departamento ──────────────────────────
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.90'), 800, 'Sueldo Admin → cuenta Admin');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.90'), 700, 'Sueldo Costos → cuenta Costos');
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.91'), 50, 'Alimentación Admin → cuenta Admin');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.91'), 40, 'Alimentación Costos → cuenta Costos');
  // HERENCIA: transporte no tiene override de depto → usó la cuenta GENERAL del concepto.
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.92'), 30, 'Transporte hereda la cuenta general');
  // Las cuentas de sueldos base de los deptos NO recibieron el sueldo (lo tomó el concepto).
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.01'), 0, 'la cuenta base del depto no duplica el sueldo');

  // ── El asiento completo (con provisiones) cuadra: debe = haber ───────────────────────────
  const entry = await JournalEntry.findById(closed.journalEntry);
  assert.ok(entry, 'el rol quedó con asiento');
  assert.equal(r2(entry.totalDebit), r2(entry.totalCredit), 'asiento cuadrado');
  const bal = await H.assertLedgerBalanced(clinicId);
  assert.ok(bal.balanced, `mayor cuadrado (${bal.debit} vs ${bal.credit})`);
  // Hay provisiones reconocidas (aporte patronal + provisión de vacaciones).
  assert.ok((entry.totalDebit || 0) > (800 + 700 + 50 + 40 + 30), 'el asiento incluye provisiones patronales/vacaciones');

  // ── Cruce con el 103 (casillero 302): base = ingresos gravados − IESS personal ────────────
  const wh = await payrollWithholdingForPeriod({ clinicId, year: 2026, month: 6 });
  assert.equal(wh.baseGravada, 1500, 'base gravada = sueldos (los ingresos fijos no gravan)');
  const iess = r2(800 * 0.0945 + 700 * 0.0945);
  assert.equal(wh.iessPersonal, iess, 'IESS personal del período');
  assert.equal(wh.baseImponibleNeta, r2(wh.baseGravada - wh.iessPersonal), '302 = gravado − IESS personal');
  assert.equal(wh.baseImponibleNeta, r2(1500 - iess));
});
