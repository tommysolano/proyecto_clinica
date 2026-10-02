const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const controller = require('../controllers/bankController');
const Account = require('../models/ChartOfAccount');
const Bank = require('../models/BankAccount');
const Movement = require('../models/BankTransaction');
const Journal = require('../models/JournalEntry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('Banco importado muestra saldo y movimientos del mayor, incluso en el dia de corte', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const bankAccount = await Account.create({ clinic: clinicId, code: '1.1.1.3',
    name: 'Banco Pichincha', type: 'ACTIVO', nature: 'DEBITO' });
  const counterpart = await Account.create({ clinic: clinicId, code: '9.9.1',
    name: 'Cuenta de prueba', type: 'ACTIVO', nature: 'DEBITO' });
  const bank = await Bank.create({ clinic: clinicId, name: 'Banco Pichincha',
    bank: 'BANCO PICHINCHA', accountNumber: '2100343419', chartAccount: bankAccount._id,
    initialBalance: 0 });
  await Journal.create([
    { clinic: clinicId, number: 'CTF-DEPOSITO', date: new Date('2026-09-17T12:00:00Z'),
      description: 'Deposito de caja', lines: [
        { account: bankAccount._id, debit: 100, credit: 0 },
        { account: counterpart._id, debit: 0, credit: 100 } ] },
    { clinic: clinicId, number: 'CTF-PAGO', date: new Date('2026-09-30T12:00:00Z'),
      description: 'Pago de proveedor', lines: [
        { account: counterpart._id, debit: 30, credit: 0 },
        { account: bankAccount._id, debit: 0, credit: 30 } ] },
  ]);
  // El auxiliar importado puede estar incompleto: no debe gobernar el saldo.
  await Movement.create({ clinic: clinicId, bankAccount: bank._id,
    date: new Date('2026-09-30T12:00:00Z'), type: 'COBRO', amount: 5, direction: 1 });

  const balances = await H.runController(controller.balances,
    H.mockReq(clinicId, userId));
  assert.equal(balances.statusCode, 200);
  const found = balances.payload.find((row) => String(row._id) === String(bank._id));
  assert.equal(found.bookBalance, 70);
  assert.equal(found.operationalBalance, 5);
  assert.equal(found.balanceSource, 'JOURNAL');

  const ledger = await H.runController(controller.bankLedger,
    H.mockReq(clinicId, userId, {}, { params: { id: String(bank._id) },
      query: { startDate: '2026-09-30', cutDate: '2026-09-30' } }));
  assert.equal(ledger.statusCode, 200);
  assert.equal(ledger.payload.source, 'JOURNAL');
  assert.equal(ledger.payload.opening, 100);
  assert.equal(ledger.payload.rows.length, 1);
  assert.equal(ledger.payload.rows[0].reference, 'CTF-PAGO');
  assert.equal(ledger.payload.totalOut, 30);
  assert.equal(ledger.payload.closing, 70);
});
