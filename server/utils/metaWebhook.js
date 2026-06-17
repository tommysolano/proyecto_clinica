const crypto = require('crypto');

function verifyMetaSignature({ rawBody, signature, appSecret }) {
  if (!appSecret) return { ok: true, skipped: true, reason: 'app_secret_not_configured' };
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!String(signature).startsWith('sha256=')) {
    return { ok: false, reason: 'invalid_signature_format' };
  }

  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {}));
  const expected = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(body)
    .digest('hex')}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(String(signature));
  if (expectedBuffer.length !== signatureBuffer.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

module.exports = { verifyMetaSignature };
