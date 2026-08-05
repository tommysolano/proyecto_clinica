/**
 * PRÉSTAMOS Y DESCUENTOS AL EMPLEADO (pedido de contabilidad).
 *
 * Cubre con los CONTROLLERS reales:
 *   1. Otorgar genera ASIENTO (antes no generaba ninguno y la pantalla decía, con razón, que el
 *      documento no tenía asiento asociado) y movimiento bancario cuando sale del banco.
 *   2. Cada TIPO debita SU cuenta: un quirografario no puede caer en la de préstamos de la
 *      empresa (era lo que pasaba con todos los tipos).
 *   3. Tipos nuevos: anticipo, impuesto a la renta, seguro, multa y descuento.
 *   4. Origen del dinero: transferencia, cheque (contra la chequera), efectivo y caja chica.
 *   5. La cuota entra sola al ROL del mes con nombre y cuenta, y al cerrarlo acredita esa misma
 *      cuenta; reabrir el rol devuelve la cuota a pendiente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const banks = require('../controllers/bankController');
const journal = require('../controllers/journalEntryController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const Employee = require('../models/Employee');
const EmployeeLoan = require('../models/EmployeeLoan');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const BankCheck = require('../models/BankCheck');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');
const { getAccount } = require('../utils/accountMap');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { if (r.statusCode >= 400) throw new Error(`${r.statusCode}: ${JSON.stringify(r.payload)}`); return r.payload; };
const acc = (clinicId, code) => ChartOfAccount.findOne({ clinic: clinicId, code });
const hoy = () => new Date().toISOString().slice(0, 10);

async function makeBank(clinicId, name = 'Banco Pichincha') {
  const a = await getAccount(clinicId, 'bancos');
  return BankAccount.create({
    clinic: clinicId, name, bank: name,
    accountNumber: String(Math.random()).slice(2, 10), chartAccount: a._id,
  });
}
async function makeEmployee(clinicId, overrides = {}) {
  const n = Math.random().toString(36).slice(2, 7);
  const dept = await PayrollDepartment.create({
    clinic: clinicId, name: `Admin ${n}`, type: 'ADMINISTRATIVO',
    accounts: {
      sueldos: (await acc(clinicId, '6.1.01'))._id,
      beneficios: (await acc(clinicId, '6.1.02'))._id,
      iessPatronal: (await acc(clinicId, '6.1.03'))._id,
    },
  });
  return Employee.create({
    clinic: clinicId, code: `EMP-${n}`, identificacion: `17${Math.floor(Math.random() * 1e8)}`,
    firstName: overrides.firstName || 'Juan', lastName: overrides.lastName || 'Pérez',
    hireDate: new Date('2024-01-01'), baseSalary: overrides.baseSalary ?? 900,
    departmentRef: dept._id,
    decimoTerceroAcumulado: 'MENSUALIZADO', decimoCuartoAcumulado: 'MENSUALIZADO',
    fondosReservaAcumulado: 'MENSUALIZADO',
    ...overrides,
  });
}

/**
 * Cuentas DISTINTAS por tipo de préstamo. Con los valores por defecto varias comparten código
 * (1.1.02.06), así que sin esto no se podría demostrar que cada tipo va a la suya.
 */
