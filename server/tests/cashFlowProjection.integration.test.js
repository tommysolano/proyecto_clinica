/**
 * Flujo de caja con proyección de liquidez.
 * El reporte debe responder "¿con el efectivo de hoy más lo que me van a pagar
 * (CxC) alcanzo para cubrir las cuentas por pagar (CxP)?": disponible actual,
 * ingresos esperados, obligaciones vencidas/por vencer, saldo proyectado y alertas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

/** Asiento contabilizado: debita Caja general contra Ingresos por servicios. */
async function seedCash(clinicId, amount, { date = new Date(), number = 'AST-001' } = {}) {
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const ingreso = await ChartOfAccount.findOne({ clinic: clinicId, code: '4.1.01' });
  await JournalEntry.create({
    clinic: clinicId, number, date, description: 'Ingreso de caja (test)', source: 'MANUAL', status: 'CONTABILIZADO',
    lines: [
      { account: caja._id, accountCode: caja.code, accountName: caja.name, debit: amount, credit: 0 },
      { account: ingreso._id, accountCode: ingreso.code, accountName: ingreso.name, debit: 0, credit: amount },
    ],
  });
}

function makeDoc(clinicId, { total, applied = 0, dueDate, status, docType = 'COMPRA', name = 'Proveedor SA' }) {
  return {
    clinic: clinicId,
    party: { model: 'Supplier', ref: new H.mongoose.Types.ObjectId(), name },
    sourceModel: 'PurchaseInvoice',
    sourceRef: new H.mongoose.Types.ObjectId(),
    docType,
    number: `001-001-${Math.floor(Math.random() * 1e9)}`,
    issueDate: daysFromNow(-30),
    dueDate,
    total,
    applied,
    ...(status ? { status } : {}),
  };
}

async function runCashFlow(clinicId, userId, query = {}) {
  const r = await H.runController(reports.cashFlow, H.mockReq(clinicId, userId, {}, { query }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  return r.payload;
}

// ─────────────────────────────────────────────────────────────────────────────
test('1) proyección: disponible + CxC − CxP con desglose vencido / por vencer', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedCash(clinicId, 1000);

  // CxP: una vencida (hace 10 días), una por vencer (en 10 días).
  await Payable.create(makeDoc(clinicId, { total: 300, dueDate: daysFromNow(-10) }));
  await Payable.create(makeDoc(clinicId, { total: 200, dueDate: daysFromNow(10) }));
  // CxP pagada y anulada: NO deben entrar en la proyección.
  await Payable.create(makeDoc(clinicId, { total: 400, applied: 400, dueDate: daysFromNow(-5) }));
  await Payable.create(makeDoc(clinicId, { total: 999, dueDate: daysFromNow(-5), status: 'ANULADO' }));
  // CxC por vencer (ingreso esperado), una parcial (abona 50 de 200).
  await Receivable.create(makeDoc(clinicId, { total: 150, dueDate: daysFromNow(15), docType: 'VENTA', name: 'Paciente X' }));
  await Receivable.create(makeDoc(clinicId, { total: 200, applied: 50, dueDate: daysFromNow(-3), docType: 'VENTA', name: 'Paciente Y' }));

  const data = await runCashFlow(clinicId, userId);
  assert.equal(data.saldoFinal, 1000);

  const p = data.proyeccion;
  assert.ok(p, 'la respuesta incluye proyeccion');
  assert.equal(p.disponible, 1000, 'disponible = caja + bancos a hoy');
  assert.equal(p.cxp.total, 500, 'CxP abiertas: 300 + 200 (excluye pagada y anulada)');
  assert.equal(p.cxp.vencido, 300);
  assert.equal(p.cxp.porVencer, 200);
  assert.equal(p.cxp.count, 2);
  assert.equal(p.cxc.total, 300, 'CxC abiertas: 150 + saldo parcial 150');
  assert.equal(p.cxc.vencido, 150, 'la CxC parcial ya venció');
  assert.equal(p.cxc.porVencer, 150);
  assert.equal(p.saldoProyectado, 800, '1000 + 300 − 500');
  assert.equal(p.alertas.deficitProyectado, false);
  assert.equal(p.alertas.vencidasSuperanDisponible, false);

  // Detalle ordenado por vencimiento (la vencida primero) con días de atraso.
  assert.equal(p.cxp.docs.length, 2);
  assert.equal(p.cxp.docs[0].balance, 300);
  assert.ok(p.cxp.docs[0].dias > 0, 'la primera CxP está vencida');
  assert.ok(p.cxp.docs[1].dias < 0, 'la segunda CxP está por vencer');
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) alertas: obligaciones superan disponible + ingresos esperados', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedCash(clinicId, 100);
  await Payable.create(makeDoc(clinicId, { total: 500, dueDate: daysFromNow(-1) }));

  const p = (await runCashFlow(clinicId, userId)).proyeccion;
  assert.equal(p.saldoProyectado, -400, '100 + 0 − 500');
  assert.equal(p.alertas.deficitProyectado, true);
  assert.equal(p.alertas.vencidasSuperanDisponible, true, 'las vencidas (500) superan el disponible (100)');
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) el disponible de la proyección es a HOY aunque el período consultado sea pasado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedCash(clinicId, 600, { date: new Date('2026-05-10'), number: 'AST-001' });
  await seedCash(clinicId, 400, { date: new Date(), number: 'AST-002' });

  const data = await runCashFlow(clinicId, userId, { startDate: '2026-05-01', endDate: '2026-05-31' });
  assert.equal(data.saldoFinal, 600, 'el período de mayo solo ve el primer asiento');
  assert.equal(data.proyeccion.disponible, 1000, 'la proyección suma TODO el efectivo a hoy');
  assert.equal(data.proyeccion.saldoProyectado, 1000);
});
