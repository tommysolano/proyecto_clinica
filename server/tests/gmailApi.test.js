const test = require('node:test');
const assert = require('node:assert/strict');
const { encrypt } = require('../modules/invoicing/ec/crypto');
const gmail = require('../services/gmailApi');

test('Gmail envía el MIME por HTTPS con autenticación renovada y adjuntos', async () => {
  process.env.INVOICE_ENCRYPTION_KEY = 'clave-de-prueba-para-el-cifrado';
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('/token') ? { access_token: 'access' } : { id: 'sent' } };
  };
  try {
    await gmail.send({ gmailClientId: 'id', gmailClientSecret: encrypt('secret'), gmailRefreshToken: encrypt('refresh'), gmailAccount: 'a@gmail.com', emailRemitente: 'a@gmail.com' }, {
      from: 'a@gmail.com', to: 'b@example.com', subject: 'Factura', text: 'Adjunto', attachments: [{ filename: 'factura.pdf', content: Buffer.from('pdf') }, { filename: 'factura.xml', content: '<xml/>' }],
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer access');
    const raw = Buffer.from(JSON.parse(calls[1].options.body).raw, 'base64url').toString();
    assert.match(raw, /factura\.pdf/); assert.match(raw, /factura\.xml/);
    await assert.rejects(() => gmail.send({ gmailAccount: 'otro@gmail.com', emailRemitente: 'a@gmail.com' }, {}), { code: 'GMAIL_CONFIG' });
  } finally { global.fetch = original; }
});