async function configurarCuentasDePrestamo(clinicId) {
  const crear = async (code, name, type = 'ACTIVO') => {
    const existe = await ChartOfAccount.findOne({ clinic: clinicId, code });
    if (existe) return existe;
    return ChartOfAccount.create({
      clinic: clinicId, code, name, type,
      nature: ['ACTIVO', 'GASTO', 'COSTO'].includes(type) ? 'DEBITO' : 'CREDITO',
      allowsMovement: true,
    });
  };
  const personal = await crear('1.1.02.41', 'Préstamos empresa a empleados');
  const quiro = await crear('1.1.02.42', 'Préstamos quirografarios IESS');
  const hipo = await crear('1.1.02.43', 'Préstamos hipotecarios IESS');
  const anticipo = await crear('1.1.02.44', 'Anticipos a empleados');
  const multa = await crear('1.1.02.45', 'Multas por cobrar a empleados');
  const seguro = await crear('1.1.02.46', 'Seguros por cobrar a empleados');
  const descuento = await crear('1.1.02.47', 'Descuentos por cobrar a empleados');
  await PayrollConfig.findOneAndUpdate(
    { clinic: clinicId },
    {
      $set: {
        'accounts.global.prestamoPersonal': personal._id,
        'accounts.global.prestamoQuirografario': quiro._id,
        'accounts.global.prestamoHipotecario': hipo._id,
        'accounts.global.anticipos': anticipo._id,
        'accounts.global.multa': multa._id,
        'accounts.global.seguros': seguro._id,
        'accounts.global.descuento': descuento._id,
      },
    },
    { upsert: true, new: true }
  );
  return { personal, quiro, hipo, anticipo, multa, seguro, descuento };
}

/** Saldo (debe - haber) de una cuenta por su _id. */
async function saldo(clinicId, accId) {
  const a = await ChartOfAccount.findById(accId);
  return H.accountBalanceByCode(clinicId, a.code);
}

// ── 1. El otorgamiento genera asiento ────────────────────────────────────────
test('otorgar un préstamo genera su asiento y el movimiento del banco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cuentas = await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const bank = await makeBank(clinicId);

  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 600, installmentsCount: 6,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
    reference: 'TR-901', description: 'Préstamo para calamidad doméstica',
  })));

  assert.ok(loan.journalEntry, 'el préstamo queda con su asiento (antes no se generaba ninguno)');
  assert.equal(loan.installments.length, 6);
  assert.equal(loan.installmentAmount, 100);
  assert.equal(loan.balance, 600);

  // El asiento se ve desde la pantalla (endpoint by-source, que es el que consulta el modal).
  const vistos = ok(await run(journal.bySource, H.mockReq(clinicId, userId, {}, {
    query: { model: 'EmployeeLoan', ref: String(loan._id) },
  })));
  assert.equal(vistos.length, 1, 'el modal del préstamo encuentra su asiento');

  // Debe la cuenta de préstamos de la empresa; haber el banco.
  assert.equal(await saldo(clinicId, cuentas.personal._id), 600);
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, -600, 'el dinero salió del banco');
  const tx = await BankTransaction.findOne({ clinic: clinicId, sourceModel: 'EmployeeLoan', sourceRef: loan._id });
  assert.equal(tx.direction, -1);
  assert.equal(tx.partyName, 'Juan Pérez', 'el movimiento dice a quién se le entregó');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ── 2. Cada tipo, su cuenta ──────────────────────────────────────────────────
