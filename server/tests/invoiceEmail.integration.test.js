const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Invoice = require('../models/Invoice');
const InvoicingConfig = require('../models/InvoicingConfig');
const configCtrl = require('../controllers/invoicingConfigController');
const invoiceCtrl = require('../controllers/invoiceController');
const email = require('../services/invoiceEmail');

process.env.INVOICE_ENCRYPTION_KEY = 'clave-de-prueba-para-el-cifrado';
test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

const smtp = { enabled: true, from: 'facturas@example.com', host: 'smtp.example.com', port: 587, secure: false, user: 'facturas@example.com', password: 'secreto-prueba' };
const makeInvoice = (clinic, fields = {}) => Invoice.create({ clinic, claveAcceso: String(Math.random()), secuencial: '000000001', estab: '001', ptoEmi: '001', ambiente: '2', fechaEmision: '10/11/2026', estado: 'AUTORIZADO', emailComprador: 'cliente@example.com', xmlAutorizado: '<factura/>', ...fields });

test('configuración SMTP cifra y oculta la contraseña y permite conservarla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const save = async (body) => H.runController(configCtrl.saveEmailConfig, H.mockReq(clinicId, userId, body));
  const first = await save(smtp);
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.smtpPassword, undefined);
  assert.equal(first.payload.smtpPasswordConfigured, true);
  const stored = await InvoicingConfig.findOne({ clinic: clinicId });
  assert.notEqual(stored.smtpPassword, smtp.password);
  const second = await save({ ...smtp, password: '' });
  assert.equal(second.statusCode, 200);
  assert.equal((await InvoicingConfig.findOne({ clinic: clinicId })).smtpPassword, stored.smtpPassword);
  const read = await H.runController(configCtrl.getConfig, H.mockReq(clinicId, userId));
  assert.equal(read.payload.smtpPassword, undefined);
});

test('cola espera autorización, reclama una vez y registra éxito o error', async () => {
  const { clinicId } = await H.seedClinic();
  const ready = await makeInvoice(clinicId, { emailDelivery: { status: 'PENDIENTE', recipient: 'cliente@example.com' } });
  const waiting = await makeInvoice(clinicId, { estado: 'EN_COLA', emailDelivery: { status: 'PENDIENTE' } });
  let count = 0;
  const options = { getConfig: async () => ({}), deliver: async () => { count++; } };
  await Promise.all([email.processInvoiceEmails(options), email.processInvoiceEmails(options)]);
  assert.equal(count, 1);
  assert.equal((await Invoice.findById(ready._id)).emailDelivery.status, 'ENVIADO');
  assert.equal((await Invoice.findById(waiting._id)).emailDelivery.status, 'PENDIENTE');
  const failed = await makeInvoice(clinicId, { emailDelivery: { status: 'PENDIENTE', recipient: 'incorrecto' } });
  await email.processInvoiceEmails({ ...options, deliver: async () => { throw new Error('fallo'); } });
  assert.equal((await Invoice.findById(failed._id)).emailDelivery.status, 'ERROR');
});

test('envío adjunta PDF y XML al destinatario y no acepta direcciones inválidas', async () => {
  const { clinicId } = await H.seedClinic();
  const invoice = await makeInvoice(clinicId, { emailDelivery: { recipient: 'cliente@example.com' } });
  let message;
  const transport = { sendMail: async (m) => { message = m; return { accepted: [m.to] }; }, close() {} };
  await email.deliverInvoice(invoice, { emailRemitente: 'facturas@example.com', razonSocial: 'Clínica' }, { transport, buildPdf: async () => Buffer.from('pdf') });
  assert.equal(message.to, 'cliente@example.com');
  assert.deepEqual(message.attachments.map((a) => a.contentType), ['application/pdf', 'application/xml']);
  assert.equal(message.attachments[1].content, '<factura/>');
  invoice.emailDelivery.recipient = 'no-es-correo';
  await assert.rejects(() => email.deliverInvoice(invoice, {}, { transport }), /correo/);
});

test('reenvío manual requiere autorización y respeta el alcance de la clínica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const other = await H.seedClinic();
  await InvoicingConfig.create({ clinic: clinicId, smtpEnabled: true });
  const invoice = await makeInvoice(clinicId);
  const run = (clinic, id, body) => H.runController(invoiceCtrl.queueEmail, H.mockReq(clinic, userId, body, { params: { id } }));
  assert.equal((await run(other.clinicId, invoice._id, { email: 'cliente@example.com' })).statusCode, 404);
  assert.equal((await run(clinicId, invoice._id, { email: 'mal' })).statusCode, 400);
  assert.equal((await run(clinicId, invoice._id, { email: 'cliente@example.com' })).statusCode, 200);
  assert.equal((await run(clinicId, invoice._id, { email: 'cliente@example.com' })).statusCode, 409);
});
