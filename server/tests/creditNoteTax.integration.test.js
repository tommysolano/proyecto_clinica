const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Invoice = require('../models/Invoice');
const notes = require('../controllers/creditDebitNoteController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('la nota conserva la tarifa real y rechaza un IVA que no concilia', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const invoice = await Invoice.create({ clinic: clinicId,
    claveAcceso: 'CLV-NC-TAX-01', secuencial: '000000001', estab: '001', ptoEmi: '001', ambiente: '1',
    fechaEmision: '09/10/2026', estado: 'AUTORIZADO',
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: 100, totalImpuesto: 5, importeTotal: 105, balance: 105,
  });
  const makeReq = (iva) => H.mockReq(clinicId, userId, {
    kind: 'NC', direction: 'EMITIDA', refModel: 'Invoice', refDoc: invoice._id,
    motivo: 'Corrección', subtotal: 100, iva, total: 100 + iva,
  });
  const bad = await H.runController(notes.create, makeReq(7));
  assert.equal(bad.statusCode, 400);
  const good = await H.runController(notes.create, makeReq(5));
  assert.equal(good.statusCode, 201, JSON.stringify(good.payload));
  assert.equal(good.payload.ivaRate, 5);
  assert.equal(good.payload.taxBreakdown.baseGravada, 100);
});