test('cada tipo debita SU cuenta: el quirografario no cae en la de la empresa', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cuentas = await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const bank = await makeBank(clinicId);

  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'QUIROGRAFARIO', principal: 300, installmentsCount: 3,
    grantDate: hoy(), disbursementMethod: 'SIN_DESEMBOLSO', counterAccount: String((await acc(clinicId, '2.1.03.02'))._id),
  })));
  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'HIPOTECARIO', principal: 500, installmentsCount: 5,
    grantDate: hoy(), disbursementMethod: 'SIN_DESEMBOLSO', counterAccount: String((await acc(clinicId, '2.1.03.02'))._id),
  })));
  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'ANTICIPO', principal: 200, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
  })));

  assert.equal(await saldo(clinicId, cuentas.quiro._id), 300, 'quirografario a su cuenta');
  assert.equal(await saldo(clinicId, cuentas.hipo._id), 500, 'hipotecario a la suya');
  assert.equal(await saldo(clinicId, cuentas.anticipo._id), 200, 'anticipo a la suya');
  assert.equal(await saldo(clinicId, cuentas.personal._id), 0, 'NADA cae en préstamos de la empresa');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('los tipos nuevos (multa, seguro, descuento, impuesto a la renta) existen y se contabilizan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cuentas = await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const ingreso = await acc(clinicId, '4.1.02');

  const tipos = ok(await run(payroll.loanTypes, H.mockReq(clinicId, userId, {}, { query: {} })));
  const nombres = tipos.types.map((t) => t.type);
  for (const t of ['ANTICIPO', 'IMPUESTO_RENTA', 'SEGURO', 'MULTA', 'DESCUENTO', 'QUIROGRAFARIO', 'HIPOTECARIO', 'EMPRESA']) {
    assert.ok(nombres.includes(t), `falta el tipo ${t}`);
  }

  const multa = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'MULTA', principal: 50, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'SIN_DESEMBOLSO', counterAccount: String(ingreso._id),
    description: 'Atraso reiterado',
  })));
  assert.ok(multa.journalEntry, 'la multa también genera asiento');
  assert.equal(await saldo(clinicId, cuentas.multa._id), 50);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('sin desembolso hay que decir contra qué cuenta se registra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const r = await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'MULTA', principal: 30, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'SIN_DESEMBOLSO',
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /contrapartida/i);
});

// ── 3. Origen del dinero ─────────────────────────────────────────────────────
test('el desembolso puede salir de caja o de caja chica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);

  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'ANTICIPO', principal: 80, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'EFECTIVO',
  })));
  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'ANTICIPO', principal: 40, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'CAJA_CHICA',
  })));

  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), -80, 'salió de caja');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.02'), -40, 'salió de caja chica');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('el desembolso con cheque gira uno de la chequera y rechaza un número inexistente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 20 })));

  const malo = await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 100, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '99',
  }));
  assert.equal(malo.statusCode, 400);
  assert.match(malo.payload.message, /no existe en la chequera/i);

  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 100, installmentsCount: 1,
    grantDate: hoy(), disbursementMethod: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '4',
  })));
  const chk = await BankCheck.findOne({ clinic: clinicId, bankAccount: bank._id, number: 4 });
  assert.equal(chk.status, 'GIRADO');
  assert.equal(chk.beneficiary, 'Juan Pérez');
  assert.equal(chk.amount, 100);
  assert.equal(loan.checkNumber, '4');
});

// ── 4. El préstamo aparece en la nómina ──────────────────────────────────────
test('la cuota aparece en el rol con nombre propio y se descuenta del neto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId, { baseSalary: 900 });
  const bank = await makeBank(clinicId);
  ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'QUIROGRAFARIO', principal: 600, installmentsCount: 6,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
  })));

  const ahora = new Date();
  const rol = ok(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, {
    year: ahora.getFullYear(), month: ahora.getMonth() + 1,
  })));
  const item = rol.items.find((i) => String(i.employee) === String(emp._id));
  const linea = (item.deductions || []).find((d) => d.sourceModel === 'EmployeeLoan');
  assert.ok(linea, 'la cuota del préstamo aparece en el rol (antes no se veía)');
  assert.match(linea.name, /quirografario/i);
  assert.match(linea.name, /cuota 1\/6/);
  assert.equal(linea.amount, 100);
  assert.ok(linea.account, 'lleva la cuenta contra la que se recupera');
  assert.ok(item.totalEgresos >= 100, 'y descuenta del neto');
});

