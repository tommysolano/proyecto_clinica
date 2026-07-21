/**
 * Endpoints de configuración de nómina (nueva estructura de cuentas):
 *  - getConfig siembra los 4 departamentos estándar y una config con cuentas predeterminadas;
 *  - updateConfig NO revienta con selects vacíos ('' → null) — bug 3.3 capturado en video;
 *  - copyDepartmentAccounts copia las cuentas de gasto de un departamento a otro;
 *  - los cargos se crean contra los departamentos estándar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payroll = require('../controllers/payrollController');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const ChartOfAccount = require('../models/ChartOfAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const req = (clinicId, userId, body = {}, extra = {}) => H.mockReq(clinicId, userId, body, extra);
const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.payload)); return r.payload; };

test('a/d) getConfig siembra 4 deptos estándar + cuentas predeterminadas; los cargos usan esos deptos', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const cfg = ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  // 4 departamentos estándar sembrados.
  const depts = await PayrollDepartment.find({ clinic: clinicId }).sort({ name: 1 });
  const tipos = depts.map((d) => d.type).sort();
  assert.deepEqual(tipos, ['ADMINISTRATIVO', 'COSTOS', 'OTROS', 'VENTAS']);
  // Cuentas centrales predeterminadas presentes (p.ej. sueldos por pagar y el sueldo por depto).
  assert.ok(cfg.accounts.global.sueldosPorPagar, 'sueldos por pagar predeterminado');
  assert.ok(cfg.accounts.byDepartment.ADMINISTRATIVO.sueldo, 'sueldo Administrativo predeterminado');

  // Un cargo se crea contra un departamento estándar.
  const admin = depts.find((d) => d.type === 'ADMINISTRATIVO');
  const pos = ok(await H.runController(payroll.createPosition, req(clinicId, userId, { name: 'Contadora', department: String(admin._id) })), 201);
  assert.equal(String(pos.department), String(admin._id));
});

test('a) updateConfig NO revienta con selects vacíos: "" se guarda como null (bug 3.3)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  const sueldos = await ChartOfAccount.findOne({ clinic: clinicId, code: '2.1.03.01' });
  // Payload con cuentas vacías en varios campos (como envía el formulario sin seleccionar).
  const r = ok(await H.runController(payroll.updateConfig, req(clinicId, userId, {
    accounts: {
      global: { sueldosPorPagar: String(sueldos._id), comisariato: '', farmacia: '', beneficios: '' },
      byDepartment: { ADMINISTRATIVO: { sueldo: '', alimentacion: '' }, VENTAS: {}, COSTOS: {}, OTROS: {} },
    },
  })));
  assert.ok(r, 'guardó sin error de cast a ObjectId');
  const saved = await PayrollConfig.findOne({ clinic: clinicId });
  assert.equal(String(saved.accounts.global.sueldosPorPagar), String(sueldos._id), 'la cuenta elegida se guarda');
  assert.equal(saved.accounts.global.comisariato, null, '"" se guardó como null');
  assert.equal(saved.accounts.byDepartment.ADMINISTRATIVO.sueldo, null, '"" por departamento se guardó como null');
});

test('copyDepartmentAccounts copia las cuentas de gasto de un departamento a otro', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  ok(await H.runController(payroll.getConfig, req(clinicId, userId)));
  const alim = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.01' });
  // Configura Administrativo con una cuenta de alimentación y copia a Ventas.
  await PayrollConfig.findOneAndUpdate({ clinic: clinicId }, { $set: { 'accounts.byDepartment.ADMINISTRATIVO.alimentacion': alim._id } });
  const r = ok(await H.runController(payroll.copyDepartmentAccounts, req(clinicId, userId, { from: 'ADMINISTRATIVO', to: 'VENTAS' })));
  assert.equal(String(r.accounts.byDepartment.VENTAS.alimentacion), String(alim._id), 'Ventas recibió la cuenta de Administrativo');
  // Origen/destino inválidos → 400.
  const bad = await H.runController(payroll.copyDepartmentAccounts, req(clinicId, userId, { from: 'ADMINISTRATIVO', to: 'ADMINISTRATIVO' }));
  assert.equal(bad.statusCode, 400);
});
