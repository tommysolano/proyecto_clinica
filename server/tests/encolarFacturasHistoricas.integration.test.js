const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Invoice = require('../models/Invoice');
const InvoicingConfig = require('../models/InvoicingConfig');
const gmail = require('../services/gmailApi');
const task = require('../scripts/encolarFacturasHistoricasOnce');

test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

test('encola solo facturas autorizadas y no enviadas dentro del corte y una sola vez', async () => {
  const { clinicId } = await H.seedClinic();
  await InvoicingConfig.create({ clinic: clinicId, emailProvider: 'gmail', emailRemitente: 'contabilidadshiluv@gmail.com', gmailAccount: 'contabilidadshiluv@gmail.com', gmailRefreshToken: 'cifrado', smtpEnabled: true });
  let number = 0;
  const add = async (fields = {}) => Invoice.create({ clinic: clinicId, claveAcceso: `test-${++number}`, secuencial: String(number), estab: '001', ptoEmi: '001', ambiente: '2', fechaEmision: '11/11/2026', estado: 'AUTORIZADO', xmlAutorizado: '<factura/>', emailComprador: 'paciente@example.com', createdAt: new Date('2026-11-11T17:26:59Z'), ...fields });
  const eligible = await add();
  const sent = await add({ emailDelivery: { status: 'ENVIADO', sentAt: new Date() } });
  const pending = await add({ emailDelivery: { status: 'PENDIENTE' } });
  const failed = await add({ emailDelivery: { status: 'ERROR', attempts: 5 } });
  const noEmail = await add({ emailComprador: '' });
  const late = await add({ createdAt: new Date('2026-11-11T17:27:00Z') });
  const noXml = await add({ xmlAutorizado: null });
  const testInvoice = await add({ ambiente: '1' });
  const oldVerify = gmail.verify; gmail.verify = async () => {};
  try {
    const preview = await task.run();
    assert.equal(preview.encoladas, 1);
    assert.notEqual((await Invoice.findById(eligible._id)).emailDelivery.status, 'PENDIENTE');
    const result = await task.run({ commit: true });
    assert.equal(result.encoladas, 1); assert.equal(result.sinDestinatarioSeguro, 1); assert.equal(result.sinXml, 1);
    const updated = await Invoice.findById(eligible._id);
    assert.equal(updated.emailDelivery.status, 'PENDIENTE');
    assert.equal(updated.emailDelivery.recipient, 'paciente@example.com');
    assert.equal(updated.emailDelivery.historicalBatch, task.KEY);
    for (const doc of [sent, pending, failed, noEmail, late, noXml, testInvoice]) assert.notEqual((await Invoice.findById(doc._id)).emailDelivery.historicalBatch, task.KEY);
    await task.run({ commit: true });
    assert.equal(await Invoice.countDocuments({ 'emailDelivery.historicalBatch': task.KEY }), 1);
  } finally { gmail.verify = oldVerify; }
});

test('validación de fechas de emisión', () => {
  assert.equal(task.invoiceDateInRange('29/10/2026'), true);
  assert.equal(task.invoiceDateInRange('11/11/2026'), true);
  assert.equal(task.invoiceDateInRange('28/10/2026'), false);
  assert.equal(task.invoiceDateInRange('31/11/2026'), false);
});
