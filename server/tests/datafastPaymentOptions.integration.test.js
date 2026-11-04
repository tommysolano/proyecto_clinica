/**
 * Datafast siempre disponible en «Tarjeta / Adquirente» del cobro (nov-2026).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const CreditCard = require('../models/CreditCard');
const banks = require('../controllers/bankController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const opciones = (clinicId) => H.runController(banks.paymentOptions, H.mockReq(clinicId, null, {}, { role: 'cajero' }));

test('sin tarjeta de Datafast en la sucursal se crea una y sale primera; no se duplica', async () => {
  const { clinicId } = await H.seedClinic();
  await CreditCard.create({ clinic: clinicId, name: 'Amex', brand: 'AMEX', acquirer: 'Pacificard' });

  const r1 = await opciones(clinicId);
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.payload));
  assert.equal(r1.payload.cards[0].name, 'Datafast');
  assert.equal(r1.payload.cards.length, 2);

  await opciones(clinicId);
  assert.equal(await CreditCard.countDocuments({ clinic: clinicId, acquirer: 'Datafast' }), 1);
});

test('si la sucursal ya tiene una tarjeta de Datafast no se crea otra', async () => {
  const { clinicId } = await H.seedClinic();
  await CreditCard.create({ clinic: clinicId, name: 'Visa crédito', brand: 'VISA', acquirer: 'Datafast' });
  const r = await opciones(clinicId);
  assert.deepEqual(r.payload.cards.map((c) => c.name), ['Visa crédito']);
});
