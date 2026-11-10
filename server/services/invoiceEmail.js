const nodemailer = require('nodemailer');
const Invoice = require('../models/Invoice');
const Clinic = require('../models/Clinic');
const { configDeEmpresa } = require('./puntoEmision');
const { decrypt } = require('../modules/invoicing/ec/crypto');
const { buildRidePdf } = require('../modules/invoicing/ec/ride');

const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

function transportFor(config) {
  if (!config?.smtpEnabled || !config.smtpHost || !config.smtpPort || !config.smtpUser || !config.smtpPassword || !validEmail(config.emailRemitente)) {
    throw new Error('El correo de facturación no está configurado o está desactivado.');
  }
  return nodemailer.createTransport({
    host: config.smtpHost, port: config.smtpPort, secure: !!config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: { user: config.smtpUser, pass: decrypt(config.smtpPassword) },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}

async function verifyTransport(config) {
  const transport = transportFor(config);
  try { await transport.verify(); } finally { transport.close(); }
}

async function deliverInvoice(invoice, config, deps = {}) {
  const recipient = invoice.emailDelivery?.recipient || invoice.emailComprador;
  if (!validEmail(recipient)) throw new Error('La factura no tiene un correo de comprador válido.');
  if (!invoice.xmlAutorizado) throw new Error('La factura no tiene XML autorizado.');
  const clinic = await Clinic.findById(invoice.clinic);
  const sale = await require('../models/Sale').findById(invoice.sale);
  const pdf = await (deps.buildPdf || buildRidePdf)({ invoice, sale, clinic, config, autorizacion: { fechaAutorizacion: invoice.fechaAutorizacion } });
  const number = `${invoice.estab}-${invoice.ptoEmi}-${invoice.secuencial}`;
  const transport = deps.transport || transportFor(config);
  try {
    const result = await transport.sendMail({
      from: { name: config.nombreComercial || config.razonSocial || 'Facturación', address: config.emailRemitente },
      to: recipient.trim(),
      subject: `Factura electrónica ${number}`,
      text: `Adjuntamos su factura electrónica ${number} autorizada por el SRI.`,
      attachments: [
        { filename: `factura-${number}.pdf`, content: pdf, contentType: 'application/pdf' },
        { filename: `factura-${number}.xml`, content: invoice.xmlAutorizado, contentType: 'application/xml' },
      ],
    });
    if (!result.accepted?.length) throw new Error('El servidor de correo no aceptó el destinatario.');
  } finally { transport.close(); }
}

async function processInvoiceEmails({ limit = 20, deliver = deliverInvoice, getConfig = configDeEmpresa } = {}) {
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + 5 * 60 * 1000);
    const invoice = await Invoice.findOneAndUpdate({
      estado: 'AUTORIZADO',
      $or: [
        { 'emailDelivery.status': 'PENDIENTE', $or: [{ 'emailDelivery.nextAttempt': null }, { 'emailDelivery.nextAttempt': { $lte: now } }] },
        { 'emailDelivery.status': 'ENVIANDO', 'emailDelivery.lockedUntil': { $lte: now } },
      ],
    }, { $set: { 'emailDelivery.status': 'ENVIANDO', 'emailDelivery.lockedUntil': lockedUntil }, $inc: { 'emailDelivery.attempts': 1 } },
    { new: true, sort: { createdAt: 1 } });
    if (!invoice) break;
    const claim = { _id: invoice._id, 'emailDelivery.status': 'ENVIANDO', 'emailDelivery.lockedUntil': lockedUntil };
    try {
      const config = await getConfig(invoice.clinic);
      await deliver(invoice, config);
      await Invoice.updateOne(claim, { $set: { 'emailDelivery.status': 'ENVIADO', 'emailDelivery.sentAt': new Date(), 'emailDelivery.error': '', 'emailDelivery.lockedUntil': null } });
    } catch (error) {
      const attempts = invoice.emailDelivery.attempts;
      const final = attempts >= 5 || !validEmail(invoice.emailDelivery?.recipient || invoice.emailComprador);
      await Invoice.updateOne(claim, { $set: { 'emailDelivery.status': final ? 'ERROR' : 'PENDIENTE',
        'emailDelivery.error': 'No se pudo enviar. Revise el correo del comprador y la configuración SMTP.',
        'emailDelivery.nextAttempt': final ? null : new Date(Date.now() + Math.min(60, 2 ** attempts) * 60000), 'emailDelivery.lockedUntil': null } });
      console.error('[invoiceEmail] No se pudo enviar factura', String(invoice._id), error.code || error.name);
    }
  }
}

module.exports = { validEmail, transportFor, verifyTransport, deliverInvoice, processInvoiceEmails };
