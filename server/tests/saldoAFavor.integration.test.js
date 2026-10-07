/**
 * SALDO A FAVOR DEL PACIENTE (oct-2026): paga 300 por un servicio de 100 porque
 * sigue un tratamiento. Se factura 100, entran 300, y los 200 quedan como
 * anticipo suyo (pasivo «Anticipos de clientes») para sus próximas ventas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const patients = require('../controllers/patientController');
const { saldoDisponible } = require('../utils/saldoAFavor');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405' });
  const servicio = await H.makeProduct(clinicId, {
    name: 'Sesión de terapia', category: 'servicio', unlimited: true, salePrice: 100, taxCategory: 'IVA_0', taxRate: 0,
  });
  return { clinicId, userId, patient, servicio };
}

const vender = (clinicId, userId, body) => H.runController(
  sales.createSale,
  H.mockReq(clinicId, userId, { date: H.docDate(), clientName: 'Ana Pérez', clientCedula: '0102030405', ...body }, { role: 'admin' })
);
const anular = (clinicId, userId, id) => H.runController(
  sales.cancelSale, H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(id) } })
);

async function lineasDe(entryId) {
  const e = await JournalEntry.findById(entryId).lean();
  const cuentas = await ChartOfAccount.find({ _id: { $in: e.lines.map((l) => l.account) } }).lean();
  const codigo = new Map(cuentas.map((c) => [String(c._id), c.code]));
  return e.lines.map((l) => ({ code: codigo.get(String(l.account)), debit: l.debit, credit: l.credit }));
}

test('paga 300 por 100: se factura 100, entran 300 y quedan 200 a favor (pasivo)', async () => {
  const { clinicId, userId, patient, servicio } = await seed();
  const r = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 300 }],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const venta = await Sale.findById(r.payload._id).lean();
  assert.equal(venta.total, 100, 'se factura solo lo vendido');
  assert.equal(venta.advanceCreated, 200);
  assert.equal(await saldoDisponible(clinicId, patient._id), 200);

  const lineas = await lineasDe(venta.journalEntry);
  const debe = lineas.reduce((s, l) => s + l.debit, 0);
  const haber = lineas.reduce((s, l) => s + l.credit, 0);
  assert.equal(+debe.toFixed(2), +haber.toFixed(2), 'el asiento cuadra');
  assert.ok(lineas.some((l) => l.debit === 300), 'entran los 300');
  assert.ok(lineas.some((l) => l.code === '2.1.01.03' && l.credit === 200), '200 a Anticipos de clientes');

  const ficha = await H.runController(patients.getSaldoAFavor, H.mockReq(clinicId, userId, {}, { role: 'cajero', params: { id: String(patient._id) } }));
  assert.equal(ficha.payload.saldo, 200);
  assert.equal(ficha.payload.movimientos[0].type, 'ANTICIPO');
});

test('el excedente exige paciente y dinero que entra', async () => {
  const { clinicId, userId, patient, servicio } = await seed();
  const sinPaciente = await vender(clinicId, userId, {
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 300 }],
  });
  assert.equal(sinPaciente.statusCode, 400);
  const aCredito = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 50 }, { method: 'credito', amount: 100 }],
    creditDays: 30,
  });
  assert.equal(aCredito.statusCode, 400);
  const corto = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 60 }],
  });
  assert.equal(corto.statusCode, 400, 'pagar menos sigue sin cuadrar');
  assert.equal(await Sale.countDocuments({}), 0);
});

test('se usa en la siguiente venta, no más de lo que tiene, y las anulaciones van en orden', async () => {
  const { clinicId, userId, patient, servicio } = await seed();
  const v1 = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'transferencia', amount: 300 }],
  });
  assert.equal(v1.statusCode, 201, JSON.stringify(v1.payload));

  // Siguiente sesión: se paga con el saldo.
  const v2 = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'anticipo', amount: 100 }],
  });
  assert.equal(v2.statusCode, 201, JSON.stringify(v2.payload));
  assert.equal(await saldoDisponible(clinicId, patient._id), 100);
  const l2 = await lineasDe((await Sale.findById(v2.payload._id).lean()).journalEntry);
  assert.ok(l2.some((l) => l.code === '2.1.01.03' && l.debit === 100), 'baja el pasivo');

  // No más de lo que tiene.
  const demas = await vender(clinicId, userId, {
    patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 2, unitPrice: 100 }],
    payments: [{ method: 'anticipo', amount: 200 }],
  });
  assert.equal(demas.statusCode, 400);
  assert.match(demas.payload.message || demas.payload.error || '', /saldo a favor/i);

  // Anular la que DEJÓ el saldo cuando ya se usó: no.
  const a1 = await anular(clinicId, userId, v1.payload._id);
  assert.equal(a1.statusCode, 400, JSON.stringify(a1.payload));
  assert.equal(await saldoDisponible(clinicId, patient._id), 100, 'nada cambió');

  // Primero la que lo usó; después ya se puede.
  assert.equal((await anular(clinicId, userId, v2.payload._id)).statusCode, 200);
  assert.equal(await saldoDisponible(clinicId, patient._id), 200);
  assert.equal((await anular(clinicId, userId, v1.payload._id)).statusCode, 200);
  assert.equal(await saldoDisponible(clinicId, patient._id), 0);
});

test('un cobro con anticipo de un paciente suma a su saldo y se revierte al anularlo', async () => {
  const { clinicId, userId, patient } = await seed();
  const r = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', date: H.docDate(),
    partyModel: 'Patient', partyRef: String(patient._id), partyName: 'Ana Pérez',
    applications: [], advanceAmount: 150,
  }, { role: 'admin' }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(await saldoDisponible(clinicId, patient._id), 150);
  const v = await H.runController(payments.void, H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(r.payload._id) } }));
  assert.equal(v.statusCode < 400, true, JSON.stringify(v.payload));
  assert.equal(await saldoDisponible(clinicId, patient._id), 0);
});
