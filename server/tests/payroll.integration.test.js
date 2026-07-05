/**
 * Nómina/RRHH parametrizada contablemente sobre los controllers reales. Verifica:
 *  - catálogos (departamento/cargo/conceptos) y empleados parametrizados;
 *  - cierre de rol debita el GASTO según el departamento (Admin vs Ventas);
 *  - comisión/bonificación, préstamo/anticipo, ausencias y vacaciones-contra-provisión;
 *  - el asiento de cierre CUADRA y bloquea si falta una cuenta crítica;
 *  - el pago desde banco genera asiento + BankTransaction y deja rastro en el mayor;
 *  - empleados legacy siguen visibles; el seed de conceptos es idempotente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PayrollDepartment = require('../models/PayrollDepartment');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const JournalEntry = require('../models/JournalEntry');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

// Tabla de IR activa para el año (idempotente); el cierre la exige si hay ingreso.
async function ensureIrTable(clinicId, year = 2026) {
  const exists = await PayrollIncomeTaxTable.findOne({ clinic: clinicId, year, active: true });
  if (!exists) await PayrollIncomeTaxTable.create({ clinic: clinicId, year, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const acc = (clinicId, code) => ChartOfAccount.findOne({ clinic: clinicId, code });

async function makeDept(clinicId, { name, type = 'ADMINISTRATIVO', sueldosCode = '6.1.01', withAccount = true } = {}) {
  const accounts = {};
  if (withAccount) {
    const sueldos = await acc(clinicId, sueldosCode);
    accounts.sueldos = sueldos._id;
    accounts.beneficios = (await acc(clinicId, '6.1.02'))._id;
    accounts.iessPatronal = (await acc(clinicId, '6.1.03'))._id;
  }
  return PayrollDepartment.create({ clinic: clinicId, name, type, accounts });
}

async function makeEmployee(clinicId, overrides = {}) {
  const n = Math.random().toString(36).slice(2, 7);
  return Employee.create({
    clinic: clinicId,
    code: overrides.code || `EMP-${n}`,
    identificacion: overrides.identificacion || `17${Math.floor(Math.random() * 1e8)}`,
    firstName: overrides.firstName || 'Juan',
    lastName: overrides.lastName || 'Pérez',
    hireDate: overrides.hireDate || new Date('2024-01-01'),
    baseSalary: overrides.baseSalary ?? 600,
    receivesFondosReserva: overrides.receivesFondosReserva ?? false,
    decimoTerceroAcumulado: 'MENSUALIZADO',
    decimoCuartoAcumulado: 'MENSUALIZADO',
    fondosReservaAcumulado: 'MENSUALIZADO',
    ...overrides,
  });
}

const req = (clinicId, userId, body = {}, params = {}) => H.mockReq(clinicId, userId, body, { params });

// ── 1) Departamento + cargo ────────────────────────────────────────────────────
test('1) crea departamento administrativo y cargo parametrizado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const rDept = await H.runController(payroll.createDepartment, H.mockReq(clinicId, userId, { name: 'Administración', type: 'ADMINISTRATIVO' }));
  assert.equal(rDept.statusCode, 201);
  const rPos = await H.runController(payroll.createPosition, H.mockReq(clinicId, userId, { name: 'Contadora', department: String(rDept.payload._id) }));
  assert.equal(rPos.statusCode, 201);
  assert.equal(String(rPos.payload.department), String(rDept.payload._id));
});

// ── 2) Empleado con depto/cargo parametrizado ──────────────────────────────────
test('2) crea empleado con departamento/cargo de catálogo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const dept = await makeDept(clinicId, { name: 'Admin' });
  const r = await H.runController(payroll.createEmployee, H.mockReq(clinicId, userId, {
    code: 'EMP-1', identificacion: '1720000000', firstName: 'Ana', lastName: 'Gómez',
    hireDate: '2024-01-01', baseSalary: 600, departmentRef: String(dept._id),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.departmentRef), String(dept._id));
});

// ── 3/4) Conceptos ingreso/egreso con cuenta ──────────────────────────────────
test('3-4) crea conceptos de ingreso y egreso con cuenta configurada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const comisiones = await acc(clinicId, '6.1.22');
  const cxc = await acc(clinicId, '1.1.02.06');
  const rIng = await H.runController(payroll.createConcept, H.mockReq(clinicId, userId, { code: 'ING-COM', name: 'Comisión', type: 'INGRESO', defaultAccount: String(comisiones._id) }));
  assert.equal(rIng.statusCode, 201);
  assert.equal(String(rIng.payload.defaultAccount), String(comisiones._id));
  const rEgr = await H.runController(payroll.createConcept, H.mockReq(clinicId, userId, { code: 'EGR-SEG', name: 'Seguro', type: 'EGRESO', payableAccount: String(cxc._id) }));
  assert.equal(rEgr.statusCode, 201);
  assert.equal(String(rEgr.payload.payableAccount), String(cxc._id));
});

// Helper: genera un rol y asegura la tabla de IR (para poder cerrar).
async function generateAndClose(clinicId, userId, { year = 2026, month = 6 } = {}) {
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year, month }));
  assert.equal(gen.statusCode, 200, JSON.stringify(gen.payload));
  await ensureIrTable(clinicId, year);
  return gen.payload;
}

// ── 5) Cierre empleado ADMIN → gasto a cuenta administrativa ──────────────────
test('5) cierre de empleado administrativo debita la cuenta admin del departamento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin', type: 'ADMINISTRATIVO', sueldosCode: '6.1.01' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const sueldosAdmin = await H.accountBalanceByCode(clinicId, '6.1.01');
  assert.ok(sueldosAdmin > 0, 'gasto sueldos administrativos > 0');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 6) Cierre empleado VENTAS → gasto a cuenta de ventas ──────────────────────
test('6) cierre de empleado de ventas debita la cuenta de gasto de ventas', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  // Cuenta de gasto de ventas: usamos 6.1.15 (Publicidad/marketing) como cuenta de ventas de ejemplo.
  const ventas = await makeDept(clinicId, { name: 'Ventas', type: 'VENTAS', sueldosCode: '6.1.15' });
  await makeEmployee(clinicId, { departmentRef: ventas._id, baseSalary: 800 });
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok((await H.accountBalanceByCode(clinicId, '6.1.15')) > 0, 'gasto de ventas > 0');
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.01'), 0, 'no toca gasto admin general');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 7) Rol con comisión/bonificación (rubro flexible) ─────────────────────────
test('7) comisión agregada como rubro flexible entra al ingreso y al asiento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const before = p.items[0].totalIngresos;
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { earnings: [{ code: 'ING-COM', name: 'Comisión', amount: 100 }] } },
    { id: String(p._id) }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  const it = upd.payload.items[0];
  assert.equal(it.totalIngresos, +(before + 100).toFixed(2), 'ingreso base + comisión 100');
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 8) Rol con préstamo/anticipo ──────────────────────────────────────────────
test('8) préstamo/anticipo reduce el neto y se refleja en el asiento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const netoAntes = p.items[0].netoPagar;
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { prestamoEmpresa: 50, anticipos: 30 } }, { id: String(p._id) }));
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.payload.items[0].netoPagar, +(netoAntes - 80).toFixed(2));
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200);
  // Préstamo por cobrar (1.1.02.04) se acredita (recuperación) → saldo negativo respecto al débito.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.04'), -50);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 9) Falta injustificada reduce el sueldo ───────────────────────────────────
test('9) ausencia injustificada reduce el sueldo proporcionalmente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { absenceDays: 6 } }, { id: String(p._id) })); // 6 días de falta
  assert.equal(upd.statusCode, 200);
  const it = upd.payload.items[0];
  assert.equal(it.daysWorked, 24);
  assert.equal(it.baseSalary, 480, '600 * 24/30 = 480');
});

// ── 10) Vacaciones no son falta y usan la provisión ───────────────────────────
test('10) vacaciones gozadas van contra provisión (no como falta) y el asiento cuadra', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  // Vacación gozada: se paga como ingreso pero contra la provisión (no reduce días).
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { vacaciones: 50, vacacionesContraProvision: 50, absenceDays: 0 } },
    { id: String(p._id) }));
  assert.equal(upd.statusCode, 200);
  const it = upd.payload.items[0];
  assert.equal(it.baseSalary, 600, 'no se reduce el sueldo por vacaciones');
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  // Vacaciones por pagar (2.1.03.06): la provisión mensual (base/24=25) menos lo gozado (50) = -25 → débito neto.
  const entry = await JournalEntry.findById(r.payload.journalEntry);
  const vacLine = entry.lines.find((l) => l.accountCode === '2.1.03.06');
  assert.ok(vacLine, 'existe línea de vacaciones por pagar');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 11) Cierre genera asiento cuadrado ────────────────────────────────────────
test('11) el cierre genera un asiento contable cuadrado con trazabilidad NOMINA', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200);
  const entry = await JournalEntry.findById(r.payload.journalEntry);
  assert.equal(entry.source, 'NOMINA');
  assert.equal(entry.sourceModel, 'Payroll');
  assert.equal(String(entry.sourceRef), String(p._id));
  assert.equal(+entry.totalDebit.toFixed(2), +entry.totalCredit.toFixed(2));
});

// ── 12) Cierre falla si falta cuenta crítica ──────────────────────────────────
test('12) el cierre falla si el departamento no tiene cuenta de sueldos', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const sinCuenta = await makeDept(clinicId, { name: 'SinCuenta', withAccount: false });
  await makeEmployee(clinicId, { departmentRef: sinCuenta._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /cuenta de gasto de sueldos/i);
  const reloaded = await Payroll.findById(p._id);
  assert.equal(reloaded.status, 'BORRADOR', 'no se cerró');
});

// ── 13) Pago desde banco genera asiento + BankTransaction ─────────────────────
test('13) pago de nómina desde banco genera asiento PAGO y BankTransaction', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const bankAcc = await acc(clinicId, '1.1.01.03');
  const bank = await BankAccount.create({ clinic: clinicId, name: 'Cta Cte', bank: 'Pichincha', accountNumber: '123', chartAccount: bankAcc._id });
  const p = await generateAndClose(clinicId, userId);
  await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));

  const pay = await H.runController(payroll.markPaid, req(clinicId, userId, { bankAccountId: String(bank._id), date: '2026-06-30' }, { id: String(p._id) }));
  assert.equal(pay.statusCode, 200, JSON.stringify(pay.payload));
  assert.equal(pay.payload.status, 'PAGADO');
  const bankTx = await BankTransaction.findOne({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: p._id });
  assert.ok(bankTx, 'existe BankTransaction del pago');
  assert.equal(bankTx.direction, -1);
  assert.equal(bankTx.amount, p.totalNeto);
  const payEntry = await JournalEntry.findById(pay.payload.paymentJournalEntry);
  assert.equal(payEntry.source, 'PAGO');
  assert.equal(String(payEntry.sourceRef), String(p._id));
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 14) El mayor muestra el origen de nómina ──────────────────────────────────
test('14) los asientos de nómina quedan trazados por sourceModel Payroll', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  const entries = await JournalEntry.find({ clinic: clinicId, sourceModel: 'Payroll', sourceRef: p._id });
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].source, 'NOMINA');
});

// ── 15) Empleado legacy (dept texto libre) sigue visible ──────────────────────
test('15) empleado legacy con departamento texto libre sigue visible y operable', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await makeEmployee(clinicId, { department: 'Recepción', position: 'Recepcionista', baseSalary: 500, departmentRef: null });
  const list = await H.runController(payroll.listEmployees, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(list.statusCode, 200);
  assert.equal(list.payload.length, 1);
  assert.equal(list.payload[0].department, 'Recepción');
  // Cierra su rol con las cuentas GENERALES (fallback legacy) sin fallar.
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok((await H.accountBalanceByCode(clinicId, '6.1.01')) > 0, 'usa la cuenta general de sueldos');
});

// ── 16) Seed de conceptos idempotente ─────────────────────────────────────────
test('16) el seed de conceptos es idempotente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const r1 = await H.runController(payroll.seedConcepts, H.mockReq(clinicId, userId, {}));
  assert.equal(r1.statusCode, 200);
  assert.ok(r1.payload.created > 0);
  const total1 = r1.payload.total;
  const r2 = await H.runController(payroll.seedConcepts, H.mockReq(clinicId, userId, {}));
  assert.equal(r2.payload.created, 0, 'segunda corrida no crea duplicados');
  assert.equal(r2.payload.total, total1);
});

// ═══════════ Correcciones: tabla IR parametrizable + recálculo IESS/IR ═══════════

// A) Crear tabla IR por año + seed idempotente.
test('A) crea tabla IR por año y el seed es idempotente', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const create = await H.runController(payroll.createIncomeTaxTable, H.mockReq(clinicId, userId, {
    year: 2026, periodType: 'ANNUAL', ranges: [{ from: 0, to: 11722, baseTax: 0, excessRate: 0 }, { from: 11722, to: null, baseTax: 0, excessRate: 5 }],
  }));
  assert.equal(create.statusCode, 201);
  assert.equal(create.payload.active, true);
  const s1 = await H.runController(payroll.seedIncomeTaxTable, H.mockReq(clinicId, userId, { year: 2027 }));
  assert.equal(s1.payload.created, true);
  const s2 = await H.runController(payroll.seedIncomeTaxTable, H.mockReq(clinicId, userId, { year: 2027 }));
  assert.equal(s2.payload.created, false, 'no duplica tabla del año');
});

// B) El cierre usa la tabla IR configurada (no hardcode): IR > 0 para sueldo alto.
test('B) el rol calcula IR con la tabla configurada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 2000, receivesDecimoTercero: false, receivesDecimoCuarto: false });
  await ensureIrTable(clinicId, 2026);
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  assert.equal(gen.statusCode, 200);
  const ir = gen.payload.items[0].impuestoRenta;
  assert.ok(ir > 0, `IR debe ser > 0 con la tabla (fue ${ir})`);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(gen.payload._id) }));
  assert.equal(r.statusCode, 200);
  assert.ok(Math.abs(await H.accountBalanceByCode(clinicId, '2.1.02.05')) > 0, 'IR por pagar acreditado');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// C) El cierre falla si falta la tabla IR y hay ingreso sujeto a IR.
test('C) cierre falla si no hay tabla IR configurada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  // NO se siembra tabla IR.
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(gen.payload._id) }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /tabla de impuesto a la renta/i);
});

// D) Editar ausencia recalcula sueldo, IESS, IR y neto (no queda IESS viejo).
test('D) editar ausencia recalcula sueldo/IESS/neto', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600, receivesDecimoTercero: false, receivesDecimoCuarto: false });
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  const iessAntes = gen.payload.items[0].iessPersonal;
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { absenceDays: 6 } }, { id: String(gen.payload._id) }));
  assert.equal(upd.statusCode, 200);
  const it = upd.payload.items[0];
  assert.equal(it.baseSalary, 480, '600 * 24/30');
  assert.ok(it.iessPersonal < iessAntes, 'IESS se recalcula tras la ausencia');
  assert.equal(it.iessPersonal, +(480 * 0.0945).toFixed(2));
});

// E) Editar comisión (concepto que grava IESS) recalcula IESS y neto.
test('E) comisión con concepto que afecta IESS recalcula IESS', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const comAcc = await acc(clinicId, '6.1.22');
  const rc = await H.runController(payroll.createConcept, H.mockReq(clinicId, userId, { code: 'ING-COM', name: 'Comisión', type: 'INGRESO', affectsIess: true, affectsIncomeTax: true, defaultAccount: String(comAcc._id) }));
  const conceptId = rc.payload._id;
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600, receivesDecimoTercero: false, receivesDecimoCuarto: false });
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  const iessAntes = gen.payload.items[0].iessPersonal;
  const upd = await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { earnings: [{ concept: String(conceptId), code: 'ING-COM', name: 'Comisión', amount: 200 }] } },
    { id: String(gen.payload._id) }));
  assert.equal(upd.statusCode, 200);
  const it = upd.payload.items[0];
  assert.equal(it.iessPersonal, +((600 + 200) * 0.0945).toFixed(2), 'IESS incluye la comisión');
  assert.ok(it.iessPersonal > iessAntes);
});

// F) Concepto usado sin cuenta bloquea el cierre.
test('F) concepto sin cuenta configurada bloquea el cierre', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  const rc = await H.runController(payroll.createConcept, H.mockReq(clinicId, userId, { code: 'ING-X', name: 'Bono sin cuenta', type: 'INGRESO' }));
  const emp = await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const gen = await H.runController(payroll.generatePayroll, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  await ensureIrTable(clinicId, 2026);
  await H.runController(payroll.updatePayrollItem, req(clinicId, userId,
    { employeeId: String(emp._id), patch: { earnings: [{ concept: String(rc.payload._id), code: 'ING-X', name: 'Bono sin cuenta', amount: 80 }] } },
    { id: String(gen.payload._id) }));
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(gen.payload._id) }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no tiene cuenta de gasto/i);
});

// G) La provisión de vacaciones usa la cuenta configurada (vacaciones por pagar).
test('G) provisión de vacaciones acredita la cuenta configurada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const admin = await makeDept(clinicId, { name: 'Admin' });
  await makeEmployee(clinicId, { departmentRef: admin._id, baseSalary: 600 });
  const p = await generateAndClose(clinicId, userId);
  const r = await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) }));
  assert.equal(r.statusCode, 200);
  assert.ok((await H.accountBalanceByCode(clinicId, '2.1.03.06')) < 0, 'vacaciones por pagar acreditada (provisión)');
});
