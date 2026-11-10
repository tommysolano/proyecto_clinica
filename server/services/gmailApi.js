const nodemailer = require('nodemailer');
const { decrypt } = require('../modules/invoicing/ec/crypto');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'];

function credentials(config) {
  if (!config?.gmailClientId || !config.gmailClientSecret || !config.gmailRefreshToken || !config.gmailAccount || config.gmailAccount.toLowerCase() !== String(config.emailRemitente || '').toLowerCase()) {
    throw Object.assign(new Error('Conecte la cuenta de Gmail que figura como remitente.'), { code: 'GMAIL_CONFIG' });
  }
  try {
    return { client_id: config.gmailClientId, client_secret: decrypt(config.gmailClientSecret), refresh_token: decrypt(config.gmailRefreshToken) };
  } catch {
    throw Object.assign(new Error('No se pudieron recuperar las credenciales de Gmail.'), { code: 'GMAIL_CONFIG' });
  }
}

async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) }); }
  catch { throw Object.assign(new Error('No se pudo conectar con Google.'), { code: 'GMAIL_CONNECTION' }); }
  if (!response.ok) {
    const code = response.status === 400 || response.status === 401 || response.status === 403 ? 'GMAIL_AUTH' : 'GMAIL_CONNECTION';
    throw Object.assign(new Error('Google rechazó la solicitud.'), { code, status: response.status });
  }
  return response.json();
}

async function token(params) {
  const result = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  if (!result.access_token) throw Object.assign(new Error('Google no entregó un token.'), { code: 'GMAIL_AUTH' });
  return result;
}

async function accessToken(config) {
  return (await token({ ...credentials(config), grant_type: 'refresh_token' })).access_token;
}

async function account(access) {
  const result = await request('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${access}` } });
  if (!result.email || !result.email_verified) throw Object.assign(new Error('No se pudo verificar la cuenta de Google.'), { code: 'GMAIL_AUTH' });
  return result.email.toLowerCase();
}

async function verify(config) {
  if (!config?.smtpEnabled) throw Object.assign(new Error('El envío está desactivado.'), { code: 'GMAIL_CONFIG' });
  const email = await account(await accessToken(config));
  if (email !== config.gmailAccount.toLowerCase()) throw Object.assign(new Error('La cuenta autorizada no coincide.'), { code: 'GMAIL_AUTH' });
}

async function send(config, message) {
  const access = await accessToken(config);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const mime = await transport.sendMail(message);
  await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: mime.message.toString('base64url') }),
  });
}

module.exports = { SCOPES, token, account, verify, send };
