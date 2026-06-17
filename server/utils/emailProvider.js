/**
 * Cliente de email liviano y sin dependencias. Usa la API HTTP de Resend
 * (https://resend.com) si la clínica configuró una apiKey en CallCenterConfig.email.
 * Si no hay credenciales, NO lanza: devuelve { ok:false, simulated:true } para no
 * romper la UX (mismo patrón que utils/whatsappCloud.js).
 *
 * El proveedor es intercambiable: basta reemplazar postToProvider por otro
 * (SendGrid/SES) manteniendo la firma de sendEmail.
 */
const CallCenterConfig = require('../models/CallCenterConfig');

async function loadCreds(clinicId) {
  if (!clinicId) return { ok: false, reason: 'clinicId requerido' };
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).lean();
  const email = cfg && cfg.email;
  if (!email) return { ok: false, reason: 'Email no configurado para la clínica' };
  if (!email.enabled) return { ok: false, reason: 'El canal Email está inactivo' };
  if (!email.apiKey || !email.fromEmail) {
    return { ok: false, reason: 'Faltan credenciales de email (apiKey / fromEmail)' };
  }
  return { ok: true, creds: email };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Convierte texto plano con saltos de línea en HTML simple + pie de baja.
function buildHtml(body, { unsubscribeUrl } = {}) {
  const paragraphs = escapeHtml(body).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
  const footer = unsubscribeUrl
    ? `<hr/><p style="font-size:12px;color:#888">Si no deseas recibir más correos, <a href="${unsubscribeUrl}">date de baja aquí</a>.</p>`
    : '';
  return `<div style="font-family:sans-serif;font-size:15px;color:#222">${paragraphs}${footer}</div>`;
}

async function postToProvider(creds, payload) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.message || `Email API ${res.status}`, data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Envía un email. `creds` viene de loadCreds. Si no está configurado, simula.
 */
async function sendEmail(creds, { to, subject, body, html, unsubscribeUrl }) {
  if (!creds || !creds.apiKey || !creds.fromEmail) {
    return { ok: false, simulated: true, reason: 'Email no configurado' };
  }
  if (!to || !/.+@.+\..+/.test(to)) return { ok: false, error: 'Email destino inválido' };
  const from = creds.fromName ? `${creds.fromName} <${creds.fromEmail}>` : creds.fromEmail;
  const result = await postToProvider(creds, {
    from,
    to: [to],
    subject: subject || '(sin asunto)',
    html: html || buildHtml(body, { unsubscribeUrl }),
    ...(creds.replyTo ? { reply_to: creds.replyTo } : {}),
  });
  return result;
}

module.exports = { loadCreds, sendEmail, buildHtml };
