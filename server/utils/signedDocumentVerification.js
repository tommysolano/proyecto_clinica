const crypto = require('crypto');
const QRCode = require('qrcode');
const SignedDocumentVerification = require('../models/SignedDocumentVerification');
const { estadoFirma } = require('./pdfSignature');

async function prepararVerificacion(user) {
  if (!estadoFirma(user).ok) return null;
  const base = process.env.PUBLIC_API_URL;
  let url;
  try {
    url = new URL(base);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error('Configure PUBLIC_API_URL con la URL pública HTTPS de la API para generar el QR de verificación.');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const enlace = `${url.toString().replace(/\/$/, '')}/verificar-documento/${token}`;
  return { token, qr: await QRCode.toDataURL(enlace, { errorCorrectionLevel: 'M', margin: 2, width: 300 }) };
}

async function registrarVerificacion(verificacion, pdf, tipo) {
  await SignedDocumentVerification.create({
    token: verificacion.token,
    sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
    tipo,
  });
}

module.exports = { prepararVerificacion, registrarVerificacion };
