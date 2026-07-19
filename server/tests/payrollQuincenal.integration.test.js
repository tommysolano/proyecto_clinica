/**
 * NÓMINA QUINCENAL + bugs corregidos (revisión de la contadora). Sobre los controllers reales:
 *  - anticipo de quincena = % del sueldo, sin IESS, a la cuenta de anticipo por cobrar;
 *  - cierre de mes: mes completo + ingreso fijo, IESS sobre la base correcta, descuenta el
 *    anticipo y el neto cuadra; asientos con debe = haber;
 *  - IESS prorrateado por fecha de ingreso: el mostrado = el descontado;
 *  - validación de año (no más "año 1926");
 *  - fondos de reserva: modal al cumplir el año + proporcionalidad;
 *  - error claro al vincular un usuario ya usado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConfig = require('../models/PayrollConfig');
const Employee = require('../models/Employee');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const req = (clinicId, userId, body = {}, params = {}) => H.mockReq(clinicId, userId, body, { params });
const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.payload)); return r.payload; };

async function irTable(clinicId, year = 2026) {
  await PayrollIncomeTaxTable.create({ clinic: clinicId, year, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
}
async function makeDept(clinicId) {
  const acc = (code) => ChartOfAccount.findOne({ clinic: clinicId, code });
  return PayrollDepartment.create({
    clinic: clinicId, name: 'Admin', type: 'ADMINISTRATIVO',
    accounts: { sueldos: (await acc('6.1.01'))._id, beneficios: (await acc('6.1.02'))._id, iessPatronal: (await acc('6.1.03'))._id },
  });
}
let seq = 0;
async function makeEmployee(clinicId, o = {}) {
  seq += 1;
  return Employee.create({
    clinic: clinicId, code: o.code || `EMP-${seq}`, identificacion: o.identificacion || `172000${String(seq).padStart(4, '0')}`,
    firstName: o.firstName || 'Juan', lastName: o.lastName || 'Pérez',
    hireDate: o.hireDate || new Date('2024-01-01'), baseSalary: o.baseSalary ?? 800,
    paymentFrequency: o.paymentFrequency || 'MENSUAL',
    decimoTerceroAcumulado: 'MENSUALIZADO', decimoCuartoAcumulado: 'MENSUALIZADO', fondosReservaAcumulado: 'MENSUALIZADO',
    ...o,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
test('#3) valida el año del rol (no permite años absurdos como 26→1926)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await makeDept(clinicId);
  await makeEmployee(clinicId);
  const bad = await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 26, month: 6 }));
  assert.equal(bad.statusCode, 400);
  assert.match(bad.payload.message, /2000 y 2100/);
  // Con año válido + tabla IR, el cierre no dispara el error del año.
  const p = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  await irTable(clinicId, 2026);
  const closed = ok(await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(p._id) })));
  assert.equal(closed.status, 'CERRADO');
});

// ─────────────────────────────────────────────────────────────────────────────
test('#2) IESS prorrateado por fecha de ingreso: el mostrado = el descontado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await makeDept(clinicId);
  // Ingresa a mitad de mes (16-jun) con décimos mensualizados → sueldo ganado prorrateado.
  await makeEmployee(clinicId, { baseSalary: 900, hireDate: new Date('2026-06-16') });
  const p = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  const it = p.items[0];
  assert.ok(it.baseSalary < 900, `sueldo ganado prorrateado (${it.baseSalary})`);
  // El IESS se calcula sobre el sueldo GANADO, no sobre el mensual completo.
  assert.equal(it.iessPersonal, +(it.baseSalary * 0.0945).toFixed(2), 'IESS sobre la base ganada');
  assert.notEqual(it.iessPersonal, +(it.monthlySalary * 0.0945).toFixed(2), 'NO sobre el mensual completo');
  // MOSTRADO = DESCONTADO: el IESS del rol es exactamente el que resta en el neto.
  const descontadoIess = +(it.totalEgresos - it.impuestoRenta).toFixed(2); // no hay otras deducciones
  assert.equal(descontadoIess, it.iessPersonal, 'el IESS mostrado es el que se descuenta en el neto');
  assert.equal(it.netoPagar, +(it.totalIngresos - it.totalEgresos).toFixed(2));
});

// ─────────────────────────────────────────────────────────────────────────────
test('#1/#5/#7) quincena (anticipo) → cierre de mes con ingreso fijo, asientos cuadran', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await PayrollConfig.create({ clinic: clinicId, anticipoQuincenaPct: 40 });
  const dept = await makeDept(clinicId);
  await makeEmployee(clinicId, {
    departmentRef: dept._id, baseSalary: 800, paymentFrequency: 'QUINCENAL',
    fixedIncomes: [{ concepto: 'Alimentación', monto: 50, aportaIess: false, activo: true }],
  });
  await irTable(clinicId, 2026);

  // 1) Quincena: anticipo = 40% de 800 = 320, sin IESS ni gasto.
  const q = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6, periodType: 'QUINCENA_1' })));
  assert.equal(q.periodType, 'QUINCENA_1');
  assert.equal(q.items[0].anticipoQuincena, 320);
  assert.equal(q.items[0].netoPagar, 320);
  assert.equal(q.totalIngresos, 0, 'la quincena no reconoce ingreso/gasto (es un anticipo)');
  const qClosed = ok(await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(q._id) })));
  assert.equal(qClosed.status, 'CERRADO');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.06'), 320, 'anticipo por cobrar debitado');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  // 2) Cierre de mes: mes completo + ingreso fijo; IESS sobre 800 (el fijo no aporta); descuenta el anticipo.
  const c = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6, periodType: 'CIERRE_MES' })));
  const it = c.items[0];
  assert.equal(it.baseSalary, 800, 'mes completo');
  assert.equal(it.iessPersonal, +(800 * 0.0945).toFixed(2), 'IESS sobre 800 (el ingreso fijo NO aporta IESS)');
  assert.ok(it.totalIngresos >= 850, `incluye el ingreso fijo de 50 (${it.totalIngresos})`);
  assert.equal(it.anticipoQuincena, 320, 'descuenta el anticipo ya pagado');
  // El neto = ingresos - IESS - IR - anticipo (sin otras deducciones).
  assert.equal(it.netoPagar, +(it.totalIngresos - it.iessPersonal - it.impuestoRenta - 320).toFixed(2));
  const cClosed = ok(await H.runController(payroll.closePayroll, req(clinicId, userId, {}, { id: String(c._id) })));
  assert.equal(cClosed.status, 'CERRADO');
  // El anticipo por cobrar se salda (quincena debitó 320, cierre acredita 320 → neto 0).
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.06'), 0, 'anticipo saldado en el cierre');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('#1) el cierre de mes se bloquea si la quincena sigue en borrador', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  await PayrollConfig.create({ clinic: clinicId, anticipoQuincenaPct: 40 });
  const dept = await makeDept(clinicId);
  await makeEmployee(clinicId, { departmentRef: dept._id, baseSalary: 800, paymentFrequency: 'QUINCENAL' });
  ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6, periodType: 'QUINCENA_1' })));
  const r = await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6, periodType: 'CIERRE_MES' }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /quincena.*borrador/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('#4) fondos de reserva: pide decisión al cumplir el año y luego prorratea', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const dept = await makeDept(clinicId);
  // Cumple el año el 20-jun-2026 (dentro del período de junio).
  const emp = await makeEmployee(clinicId, { departmentRef: dept._id, baseSalary: 900, hireDate: new Date('2025-06-20') });
  await irTable(clinicId, 2026);

  const p1 = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  assert.equal(p1.pendingFondosDecisions.length, 1, 'pide decidir el modo de fondos');
  assert.equal(String(p1.pendingFondosDecisions[0].employee), String(emp._id));
  assert.equal(p1.items[0].fondosReserva, 0, 'sin decidir, no genera fondos');

  // Se decide MENSUALIZAR → se regenera → genera fondos PROPORCIONALES al tramo desde el aniversario.
  ok(await H.runController(payroll.setFondosReservaMode, req(clinicId, userId, { mode: 'MENSUALIZADO' }, { id: String(emp._id) })));
  const p2 = ok(await H.runController(payroll.generatePayroll, req(clinicId, userId, { year: 2026, month: 6 })));
  assert.equal(p2.pendingFondosDecisions.length, 0);
  const fr = p2.items[0].fondosReserva;
  const frFull = +(p2.items[0].baseSalary * 0.0833).toFixed(2);
  assert.ok(fr > 0 && fr < frFull, `fondos proporcionales al aniversario a mitad de mes (${fr} < ${frFull})`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('#6) vincular un usuario ya usado da un mensaje CLARO (no un error confuso)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const uid = new H.mongoose.Types.ObjectId();
  ok(await H.runController(payroll.createEmployee, req(clinicId, userId, {
    code: 'EMP-U1', identificacion: '1710000001', firstName: 'Ana', lastName: 'Gómez', hireDate: '2024-01-01', baseSalary: 600, user: String(uid),
  })), 201);
  const dup = await H.runController(payroll.createEmployee, req(clinicId, userId, {
    code: 'EMP-U2', identificacion: '1710000002', firstName: 'Otra', lastName: 'Persona', hireDate: '2024-01-01', baseSalary: 600, user: String(uid),
  }));
  assert.equal(dup.statusCode, 400);
  assert.match(dup.payload.message, /vinculad|ficha de «Ana/i);
});
