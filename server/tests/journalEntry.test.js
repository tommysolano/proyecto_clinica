const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry');

test('journal entry keeps reversal audit fields without changing posted status', async () => {
  const accountA = new mongoose.Types.ObjectId();
  const accountB = new mongoose.Types.ObjectId();
  const entry = new JournalEntry({
    clinic: new mongoose.Types.ObjectId(),
    number: 'AS-2026-000001',
    date: new Date('2026-06-16T00:00:00.000Z'),
    source: 'MANUAL',
    lines: [
      { account: accountA, debit: 25, credit: 0 },
      { account: accountB, debit: 0, credit: 25 },
    ],
    status: 'CONTABILIZADO',
  });

  await entry.validate();

  assert.equal(entry.status, 'CONTABILIZADO');
  assert.equal(entry.isReversed, false);
  assert.equal(entry.totalDebit, 25);
  assert.equal(entry.totalCredit, 25);
});
