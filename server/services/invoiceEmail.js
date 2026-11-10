const nodemailer = require('nodemailer');
const Invoice = require('../models/Invoice');
const Clinic = require('../models/Clinic');
const { configDeEmpresa } = require('./puntoEmision');
const { decrypt } = require('../modules/invoicing/ec/crypto');
const { buildRidePdf } = require('../modules/invoicing/ec/ride');

const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

function transportFor(config) {
  if (!config?.smtpEnabled || !config.smtpHost || !config.smtpPort || !config.smtpUser || !config.smtpPassword || !validEmail(config.emailRemitente)) {
    throw Object.assign(new Error('El correo de facturación no está configurado o está desactivado.'), { code: 'SMTP_CONFIG' });
  }
  let password;
  try { password = decrypt(config.smtpPassword); }
  catch (error) {
    const code = !process.env.INVOICE_ENCRYPTION_KEY || process.env.INVOICE_ENCRYPTION_KEY.length < 16 ? 'SMTP_ENCRYPTION_KEY' : 'SMTP_DECRYPT';
    throw Object.assign(new Error('No se pudo recuperar la contraseña SMTP guardada.'), { code, cause: error });
  }
  return nodemailer.createTransport({
    host: config.smtpHost, port: config.smtpPort, secure: !!config.smtpSecure,
    requireTLS: !config.smtpSecure,
    auth: { user: config.smtpUser, pass: password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}

// No devolver mensajes crudos: pueden contener datos del servidor o credenciales.
function describeSmtpError(error = {}) {
  const code = String(error.code || '').toUpperCase();
  const causeCode = String(error.cause?.code || error.errno || '').toUpperCase();
  const command = String(error.command || '').toUpperCase();
  const responseCode = Number(error.responseCode);
  let kind = 'SMTP_UNKNOWN';
  let message = 'No se pudo verificar la conexión SMTP. El servidor no proporcionó un diagnóstico identificable.';
  if (code === 'SMTP_CONFIG') { kind = code; message = 'La configuración SMTP está incompleta o el envío automático está desactivado.'; }
  else if (code === 'SMTP_ENCRYPTION_KEY') { kind = code; message = 'El servidor no tiene configurada correctamente la clave de cifrado de facturación. El administrador debe revisar INVOICE_ENCRYPTION_KEY.'; }
  else if (code === 'SMTP_DECRYPT') { kind = code; message = 'El servidor no pudo descifrar la contraseña SMTP guardada. Revise que la clave de cifrado sea la misma con la que se guardó.'; }
  else if (code === 'EAUTH' || command.startsWith('AUTH')) { kind = 'SMTP_AUTH'; message = 'El servidor SMTP rechazó la autenticación. Compruebe las credenciales y si el proveedor permite acceso SMTP a la cuenta.'; }
  else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || ['ENOTFOUND', 'EAI_AGAIN'].includes(causeCode) || command === 'DNS') { kind = 'SMTP_DNS'; message = 'No se pudo resolver el nombre del servidor SMTP desde el servidor de la clínica. Revise el nombre y la conexión DNS.'; }
  else if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) || ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(causeCode) || /TIMEOUT/i.test(String(error.message || ''))) { kind = 'SMTP_TIMEOUT'; message = 'La conexión SMTP agotó el tiempo de espera. Revise el puerto y la salida de red del servidor de la clínica.'; }
  else if (/CERT|TLS|SSL/.test(`${code} ${causeCode}`) || /wrong version number|certificate|ssl routines/i.test(String(error.message || '')) || command === 'STARTTLS') { kind = 'SMTP_TLS'; message = 'Falló la negociación segura TLS o la validación del certificado. Revise el puerto y la opción SSL/TLS directo.'; }
  else if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNECTION', 'ESOCKET'].includes(code) || ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(causeCode)) { kind = 'SMTP_CONNECTION'; message = 'No se pudo establecer o mantener la conexión SMTP desde el servidor de la clínica. Revise el puerto y la red.'; }
  else if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599) { kind = 'SMTP_REJECTED'; message = 'El servidor SMTP rechazó la conexión o la prueba. Consulte el código de respuesta con el proveedor.'; }
  const details = [];
  const safeCodes = new Set(['SMTP_CONFIG', 'SMTP_ENCRYPTION_KEY', 'SMTP_DECRYPT', 'EAUTH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNECTION', 'ESOCKET', 'ETLS', 'EPROTOCOL', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']);
  if (safeCodes.has(code)) details.push(`Código: ${code}`);
  if (safeCodes.has(causeCode) && causeCode !== code) details.push(`Causa: ${causeCode}`);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599) details.push(`Respuesta SMTP: ${responseCode}`);
  if (['CONN', 'DNS', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'AUTH LOGIN', 'AUTH PLAIN'].includes(command)) details.push(`Etapa: ${command}`);
  return { code: kind, message, details: details.join(' · ') };
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

module.exports = { validEmail, transportFor, verifyTransport, deliverInvoice, processInvoiceEmails, describeSmtpError };
