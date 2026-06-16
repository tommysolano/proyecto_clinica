const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Receivable = require('../models/Receivable');

function makeReceivable(total, applied) {
  return new Receivable({
    clinic: new mongoose.Types.ObjectId(),
    party: { model: 'Patient', ref: new mongoose.Types.ObjectId(), name: 'Paciente' },
    sourceModel: 'Sale',
    sourceRef: new mongoose.Types.ObjectId(),
    docType: 'VENTA',
    issueDate: new Date('2026-06-16'),
    total,
    applied,
  });
}

test('receivable open with no applied amount is ABIERTO with full balance', async () => {
  const r = makeReceivable(100, 0);
  await r.validate();
  assert.equal(r.balance, 100);
  assert.equal(r.status, 'ABIERTO');
});

test('partial application leaves balance and PARCIAL status', async () => {
  const r = makeReceivable(100, 40);
  await r.validate();
  assert.equal(r.balance, 60);
  assert.equal(r.status, 'PARCIAL');
});

test('full application marks PAGADO with zero balance', async () => {
  const r = makeReceivable(100, 100);
  await r.validate();
  assert.equal(r.balance, 0);
  assert.equal(r.status, 'PAGADO');
});

test('balance is rounded to cents (avoids floating point residue)', async () => {
  const r = makeReceivable(0.3, 0.1);
  await r.validate();
  // 0.3 - 0.1 = 0.19999999998 en binario; debe redondear a 0.20.
  assert.equal(r.balance, 0.2);
  assert.equal(r.status, 'PARCIAL');
});

test('explicit ANULADO status is preserved', async () => {
  const r = makeReceivable(100, 0);
  r.status = 'ANULADO';
  await r.validate();
  assert.equal(r.status, 'ANULADO');
});
