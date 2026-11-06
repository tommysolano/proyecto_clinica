/**
 * UN PLAN DE CUENTAS Y UNOS BANCOS PARA TODA LA EMPRESA (nov-2026).
 *
 * Casos reales:
 *  - La contadora crea una cuenta en el plan y «no aparece»: el plan vive en Central, pero
 *    cada sucursal registra en SU libro con SU plan, y el asiento rechazaba la cuenta nueva.
 *  - Los bancos están creados en Central; al cobrar por transferencia en Laboratorio o
 *    Extensión el selector salía vacío (54 transferencias sin banco, fuera de la conciliación).
 *  - Contabilidad escoge la caja abierta de un cajero en «Caja e ingresos» y registra un vale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const CashClosing = require('../models/CashClosing');
require('../models/User');
require('../models/PuntoEmision');
const JournalEntry = require('../models/JournalEntry');
const banks = require('../controllers/bankController');
const cashPanel = require('../controllers/cashPanelController');
const cajaSeleccionada = require('../middleware/cajaSeleccionada');
const { createEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { clinicaDelPlan } = require('../utils/planEmpresa');
const { bancoDeEmpresa } = require('../utils/bancosEmpresa');
const { journalBalances } = require('../services/bankJournalLedger');
const { invalidateCompanyCache } = require('../utils/companies');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); invalidateCompanyCache(); });

async function empresa() {
  const company = await Company.create({ name: 'SHILUV', isDefault: true });
  const central = await H.seedClinic();
  const lab = await H.seedClinic();
  await Clinic.collection.insertMany([
    { _id: central.clinicId, name: 'Central', active: true, company: company._id },
    { _id: lab.clinicId, name: 'Laboratorio', active: true, company: company._id },
  ]);
  invalidateCompanyCache();
  return { central: central.clinicId, lab: lab.clinicId, userId: central.userId };
}

test('el plan de la empresa es el de Central, desde cualquier sucursal', async () => {
  const { central, lab } = await empresa();
  assert.equal(String(await clinicaDelPlan(lab)), String(central));
  assert.equal(String(await clinicaDelPlan(central)), String(central));
});

test('una cuenta NUEVA del plan de la empresa se usa en el asiento de una sucursal', async () => {
  const { central, lab, userId } = await empresa();
  const padre = await ChartOfAccount.findOne({ clinic: central, code: '6.1' });
  const nueva = await ChartOfAccount.create({
    clinic: central, code: '6.1.98', name: 'Seguros Adm', type: 'GASTO', nature: 'DEBITO',
    parent: padre?._id || null, level: 3, allowsMovement: true,
  });
  const caja = await getAccount(lab, 'caja');
  const asiento = await createEntry({
    clinicId: lab, date: new Date(), description: 'Vale', source: 'CAJA',
    lines: [
      { account: nueva._id, debit: 10, credit: 0 },
      { account: caja._id, debit: 0, credit: 10 },
    ],
    userId,
  });
  const copia = await ChartOfAccount.findOne({ clinic: lab, code: '6.1.98' });
  assert.ok(copia, 'la cuenta queda copiada en el plan de la sucursal');
  assert.equal(String(asiento.lines[0].account), String(copia._id), 'el asiento usa la copia de la sucursal');
});

test('una cuenta de OTRA empresa sigue rechazándose', async () => {
  const { lab, userId } = await empresa();
  const otra = await H.seedClinic();
  const ajena = await ChartOfAccount.findOne({ clinic: otra.clinicId, code: '6.1.99' })
    || await ChartOfAccount.findOne({ clinic: otra.clinicId, allowsMovement: true, type: 'GASTO' });
  const caja = await getAccount(lab, 'caja');
  await assert.rejects(createEntry({
    clinicId: lab, date: new Date(), description: 'x', source: 'CAJA',
    lines: [{ account: ajena._id, debit: 5, credit: 0 }, { account: caja._id, debit: 0, credit: 5 }],
    userId,
  }), /Cuenta no encontrada/);
});

test('los bancos de Central aparecen al cobrar en la sucursal y su saldo suma lo cobrado allí', async () => {
  const { central, lab, userId } = await empresa();
  const cuentaBanco = await getAccount(central, 'bancos');
  const banco = await BankAccount.create({ clinic: central, name: 'Pichincha', bank: 'BANCO PICHINCHA',
    accountNumber: '2100343419', chartAccount: cuentaBanco._id, active: true });

  const opciones = await H.runController(banks.paymentOptions, H.mockReq(lab, userId, {}, { role: 'cajero' }));
  assert.deepEqual(opciones.payload.accounts.map((a) => a.name), ['Pichincha'], 'el cajero de la sucursal ve el banco');
  assert.ok(await bancoDeEmpresa(banco._id, lab), 'la sucursal puede usarlo');

  // Cobro por transferencia en la sucursal: asiento en SU libro con la copia de la cuenta del banco.
  const ingresos = await getAccount(lab, 'ingresoServicios').catch(() => ChartOfAccount.findOne({ clinic: lab, type: 'INGRESO', allowsMovement: true }));
  await createEntry({
    clinicId: lab, date: new Date(), description: 'Venta por transferencia', source: 'VENTA',
    lines: [{ account: cuentaBanco._id, debit: 50, credit: 0 }, { account: ingresos._id, debit: 0, credit: 50 }],
    userId,
  });
  const saldos = await journalBalances(central, [cuentaBanco._id]);
  assert.equal(saldos.get(String(cuentaBanco._id)), 50, 'el saldo del banco (Central) incluye lo cobrado en la sucursal');
});

test('contabilidad escoge la caja abierta de otro usuario y el vale queda en esa caja', async () => {
  const { central, lab, userId } = await empresa();
  const cajero = new H.mongoose.Types.ObjectId();
  const caja = await CashClosing.create({ clinic: lab, status: 'ABIERTA', openedBy: cajero, openedAt: new Date(Date.now() - 3600e3), date: new Date() });

  const lista = await H.runController(cashPanel.cajasAbiertas, H.mockReq(central, userId, {}, { role: 'contabilidad' }));
  assert.ok(Array.isArray(lista.payload), JSON.stringify(lista.payload));
  assert.deepEqual(lista.payload.map((c) => String(c._id)), [String(caja._id)], 've las cajas abiertas de la empresa');

  const req = H.mockReq(central, userId, {}, { role: 'contabilidad', headers: { 'x-caja': String(caja._id) } });
  await new Promise((resolve, reject) => cajaSeleccionada(req, { status: () => ({ json: (p) => reject(new Error(p.message)) }) }, (e) => (e ? reject(e) : resolve())));
  assert.equal(String(req.clinicId), String(lab), 'pasa a la sucursal de la caja');

  const gasto = await ChartOfAccount.findOne({ clinic: central, type: 'GASTO', allowsMovement: true });
  req.body = { amount: 12, account: String(gasto._id), description: 'Taxi' };
  const r = await H.runController(cashPanel.crearVale, req);
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.movement.cashSession), String(caja._id), 'el vale entra en la caja escogida');
  const asiento = await JournalEntry.findById(r.payload.movement.journalEntry);
  assert.equal(String(asiento.createdBy), String(cajero), 'a nombre del dueño de la caja: su arqueo lo cuenta');

  // Un cajero no puede escoger otra caja.
  const cajeroReq = H.mockReq(lab, cajero, {}, { role: 'cajero', headers: { 'x-caja': String(caja._id) } });
  let codigo = 0;
  await cajaSeleccionada(cajeroReq, { status: (c) => { codigo = c; return { json: () => {} }; } }, () => {});
  assert.equal(codigo, 403);
});
