/**
 * AUDITORÍA DEL ASIENTO DEL ROL (contrato "las provisiones se están haciendo bien").
 *
 * Con la NUEVA configuración de cuentas (por departamento + globales, estructura Contífico):
 * un rol con UN empleado por CADA departamento (Administrativo/Ventas/Costos/Otros), con
 * sueldo, ingreso fijo (alimentación), horas extra, una deducción (multa), un préstamo,
 * décimos y fondos MENSUALIZADOS y ACUMULADOS mezclados. Se valida LÍNEA POR LÍNEA:
 *   - cada rubro cae en su cuenta configurada (gasto del departamento correcto);
 *   - cada línea de GASTO lleva el CENTRO DE COSTO del empleado;
 *   - las provisiones (acumulados) debitan gasto y acreditan su pasivo;
 *   - IESS personal / patronal / SECAP en sus cuentas;
 *   - el neto va a Sueldos por Pagar;
 *   - debe = haber exacto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollConcept = require('../models/PayrollConcept');
const Employee = require('../models/Employee');
const CostCenter = require('../models/CostCenter');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const JournalEntry = require('../models/JournalEntry');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const req = (clinicId, userId, body = {}, extra = {}) => H.mockReq(clinicId, userId, body, extra);
const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.payload)); return r.payload; };
const r2 = (n) => +(Number(n) || 0).toFixed(2);
const acc = (clinicId, code) => ChartOfAccount.findOne({ clinic: clinicId, code });

async function mkAcc(clinicId, code, name, type) {
  const nature = (type === 'PASIVO' || type === 'PATRIMONIO' || type === 'INGRESO') ? 'CREDITO' : 'DEBITO';
  const existing = await ChartOfAccount.findOne({ clinic: clinicId, code });
  if (existing) return existing;
  return ChartOfAccount.create({ clinic: clinicId, code, name, type, nature, level: 3, allowsMovement: true });
}
async function setByDept(clinicId, type, field, accId) {
  await PayrollConfig.findOneAndUpdate({ clinic: clinicId }, { $set: { [`accounts.byDepartment.${type}.${field}`]: accId ?? null } }, { upsert: true });
}

test('rol con un empleado por departamento: cada rubro en su cuenta, centro de costo y provisiones cuadran', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await PayrollIncomeTaxTable.create({ clinic: clinicId, year: 2026, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
  ok(await H.runController(payroll.seedConcepts, req(clinicId, userId)));
  const alimConcept = await PayrollConcept.findOne({ clinic: clinicId, code: 'ING-ALIMENTACION' });

  // Departamentos estándar y centros de costo (uno por empleado).
  const admin = await PayrollDepartment.create({ clinic: clinicId, name: 'Administrativo', type: 'ADMINISTRATIVO' });
  const ventas = await PayrollDepartment.create({ clinic: clinicId, name: 'Ventas', type: 'VENTAS' });
  const costos = await PayrollDepartment.create({ clinic: clinicId, name: 'Costos', type: 'COSTOS' });
  const otros = await PayrollDepartment.create({ clinic: clinicId, name: 'Otros', type: 'OTROS' });
  const ccCentral = await CostCenter.create({ clinic: clinicId, code: 'CC-01', name: 'Central' });
  const ccSucursal = await CostCenter.create({ clinic: clinicId, code: 'CC-02', name: 'Sucursal' });
  const ccPlanta = await CostCenter.create({ clinic: clinicId, code: 'CC-03', name: 'Planta' });
  const ccOtros = await CostCenter.create({ clinic: clinicId, code: 'CC-04', name: 'Otros CC' });

  // Cuentas de gasto DISTINTAS por departamento (para poder auditar el ruteo).
  await mkAcc(clinicId, '6.2.01', 'Sueldos Administrativo', 'GASTO');
  await mkAcc(clinicId, '6.2.02', 'Sueldos Ventas', 'GASTO');
  await mkAcc(clinicId, '6.2.03', 'Sueldos Costos', 'COSTO');
  await mkAcc(clinicId, '6.2.04', 'Sueldos Otros', 'GASTO');
  await mkAcc(clinicId, '6.2.11', 'Alimentación Administrativo', 'GASTO');
  await mkAcc(clinicId, '6.2.12', 'Alimentación Ventas', 'GASTO');
  await mkAcc(clinicId, '6.2.13', 'Alimentación Costos', 'COSTO');
  await mkAcc(clinicId, '6.2.14', 'Alimentación Otros', 'GASTO');
  await mkAcc(clinicId, '6.2.20', 'Horas extra (todas)', 'GASTO');

  const SUELDO = { ADMINISTRATIVO: '6.2.01', VENTAS: '6.2.02', COSTOS: '6.2.03', OTROS: '6.2.04' };
  const ALIM = { ADMINISTRATIVO: '6.2.11', VENTAS: '6.2.12', COSTOS: '6.2.13', OTROS: '6.2.14' };
  for (const t of ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTROS']) {
    await setByDept(clinicId, t, 'sueldo', (await acc(clinicId, SUELDO[t]))._id);
    await setByDept(clinicId, t, 'alimentacion', (await acc(clinicId, ALIM[t]))._id);
    await setByDept(clinicId, t, 'horasExtra', (await acc(clinicId, '6.2.20'))._id);
  }

  // 4 empleados: décimos/fondos mensualizados y acumulados MEZCLADOS. hireDate 2 años → fondos elegibles.
  const hire = new Date('2024-01-01');
  async function mkEmp(o) {
    return Employee.create({
      clinic: clinicId, code: o.code, identificacion: o.id, firstName: o.name, lastName: 'Test',
      hireDate: hire, baseSalary: o.salary, paymentFrequency: 'MENSUAL',
      departmentRef: o.dept._id, costCenter: o.cc._id,
      receivesDecimoTercero: true, receivesDecimoCuarto: true, receivesFondosReserva: true, fondosReservaModeSet: true,
      decimoTerceroAcumulado: o.d3, decimoCuartoAcumulado: o.d3, fondosReservaAcumulado: o.fr,
      fixedIncomes: [{ concepto: 'Alimentación', monto: o.alim, aportaIess: false, concept: alimConcept._id }],
    });
  }
  const empAdmin = await mkEmp({ code: 'E-ADM', id: '1720000001', name: 'Ana', salary: 1000, dept: admin, cc: ccCentral, alim: 50, d3: 'MENSUALIZADO', fr: 'MENSUALIZADO' });
  const empVentas = await mkEmp({ code: 'E-VEN', id: '1720000002', name: 'Beto', salary: 900, dept: ventas, cc: ccSucursal, alim: 40, d3: 'ACUMULADO', fr: 'ACUMULADO' });
  const empCostos = await mkEmp({ code: 'E-COS', id: '1720000003', name: 'Cira', salary: 800, dept: costos, cc: ccPlanta, alim: 30, d3: 'MENSUALIZADO', fr: 'ACUMULADO' });
  const empOtros = await mkEmp({ code: 'E-OTR', id: '1720000004', name: 'Dan', salary: 700, dept: otros, cc: ccOtros, alim: 20, d3: 'ACUMULADO', fr: 'MENSUALIZADO' });

  // Genera el rol y agrega horas extra + una multa (deducción) a cada empleado.
  const gen = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  assert.equal(gen.items.length, 4);
  const OT = { 'E-ADM': 100, 'E-VEN': 80, 'E-COS': 60, 'E-OTR': 40 };
  const MULTA = { 'E-ADM': 20, 'E-VEN': 15, 'E-COS': 10, 'E-OTR': 5 };
  const empByCode = { 'E-ADM': empAdmin, 'E-VEN': empVentas, 'E-COS': empCostos, 'E-OTR': empOtros };
  for (const it of gen.items) {
    const code = Object.keys(empByCode).find((c) => String(empByCode[c]._id) === String(it.employee));
    ok(await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
      { employeeId: String(it.employee), patch: { overtime: OT[code], multas: MULTA[code], prestamoEmpresa: 25 } },
      { params: { id: String(gen._id) } })));
  }

  const closed = ok(await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { params: { id: String(gen._id) } })));
  assert.equal(closed.status, 'CERRADO');
  const entry = await JournalEntry.findById(closed.journalEntry);
  const itemsByCode = Object.fromEntries(closed.items.map((it) => {
    const code = Object.keys(empByCode).find((c) => String(empByCode[c]._id) === String(it.employee));
    return [code, it];
  }));

  // Helpers para leer el asiento.
  const bal = (code) => H.accountBalanceByCode(clinicId, code);
  const lineFor = (code, ccId) => entry.lines.find((l) => l.accountCode === code && String(l.costCenter || '') === String(ccId || ''));

  // ── 1) Cada SUELDO en la cuenta de su departamento, con el centro de costo del empleado ──
  assert.equal(await bal('6.2.01'), 1000, 'sueldo Admin');
  assert.equal(await bal('6.2.02'), 900, 'sueldo Ventas');
  assert.equal(await bal('6.2.03'), 800, 'sueldo Costos');
  assert.equal(await bal('6.2.04'), 700, 'sueldo Otros');
  assert.ok(lineFor('6.2.01', ccCentral._id), 'línea de sueldo Admin lleva el centro de costo Central');
  assert.ok(lineFor('6.2.02', ccSucursal._id), 'línea de sueldo Ventas lleva el centro de costo Sucursal');
  assert.ok(lineFor('6.2.03', ccPlanta._id), 'línea de sueldo Costos lleva el centro de costo Planta');

  // ── 2) Alimentación en la cuenta de su departamento ──
  assert.equal(await bal('6.2.11'), 50, 'alimentación Admin');
  assert.equal(await bal('6.2.12'), 40, 'alimentación Ventas');
  assert.equal(await bal('6.2.13'), 30, 'alimentación Costos');
  assert.equal(await bal('6.2.14'), 20, 'alimentación Otros');

  // ── 3) Horas extra (cuenta compartida) = suma de todas ──
  assert.equal(await bal('6.2.20'), 100 + 80 + 60 + 40, 'horas extra de los 4 empleados');

  // ── 4) El GASTO total de cada empleado va a SU centro de costo ──
  const gastoEsperado = (it) => r2(
    it.baseSalary + (it.overtime || 0) + (it.decimoTercero || 0) + (it.decimoCuarto || 0) + (it.fondosReserva || 0)
    + (it.fixedIncomes || []).reduce((s, f) => s + (f.monto || 0), 0)
    + (it.provDecimoTercero || 0) + (it.provDecimoCuarto || 0) + (it.provFondosReserva || 0) + (it.provVacaciones || 0)
    + (it.iessPatronal || 0) + (it.iece || 0) + (it.secap || 0)
  );
  const debitByCc = (ccId) => r2(entry.lines.filter((l) => String(l.costCenter || '') === String(ccId)).reduce((s, l) => s + (l.debit || 0), 0));
  assert.equal(debitByCc(ccCentral._id), gastoEsperado(itemsByCode['E-ADM']), 'gasto total Admin → centro Central');
  assert.equal(debitByCc(ccSucursal._id), gastoEsperado(itemsByCode['E-VEN']), 'gasto total Ventas → centro Sucursal');
  assert.equal(debitByCc(ccPlanta._id), gastoEsperado(itemsByCode['E-COS']), 'gasto total Costos → centro Planta');
  assert.equal(debitByCc(ccOtros._id), gastoEsperado(itemsByCode['E-OTR']), 'gasto total Otros → centro Otros');

  // ── 5) Provisiones (acumulados) contra sus pasivos ──
  const sum = (fn) => r2(closed.items.reduce((s, it) => s + fn(it), 0));
  assert.equal(await bal('2.1.03.03'), -sum((it) => it.provDecimoTercero || 0), 'décimo tercero por pagar (provisión)');
  assert.equal(await bal('2.1.03.04'), -sum((it) => it.provDecimoCuarto || 0), 'décimo cuarto por pagar (provisión)');
  assert.equal(await bal('2.1.03.05'), -sum((it) => it.provFondosReserva || 0), 'fondos de reserva por pagar (provisión)');
  assert.equal(await bal('2.1.03.06'), -sum((it) => it.provVacaciones || 0), 'vacaciones por pagar (provisión)');
  // Hay al menos un empleado con cada modo (mensualizado y acumulado).
  assert.ok(closed.items.some((it) => (it.decimoTercero || 0) > 0), 'algún décimo mensualizado (ingreso)');
  assert.ok(closed.items.some((it) => (it.provDecimoTercero || 0) > 0), 'algún décimo acumulado (provisión)');
  assert.ok(closed.items.some((it) => (it.fondosReserva || 0) > 0), 'algún fondo mensualizado');
  assert.ok(closed.items.some((it) => (it.provFondosReserva || 0) > 0), 'algún fondo acumulado');

  // ── 6) IESS: personal + patronal + SECAP/IECE por pagar (todos al pasivo por defecto 2.1.03.02) ──
  const iessTotal = sum((it) => (it.iessPersonal || 0) + (it.iessPatronal || 0) + (it.iece || 0) + (it.secap || 0));
  assert.equal(await bal('2.1.03.02'), -iessTotal, 'aportes IESS por pagar (personal + patronal + SECAP/IECE)');

  // ── 7) Neto a Sueldos por Pagar; préstamos y multas descontados ──
  assert.equal(await bal('2.1.03.01'), -sum((it) => it.netoPagar || 0), 'sueldos por pagar = neto total');
  assert.equal(await bal('1.1.02.04'), -sum(() => 25), 'préstamos recuperados (25 c/u)');
  const cxc = await bal('1.1.02.06'); // multas van a la cuenta general de descuentos por defecto
  assert.equal(cxc, -sum((it) => it.multas || 0), 'multas descontadas (cuenta general)');

  // ── 8) Debe = haber exacto y mayor cuadrado ──
  assert.equal(r2(entry.totalDebit), r2(entry.totalCredit), 'asiento cuadrado (debe = haber)');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced, 'mayor cuadrado');
  // La cuenta general de sueldos (6.1.01) NO recibió nada: todo se ruteó por departamento.
  assert.equal(await bal('6.1.01'), 0, 'la cuenta general de sueldos no se usó (ruteo por depto)');
});
