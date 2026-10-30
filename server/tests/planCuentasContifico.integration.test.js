/**
 * PLAN DE CUENTAS = EL DE CONTÍFICO (30-10-2026). La sincronización completa en cada
 * sucursal de la empresa las cuentas que Contífico tiene y aquí faltan, sin tocar las que
 * ya existen, y deja marcadas las de IVA: así una venta con IVA no falla con
 * «Cuenta contable no encontrada: IVA_VENTAS».
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Company = require('../models/Company');
const ChartOfAccount = require('../models/ChartOfAccount');
const Record = require('../models/ContificoRecord');
const { invalidateCompanyCache } = require('../utils/companies');
const { syncChartOfAccounts } = require('../services/contificoChartSync');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); invalidateCompanyCache(); });

// Muestra con la forma y los códigos del plan real de Contífico.
const PLAN = [
  { id: 'a1', codigo: '1', nombre: 'ACTIVO', tipo: 'G' },
  { id: 'a2', codigo: '1.1', nombre: 'Activo Corriente', tipo: 'G' },
  { id: 'a3', codigo: '1.1.5', nombre: 'Activos por Impuestos Corrientes', tipo: 'G' },
  { id: 'a4', codigo: '1.1.5.1', nombre: 'IVA sobre Compras', tipo: 'G' },
  { id: 'a5', codigo: '1.1.5.1.1', nombre: 'IVA sobre Compras', tipo: 'C' },
  { id: 'p1', codigo: '2', nombre: 'PASIVO', tipo: 'G' },
  { id: 'p2', codigo: '2.1', nombre: 'Pasivo Corriente', tipo: 'G' },
  { id: 'p3', codigo: '2.1.7', nombre: 'Obligaciones con la Administración Tributaria', tipo: 'G' },
  { id: 'p4', codigo: '2.1.7.4', nombre: 'IVA Sobre Ventas', tipo: 'G' },
  { id: 'p5', codigo: '2.1.7.4.1', nombre: 'IVA sobre Ventas', tipo: 'C' },
  { id: 'g1', codigo: '5.2.1.2.45', nombre: 'IVA Gasto Adm.', tipo: 'C' },
];
const apiFalsa = () => ({ listV1: async () => PLAN.map((row) => ({ ...row })) });

async function empresaConDosSucursales() {
  const company = await Company.create({ name: 'Shiluv', isDefault: true });
  const central = await Clinic.create({ name: 'Central', company: company._id });
  const extension = await Clinic.create({ name: 'Extensión', company: company._id });
  invalidateCompanyCache();
  return { central, extension };
}

test('completa UN plan, el de la empresa (Central), con su padre, y marca las de IVA', async () => {
  const { central, extension } = await empresaConDosSucursales();
  // Central ya tenía «1» con otro nombre (lo puso el contador): no se toca.
  await ChartOfAccount.create({ clinic: central._id, code: '1', name: 'ACTIVOS (contador)', type: 'ACTIVO', nature: 'DEBITO', level: 1 });

  const r = await syncChartOfAccounts({ clinic: central, api: apiFalsa(), force: true });
  assert.equal(r.state, 'COMPLETED');

  const cuentas = await ChartOfAccount.find({ clinic: central._id }).lean();
  const porCodigo = new Map(cuentas.map((a) => [a.code, a]));
  for (const row of PLAN) assert.ok(porCodigo.has(row.codigo), `falta ${row.codigo}`);
  const ivaV = porCodigo.get('2.1.7.4.1');
  assert.equal(ivaV.type, 'PASIVO');
  assert.equal(ivaV.allowsMovement, true);
  assert.equal(String(ivaV.parent), String(porCodigo.get('2.1.7.4')._id));
  assert.equal(porCodigo.get('2.1.7.4').allowsMovement, false, 'una cuenta de grupo no lleva movimiento');
  assert.equal(ivaV.taxCode, 'IVA_VENTAS');
  assert.equal(porCodigo.get('1.1.5.1.1').taxCode, 'IVA_COMPRAS');
  assert.equal(porCodigo.get('5.2.1.2.45').taxCode, null, 'el IVA gasto no es IVA en ventas ni en compras');
  assert.equal(porCodigo.get('1').name, 'ACTIVOS (contador)');
  assert.equal(await Record.countDocuments({ clinic: central._id, entity: 'chart_account' }), PLAN.length);
  assert.equal(await ChartOfAccount.countDocuments({ clinic: extension._id }), 0, 'el plan no se duplica en cada sucursal');

  // Segunda vuelta: nada nuevo.
  const otra = await syncChartOfAccounts({ clinic: central, api: apiFalsa(), force: true });
  assert.deepEqual(otra.created, []);
});

test('la sucursal que cobra con IVA toma la cuenta del plan de la empresa', async () => {
  const { central, extension } = await empresaConDosSucursales();
  await syncChartOfAccounts({ clinic: central, api: apiFalsa(), force: true });
  const { getAccount } = require('../utils/accountMap');
  const acc = await getAccount(extension._id, 'ivaVentas');
  assert.equal(acc.code, '2.1.7.4.1');
  assert.equal(String(acc.clinic), String(extension._id), 'el asiento de la sucursal usa la cuenta en su plan');
  const padre = await ChartOfAccount.findById(acc.parent).lean();
  assert.equal(padre.code, '2.1.7.4');
  assert.equal((await ChartOfAccount.findById(acc._id)).taxCode, 'IVA_VENTAS');
  assert.equal(await ChartOfAccount.countDocuments({ clinic: extension._id }), 5, 'solo la cuenta y sus padres');
});

test('una sucursal que ya tiene su IVA en ventas marcado lo conserva', async () => {
  const { central } = await empresaConDosSucursales();
  const { seedChartOfAccounts } = require('../utils/accounting');
  await seedChartOfAccounts(central._id);
  await syncChartOfAccounts({ clinic: central, api: apiFalsa(), force: true });
  const marcadas = await ChartOfAccount.find({ clinic: central._id, taxCode: 'IVA_VENTAS' }).lean();
  assert.deepEqual(marcadas.map((a) => a.code), ['2.1.02.01']);
  assert.ok(mongoose.isValidObjectId(marcadas[0]._id));
});