test('al cerrar el rol la cuota acredita la cuenta del TIPO y queda marcada como pagada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cuentas = await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId, { baseSalary: 900 });
  const bank = await makeBank(clinicId);
  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'QUIROGRAFARIO', principal: 600, installmentsCount: 6,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
  })));
  assert.equal(await saldo(clinicId, cuentas.quiro._id), 600);

  const ahora = new Date();
  const rol = ok(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, {
    year: ahora.getFullYear(), month: ahora.getMonth() + 1,
  })));
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: ahora.getFullYear(), periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024,
  });
  ok(await run(payroll.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(rol._id) } })));

  // La recuperación acredita la MISMA cuenta que se debitó (600 - 100 = 500).
  assert.equal(await saldo(clinicId, cuentas.quiro._id), 500, 'el quirografario se recupera contra su cuenta');
  assert.equal(await saldo(clinicId, cuentas.personal._id), 0, 'y no contra la de préstamos de la empresa');

  const guardado = await EmployeeLoan.findById(loan._id);
  assert.equal(guardado.installments[0].paid, true);
  assert.equal(guardado.paidAmount, 100);
  assert.equal(guardado.balance, 500);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('reabrir el rol devuelve la cuota a pendiente (no se cobra dos veces)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId, { baseSalary: 900 });
  const bank = await makeBank(clinicId);
  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 400, installmentsCount: 4,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
  })));
  const ahora = new Date();
  const rol = ok(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, {
    year: ahora.getFullYear(), month: ahora.getMonth() + 1,
  })));
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: ahora.getFullYear(), periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024,
  });
  ok(await run(payroll.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(rol._id) } })));
  assert.equal((await EmployeeLoan.findById(loan._id)).paidAmount, 100);

  ok(await run(payroll.reopenPayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(rol._id) } })));
  const tras = await EmployeeLoan.findById(loan._id);
  assert.equal(tras.installments[0].paid, false, 'la cuota vuelve a estar pendiente');
  assert.equal(tras.paidAmount, 0);
  assert.equal(tras.balance, 400);
  assert.equal(tras.status, 'ACTIVO');
});

// ── 5. Anulación ─────────────────────────────────────────────────────────────
test('anular un préstamo reversa su asiento, devuelve el saldo del banco y libera el cheque', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cuentas = await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId);
  const bank = await makeBank(clinicId);
  ok(await run(banks.generateChecks, H.mockReq(clinicId, userId, { bankAccount: String(bank._id), from: 1, to: 10 })));
  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 250, installmentsCount: 5,
    grantDate: hoy(), disbursementMethod: 'CHEQUE', bankAccount: String(bank._id), checkNumber: '2',
  })));
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, -250);

  ok(await run(payroll.voidLoan, H.mockReq(clinicId, userId, { reason: 'monto equivocado' }, { params: { id: String(loan._id) } })));

  assert.equal(await saldo(clinicId, cuentas.personal._id), 0, 'el asiento quedó reversado');
  assert.equal((await BankAccount.findById(bank._id)).bookBalance, 0, 'el banco recupera su saldo');
  assert.equal((await BankCheck.findOne({ clinic: clinicId, bankAccount: bank._id, number: 2 })).status, 'DISPONIBLE');
  assert.equal((await EmployeeLoan.findById(loan._id)).status, 'ANULADO');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('un préstamo con cuotas ya descontadas no se anula', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await configurarCuentasDePrestamo(clinicId);
  const emp = await makeEmployee(clinicId, { baseSalary: 900 });
  const bank = await makeBank(clinicId);
  const loan = ok(await run(payroll.createLoan, H.mockReq(clinicId, userId, {
    employee: String(emp._id), type: 'EMPRESA', principal: 300, installmentsCount: 3,
    grantDate: hoy(), disbursementMethod: 'TRANSFERENCIA', bankAccount: String(bank._id),
  })));
  const ahora = new Date();
  const rol = ok(await run(payroll.generatePayroll, H.mockReq(clinicId, userId, {
    year: ahora.getFullYear(), month: ahora.getMonth() + 1,
  })));
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: ahora.getFullYear(), periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024,
  });
  ok(await run(payroll.closePayroll, H.mockReq(clinicId, userId, {}, { params: { id: String(rol._id) } })));

  const r = await run(payroll.voidLoan, H.mockReq(clinicId, userId, {}, { params: { id: String(loan._id) } }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /ya se descontó/i);
});
