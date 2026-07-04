/**
 * Libro Mayor con jerarquía de cuentas (cuentas padre que consolidan hijas) y
 * resumen bancario. Prueba el controller real contra Mongo en memoria.
 *   - consolidación padre → hijas (naturaleza DEBITO y CREDITO);
 *   - cuenta hija muestra solo sus movimientos;
 *   - resumen bancario (opening + entradas − salidas), ignorando anuladas;
 *   - rango de fechas usa inicio y fin del día.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const journal = require('../controllers/journalEntryController');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let seq = 0;
async function mkEntry(clinicId, userId, date, lines, extra = {}) {
  seq += 1;
  return JournalEntry.create({
    clinic: clinicId,
    number: `AS-${Date.now()}-${seq}`,
    date: new Date(date),
    source: extra.source || 'MANUAL',
    status: 'CONTABILIZADO',
    sourceModel: extra.sourceModel || null,
    sourceRef: extra.sourceRef || null,
    lines,
    createdBy: userId,
  });
}

async function makeChild(clinicId, { code, name, nature, parent }) {
  return ChartOfAccount.create({
    clinic: clinicId, code, name, type: nature === 'DEBITO' ? 'ACTIVO' : 'PASIVO',
    nature, parent, level: code.split('.').length, allowsMovement: true,
  });
}

function runLedger(clinicId, userId, query) {
  return H.runController(journal.ledger, H.mockReq(String(clinicId), String(userId), {}, { query }));
}

// ─────────────────────────────────────────────────────────────────────────────
test('cuenta padre DEBITO consolida movimientos de sus dos hijas', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const bancos = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  assert.ok(bancos, 'Bancos (1.1.01.03) debe existir en el plan');
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const c1 = await makeChild(clinicId, { code: '1.1.01.03.01', name: 'Pichincha', nature: 'DEBITO', parent: bancos._id });
  const c2 = await makeChild(clinicId, { code: '1.1.01.03.02', name: 'Guayaquil', nature: 'DEBITO', parent: bancos._id });

  // Anterior al rango → saldo inicial de la rama = 100.
  await mkEntry(clinicId, userId, '2026-05-15', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 100, credit: 0 },
    { account: caja._id, debit: 0, credit: 100 },
  ]);
  // En rango.
  await mkEntry(clinicId, userId, '2026-06-10', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 50, credit: 0 },
    { account: caja._id, debit: 0, credit: 50 },
  ], { source: 'BANCO', sourceModel: 'BankTransaction', sourceRef: userId });
  await mkEntry(clinicId, userId, '2026-06-20', [
    { account: c2._id, accountCode: c2.code, accountName: c2.name, debit: 0, credit: 30 },
    { account: caja._id, debit: 30, credit: 0 },
  ]);

  const { statusCode, payload } = await runLedger(clinicId, userId, { account: String(bancos._id), startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.equal(statusCode, 200, JSON.stringify(payload));
  assert.equal(payload.isParent, true);
  assert.equal(payload.includedAccounts.length, 3);
  assert.equal(payload.opening, 100);
  assert.equal(payload.debit, 50);
  assert.equal(payload.credit, 30);
  assert.equal(payload.movement, 20);
  assert.equal(payload.closing, 120);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].accountCode, '1.1.01.03.01');
  assert.ok(payload.rows[0].entryId, 'fila trae entryId para abrir el asiento');
  assert.equal(payload.rows[0].sourceModel, 'BankTransaction');
  assert.equal(payload.rows[1].accountCode, '1.1.01.03.02');
  assert.equal(payload.rows[1].saldo, 120);
});

// ─────────────────────────────────────────────────────────────────────────────
test('cuenta hija muestra solo sus propios movimientos', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const bancos = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const c1 = await makeChild(clinicId, { code: '1.1.01.03.01', name: 'Pichincha', nature: 'DEBITO', parent: bancos._id });
  const c2 = await makeChild(clinicId, { code: '1.1.01.03.02', name: 'Guayaquil', nature: 'DEBITO', parent: bancos._id });

  await mkEntry(clinicId, userId, '2026-06-10', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 50, credit: 0 },
    { account: caja._id, debit: 0, credit: 50 },
  ]);
  await mkEntry(clinicId, userId, '2026-06-20', [
    { account: c2._id, accountCode: c2.code, accountName: c2.name, debit: 0, credit: 30 },
    { account: caja._id, debit: 30, credit: 0 },
  ]);

  const { payload } = await runLedger(clinicId, userId, { account: String(c2._id), startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.equal(payload.isParent, false);
  assert.equal(payload.includedAccounts.length, 1);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].accountCode, '1.1.01.03.02');
  assert.equal(payload.closing, -30); // naturaleza DEBITO: 0 - 30
});

// ─────────────────────────────────────────────────────────────────────────────
test('cuenta padre CREDITO consolida saldo con naturaleza haber − debe', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  // Rama CREDITO propia (padre agrupador + dos hijas).
  const parent = await ChartOfAccount.create({ clinic: clinicId, code: '2.1.99', name: 'Otras CxP', type: 'PASIVO', nature: 'CREDITO', level: 2, allowsMovement: false });
  const h1 = await makeChild(clinicId, { code: '2.1.99.01', name: 'Proveedor A', nature: 'CREDITO', parent: parent._id });
  const h2 = await makeChild(clinicId, { code: '2.1.99.02', name: 'Proveedor B', nature: 'CREDITO', parent: parent._id });

  // Anterior al rango → saldo inicial CREDITO = 100 (haber).
  await mkEntry(clinicId, userId, '2026-05-15', [
    { account: caja._id, debit: 100, credit: 0 },
    { account: h1._id, accountCode: h1.code, accountName: h1.name, debit: 0, credit: 100 },
  ]);
  // En rango: haber 200 (h1) y debe 50 (h2).
  await mkEntry(clinicId, userId, '2026-06-10', [
    { account: caja._id, debit: 200, credit: 0 },
    { account: h1._id, accountCode: h1.code, accountName: h1.name, debit: 0, credit: 200 },
  ]);
  await mkEntry(clinicId, userId, '2026-06-20', [
    { account: h2._id, accountCode: h2.code, accountName: h2.name, debit: 50, credit: 0 },
    { account: caja._id, debit: 0, credit: 50 },
  ]);

  const { payload } = await runLedger(clinicId, userId, { account: String(parent._id), startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.equal(payload.isParent, true);
  assert.equal(payload.account.nature, 'CREDITO');
  assert.equal(payload.opening, 100);   // haber − debe anteriores = 100
  assert.equal(payload.debit, 50);      // débitos reales del período
  assert.equal(payload.credit, 200);    // créditos reales del período
  assert.equal(payload.movement, 150);  // 200 − 50 (naturaleza CREDITO)
  assert.equal(payload.closing, 250);   // 100 + 150
});

// ─────────────────────────────────────────────────────────────────────────────
test('cuenta padre Bancos devuelve bankSummary e ignora transacciones anuladas', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const bancos = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const c1 = await makeChild(clinicId, { code: '1.1.01.03.01', name: 'Pichincha', nature: 'DEBITO', parent: bancos._id });
  const c2 = await makeChild(clinicId, { code: '1.1.01.03.02', name: 'Guayaquil', nature: 'DEBITO', parent: bancos._id });

  const ba1 = await BankAccount.create({ clinic: clinicId, name: 'Pichincha Cte', bank: 'Pichincha', accountNumber: 'P-001', chartAccount: c1._id, initialBalance: 200 });
  const ba2 = await BankAccount.create({ clinic: clinicId, name: 'Guayaquil Aho', bank: 'Guayaquil', accountNumber: 'G-002', chartAccount: c2._id, initialBalance: 0 });

  // ba1: depósito anterior (entra a opening) + depósito y retiro en el período.
  await BankTransaction.create({ clinic: clinicId, bankAccount: ba1._id, date: new Date('2026-05-15'), type: 'DEPOSITO', amount: 100, direction: 1 });
  await BankTransaction.create({ clinic: clinicId, bankAccount: ba1._id, date: new Date('2026-06-10'), type: 'DEPOSITO', amount: 50, direction: 1 });
  await BankTransaction.create({ clinic: clinicId, bankAccount: ba1._id, date: new Date('2026-06-20'), type: 'RETIRO', amount: 20, direction: -1 });
  // ba2: un depósito válido + uno ANULADO (no debe contar).
  await BankTransaction.create({ clinic: clinicId, bankAccount: ba2._id, date: new Date('2026-06-20'), type: 'DEPOSITO', amount: 30, direction: 1 });
  await BankTransaction.create({ clinic: clinicId, bankAccount: ba2._id, date: new Date('2026-06-21'), type: 'DEPOSITO', amount: 999, direction: 1, voided: true });

  const { payload } = await runLedger(clinicId, userId, { account: String(bancos._id), startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.ok(payload.bankSummary, 'debe devolver bankSummary');
  assert.equal(payload.bankSummary.accounts.length, 2);
  const t = payload.bankSummary.totals;
  assert.equal(t.opening, 300);   // 200+100 (ba1) + 0 (ba2)
  assert.equal(t.inflow, 80);     // 50 (ba1) + 30 (ba2); NO cuenta la anulada de 999
  assert.equal(t.outflow, 20);
  assert.equal(t.closing, 360);   // 300 + 80 − 20

  const summaryBa2 = payload.bankSummary.accounts.find((a) => String(a.bankAccountId) === String(ba2._id));
  assert.equal(summaryBa2.inflow, 30, 'la transacción anulada de 999 no debe contar');
});

// ─────────────────────────────────────────────────────────────────────────────
test('el rango de fechas usa inicio y fin del día (inclusivo)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-15') });
  const bancos = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const c1 = await makeChild(clinicId, { code: '1.1.01.03.01', name: 'Pichincha', nature: 'DEBITO', parent: bancos._id });

  // Movimiento a última hora del ÚLTIMO día del rango → debe incluirse (endOfDay).
  await mkEntry(clinicId, userId, '2026-06-30T23:30:00', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 40, credit: 0 },
    { account: caja._id, debit: 0, credit: 40 },
  ]);
  // Movimiento a última hora del día ANTERIOR al rango → debe ir a saldo inicial.
  await mkEntry(clinicId, userId, '2026-05-31T23:30:00', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 10, credit: 0 },
    { account: caja._id, debit: 0, credit: 10 },
  ]);
  // Movimiento del día DESPUÉS del rango → NO debe incluirse.
  await mkEntry(clinicId, userId, '2026-07-01T00:10:00', [
    { account: c1._id, accountCode: c1.code, accountName: c1.name, debit: 5, credit: 0 },
    { account: caja._id, debit: 0, credit: 5 },
  ]);

  const { payload } = await runLedger(clinicId, userId, { account: String(bancos._id), startDate: '2026-06-01', endDate: '2026-06-30' });
  assert.equal(payload.opening, 10, 'movimiento del 31/05 23:30 cuenta como saldo inicial');
  assert.equal(payload.rows.length, 1, 'solo el movimiento del 30/06 23:30 entra al rango');
  assert.equal(payload.debit, 40);
  assert.equal(payload.closing, 50); // 10 + 40
});
