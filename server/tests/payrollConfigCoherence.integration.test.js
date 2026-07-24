/**
 * COHERENCIA PANTALLA ↔ POSTEO en las cuentas contables de nómina.
 *
 * Bug de producción: PayrollConfig tenía campos en null (dec3Pasivo, vacacionesPasivo,
 * sueldo por depto, etc.) pero el cierre de rol resolvía esos rubros a su cuenta por
 * defecto (por código). La pantalla "mentía": mostraba campos vacíos que sin embargo
 * contabilizaban a una cuenta que la contadora no veía.
 *
 * Corrección: getConfig SIEMBRA en los campos con default de posteo (null o undefined) la
 * MISMA cuenta que usa el cierre, de modo que lo mostrado == lo contabilizado. Los rubros
 * sin default (comisariato, alimentación, etc.) siguen en blanco y el cierre los bloquea.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const PayrollConfig = require('../models/PayrollConfig');
const ChartOfAccount = require('../models/ChartOfAccount');
const { buildPayrollEntryLines } = require('../utils/payrollPosting');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const req = (clinicId, userId, body = {}, extra = {}) => H.mockReq(clinicId, userId, body, extra);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const accId = async (clinicId, code) => {
  const a = await ChartOfAccount.findOne({ clinic: clinicId, code });
  return a ? String(a._id) : null;
};

test('d) getConfig siembra los rubros con default de posteo que estaban en null y coincide con el asiento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });

  // 1) Config inicial (creada y sembrada por getConfig).
  ok(await H.runController(payroll.getConfig, req(clinicId, userId)));

  // 2) Simula el estado de producción: la contadora guardó dejando en blanco (null explícito)
  //    varios rubros, incluidos algunos que SÍ tienen default de posteo.
  await PayrollConfig.updateOne({ clinic: clinicId }, {
    $set: {
      'accounts.global.dec3Pasivo': null,            // tiene default (2.1.03.03)
      'accounts.global.vacacionesPasivo': null,      // tiene default (2.1.03.06)
      'accounts.global.comisariato': null,           // SIN default → debe quedar null
      'accounts.byDepartment.ADMINISTRATIVO.sueldo': null,        // tiene default (6.1.01)
      'accounts.byDepartment.ADMINISTRATIVO.vacacionesGasto': null, // tiene default (6.1.07)
      'accounts.byDepartment.ADMINISTRATIVO.alimentacion': null,  // SIN default → null
    },
  });

  // 3) La pantalla "miente": con los campos en null, el asiento de un rol AUN ASÍ postea a la
  //    cuenta por defecto que la contadora no ve.
  const rolItem = {
    departmentType: 'ADMINISTRATIVO', baseSalary: 1000, provDecimoTercero: 83.33, netoPagar: 1000,
  };
  const antes = await buildPayrollEntryLines({ periodType: 'MENSUAL', items: [rolItem] }, { clinicId });
  const code601 = await accId(clinicId, '6.1.01');   // sueldo
  const code210303 = await accId(clinicId, '2.1.03.03'); // dec3Pasivo
  const gastoSueldoAntes = antes.lines.find((l) => String(l.account) === code601);
  assert.ok(gastoSueldoAntes && gastoSueldoAntes.debit === 1000, 'el asiento postea sueldo a 6.1.01 aunque la pantalla muestre null');

  const cfgNull = await PayrollConfig.findOne({ clinic: clinicId });
  assert.equal(cfgNull.accounts.byDepartment.ADMINISTRATIVO.sueldo, null, 'la pantalla mostraba el sueldo VACÍO (incoherencia)');

  // 4) getConfig ahora SIEMBRA los rubros con default → la pantalla muestra lo que se contabiliza.
  const cfg = ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  assert.equal(String(cfg.accounts.byDepartment.ADMINISTRATIVO.sueldo), code601, 'sueldo sembrado con 6.1.01');
  assert.equal(String(cfg.accounts.byDepartment.ADMINISTRATIVO.vacacionesGasto), await accId(clinicId, '6.1.07'), 'vacacionesGasto sembrado');
  assert.equal(String(cfg.accounts.global.dec3Pasivo), code210303, 'dec3Pasivo sembrado con 2.1.03.03');
  assert.equal(String(cfg.accounts.global.vacacionesPasivo), await accId(clinicId, '2.1.03.06'), 'vacacionesPasivo sembrado');

  // …y los rubros SIN default de posteo siguen vacíos (la contadora los asigna a mano).
  assert.ok(!cfg.accounts.global.comisariato, 'comisariato (sin default) sigue vacío');
  assert.ok(!cfg.accounts.byDepartment.ADMINISTRATIVO.alimentacion, 'alimentación (sin default) sigue vacía');

  // 5) El asiento del rol usa EXACTAMENTE las cuentas ahora visibles.
  const despues = await buildPayrollEntryLines({ periodType: 'MENSUAL', items: [rolItem] }, { clinicId });
  const gastoSueldo = despues.lines.find((l) => String(l.account) === String(cfg.accounts.byDepartment.ADMINISTRATIVO.sueldo));
  const dec3PasivoLine = despues.lines.find((l) => String(l.account) === String(cfg.accounts.global.dec3Pasivo));
  assert.ok(gastoSueldo && gastoSueldo.debit === 1000, 'el gasto de sueldo pega a la cuenta visible de sueldo');
  assert.ok(dec3PasivoLine && dec3PasivoLine.credit === 83.33, 'el décimo tercero por pagar pega a la cuenta visible de dec3Pasivo');
});

test('d2) getConfig es idempotente: una segunda carga no cambia nada ni duplica', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const first = ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  const second = ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  assert.equal(String(second.accounts.byDepartment.ADMINISTRATIVO.sueldo), String(first.accounts.byDepartment.ADMINISTRATIVO.sueldo));
  assert.equal(await PayrollConfig.countDocuments({ clinic: clinicId }), 1, 'una sola config');
});
