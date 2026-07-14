const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');
const CallCenterConfig = require('../models/CallCenterConfig');
const gateway = require('./whatsappGateway');
const email = require('./emailProvider');
const { emitToCallCenter } = require('../realtime');

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_STATUSES = new Set(['queued', 'sent', 'delivered', 'read', 'failed']);

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits || null;
}

function computeWhatsappWindowExpiresAt(lastIncomingAt = new Date()) {
  const base = lastIncomingAt instanceof Date ? lastIncomingAt : new Date(lastIncomingAt);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + WHATSAPP_WINDOW_MS);
}

function getWhatsappWindowExpiresAt(conv) {
  if (!conv) return null;
  if (conv.window24hExpiresAt) return new Date(conv.window24hExpiresAt);
  if (conv.lastMessageDirection === 'in' && conv.lastMessageAt) {
    return computeWhatsappWindowExpiresAt(conv.lastMessageAt);
  }
  return null;
}

function isWhatsappWindowOpen(conv, now = new Date()) {
  const expiresAt = getWhatsappWindowExpiresAt(conv);
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
}

function normalizeTextForKeyword(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isOptOutText(text) {
  const normalized = normalizeTextForKeyword(text);
  if (!normalized) return false;
  const exact = new Set([
    'BAJA',
    'STOP',
    'CANCELAR',
    'SALIR',
    'UNSUBSCRIBE',
    'NO MAS MENSAJES',
    'NO QUIERO MENSAJES',
  ]);
  return exact.has(normalized);
}

function optOutReasonFor(patient, channel) {
  if (!patient) return null;
  const marketing = patient.marketing || {};
  if (marketing.optOutAt) return 'opt_out';
  if (channel === 'whatsapp' && marketing.whatsappOptIn === false) return 'no_whatsapp_consent';
  if (channel === 'email' && marketing.emailOptIn === false) return 'no_email_consent';
  return null;
}

function buildTemplateComponents(vars) {
  if (!vars) return [];
  const values = Array.isArray(vars)
    ? vars
    : Object.keys(vars)
        .sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return a.localeCompare(b);
        })
        .map((key) => vars[key]);
  if (!values.length) return [];
  return [
    {
      type: 'body',
      parameters: values.map((value) => ({ type: 'text', text: String(value ?? '') })),
    },
  ];
}

function normalizeTemplate(template, vars) {
  if (!template) return null;
  if (typeof template === 'string') {
    const name = template.trim();
    return name ? { name, language: 'es', components: buildTemplateComponents(vars) } : null;
  }
  const name = String(template.name || template.templateName || '').trim();
  if (!name) return null;
  return {
    name,
    language: template.language || template.lang || 'es',
    components: Array.isArray(template.components)
      ? template.components
      : buildTemplateComponents(template.vars || vars),
  };
}

/**
 * Prepara la plantilla para el envío por Cloud API contra su definición local:
 *  1) Reconcilia los parámetros del CUERPO con las variables que la plantilla
 *     declara de verdad: recorta los que sobran (p.ej. los workflows mandaban
 *     siempre el nombre aunque la plantilla no tuviera variables → #132000
 *     "number of parameters does not match") y completa los que faltan usando
 *     el nombre del paciente o el ejemplo documentado de cada variable.
 *  2) Si tiene cabecera multimedia (imagen/documento/video) con URL pública,
 *     antepone el componente `header` que exige la Cloud API; si la exige y no
 *     hay archivo guardado, marca `missingHeaderMedia` para fallar con un
 *     mensaje claro (Meta devolvería #131008).
 */
async function enrichTemplateHeader(clinicId, templateInfo, patient) {
  if (!templateInfo?.name) return templateInfo;
  const MessageTemplate = require('../models/MessageTemplate');
  const tpl = await MessageTemplate.findOne({
    clinic: clinicId,
    channel: 'whatsapp',
    name: templateInfo.name,
  }).select('headerType headerMediaUrl body variables').lean();
  if (!tpl) return templateInfo;

  const info = { ...templateInfo, components: [...(templateInfo.components || [])] };

  // ── 1) Parámetros del cuerpo ──
  // Variables distintas en orden de aparición (mismo criterio que el registro).
  const keys = [];
  for (const m of String(tpl.body || '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  const expected = keys.length;
  const bodyIdx = info.components.findIndex((c) => c.type === 'body');
  let params = bodyIdx >= 0 ? [...(info.components[bodyIdx].parameters || [])] : [];
  if (params.length > expected) params = params.slice(0, expected);
  if (params.length < expected) {
    const exampleOf = new Map((tpl.variables || []).map((v) => [v.key, v.example]));
    const firstName = String(patient?.firstName || '').trim();
    for (let i = params.length; i < expected; i++) {
      const key = keys[i];
      let val = '';
      if (/^(nombre|nombres|firstname|name)$/i.test(key)) val = firstName;
      if (!val) val = exampleOf.get(key) || '';
      if (!val) val = firstName || '-'; // Meta rechaza parámetros vacíos
      params.push({ type: 'text', text: String(val) });
    }
  }
  if (expected === 0) {
    if (bodyIdx >= 0) info.components.splice(bodyIdx, 1);
  } else if (bodyIdx >= 0) {
    info.components[bodyIdx] = { ...info.components[bodyIdx], parameters: params };
  } else {
    info.components.push({ type: 'body', parameters: params });
  }

  // ── 2) Cabecera multimedia ──
  const hasHeader = info.components.some((c) => c.type === 'header');
  const kind = ['image', 'document', 'video'].includes(tpl.headerType) ? tpl.headerType : null;
  if (!hasHeader && kind) {
    if (!tpl.headerMediaUrl) return { ...info, missingHeaderMedia: kind };
    info.components.unshift({
      type: 'header',
      parameters: [{ type: kind, [kind]: { link: tpl.headerMediaUrl } }],
    });
  }
  return info;
}

function extractProviderMessageId(result) {
  const data = result?.data || result;
  return (
    data?.messages?.[0]?.id ||
    data?.message_id ||
    data?.messageId ||
    data?.id ||
    ''
  );
}

// CRM global: el paciente se busca en TODA la organización (no por sucursal), para
// que las campañas/respuestas alcancen a pacientes de cualquier sede.
async function findPatientByPhone(clinicId, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const tail = normalized.slice(-9);
  return Patient.findOne({
    $or: [
      { phone: { $regex: `${tail}$` } },
      { whatsapp: { $regex: `${tail}$` } },
    ],
  });
}

async function resolvePatient({ clinicId, patient, conv, to }) {
  if (patient && patient._id && patient.marketing !== undefined) return patient;
  const patientId = patient?._id || patient || conv?.patient?._id || conv?.patient;
  if (patientId) {
    const found = await Patient.findById(patientId);
    if (found) return found;
  }
  return findPatientByPhone(clinicId, to || conv?.phone);
}

async function createConversationSafe(payload) {
  try {
    return await Conversation.create(payload);
  } catch (err) {
    if (err && err.code === 11000) {
      return Conversation.findOne({ clinic: payload.clinic, phone: payload.phone });
    }
    throw err;
  }
}

async function resolveConversation({ clinicId, conversation, channel, to, contactName, patient }) {
  if (conversation?._id && typeof conversation.save === 'function') return conversation;
  const conversationId = conversation?._id || conversation;
  if (conversationId) {
    const found = await Conversation.findOne({ _id: conversationId, clinic: clinicId });
    if (found) return found;
  }

  const phone = normalizePhone(to);
  if (!phone) return null;
  let conv = await Conversation.findOne({ clinic: clinicId, phone });
  if (conv) {
    const patientId = patient?._id || patient;
    if (patientId && !conv.patient) {
      conv.patient = patientId;
      await conv.save();
    }
    return conv;
  }

  const patientDoc = await resolvePatient({ clinicId, patient, to: phone });
  conv = await createConversationSafe({
    clinic: clinicId,
    phone,
    contactName:
      contactName ||
      (patientDoc ? `${patientDoc.firstName || ''} ${patientDoc.lastName || ''}`.trim() : ''),
    patient: patientDoc?._id || patient?._id || patient || null,
    channel: channel || 'whatsapp',
    lastMessagePreview: '',
    lastMessageAt: new Date(),
  });
  return conv;
}

async function postMetaMessage({ accessToken, url, payload }) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error?.message || `Meta API ${res.status}`,
        data,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Renderiza una plantilla a texto plano para números QR (que no admiten plantillas
// de Meta): sustituye {{1}},{{2}}… con los parámetros del componente body.
async function renderTemplateText(templateInfo) {
  const MessageTemplate = require('../models/MessageTemplate');
  const tpl = await MessageTemplate.findOne({ channel: 'whatsapp', name: templateInfo.name })
    .select('body')
    .lean();
  let text = tpl?.body || `[${templateInfo.name}]`;
  const bodyComp = (templateInfo.components || []).find((c) => c.type === 'body');
  const params = (bodyComp?.parameters || []).map((p) => p.text);
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => params[Number(n) - 1] ?? m);
}

async function sendToProvider({ clinicId, channel, conv, body, templateInfo, account }) {
  if (channel === 'whatsapp') {
    if (!account) {
      return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
    }
    // Un número QR (sesión WhatsApp Web) no admite plantillas: se envía texto libre
    // (renderizando la plantilla a texto si fuera necesario).
    if (account.connectionType === 'qr') {
      const text = body || (templateInfo ? await renderTemplateText(templateInfo) : '');
      // Contactos con "número oculto" (LID de WhatsApp): conv.phone son los dígitos
      // del LID, NO un teléfono; responder a <lid>@c.us cuelga para siempre. Se
      // responde al JID completo (…@lid / …@c.us) guardado en externalUserId.
      const dest = String(conv.externalUserId || '').includes('@') ? conv.externalUserId : conv.phone;
      return gateway.sendText(account, dest, text);
    }
    if (templateInfo?.missingHeaderMedia) {
      return {
        ok: false,
        errorCode: 'template_header_missing',
        error:
          `La plantilla "${templateInfo.name}" requiere ${templateInfo.missingHeaderMedia === 'image' ? 'una imagen' : 'un archivo'} ` +
          'de cabecera y no hay ninguno guardado. Edita la plantilla y vuelve a subir la imagen.',
      };
    }
    return templateInfo
      ? gateway.sendTemplate(
          account,
          conv.phone,
          templateInfo.name,
          templateInfo.language,
          templateInfo.components
        )
      : gateway.sendText(account, conv.phone, body || '');
  }

  if (channel === 'messenger' || channel === 'instagram') {
    const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).lean();
    const channelConfig = cfg?.[channel];
    const pageAccessToken = channelConfig?.pageAccessToken
      ? require('./secretCrypto').decryptSecret(channelConfig.pageAccessToken)
      : '';
    if (!channelConfig?.enabled || !pageAccessToken) {
      return { ok: false, errorCode: 'provider_unavailable', error: `${channel} no configurado` };
    }
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${pageAccessToken}`;
    return postMetaMessage({
      accessToken: pageAccessToken,
      url,
      payload: {
        recipient: { id: conv.externalUserId || conv.phone },
        message: { text: body || '' },
        ...(channel === 'messenger' ? { messaging_type: 'RESPONSE' } : {}),
      },
    });
  }

  if (channel === 'web') return { ok: true, data: {} };
  if (channel === 'sms') {
    return { ok: false, errorCode: 'provider_unavailable', error: 'Canal SMS no configurado' };
  }
  return { ok: false, errorCode: 'provider_unavailable', error: `Canal ${channel} no soportado` };
}

function providerErrorCode(result) {
  return String(
    result?.errorCode ||
      result?.data?.error?.code ||
      result?.data?.error?.error_subcode ||
      'provider_error'
  );
}

function providerErrorMessage(result) {
  return String(result?.error || result?.data?.error?.message || 'No se pudo enviar el mensaje');
}

async function findPatientByEmail(clinicId, email) {
  if (!email) return null;
  // CRM global: busca por email en toda la organización.
  return Patient.findOne({ email: String(email).toLowerCase().trim() });
}

/**
 * Envío por email (sin conversación). Respeta opt-out de email y añade enlace de
 * baja. Devuelve el mismo shape que send() para uniformidad en campañas/jobs.
 */
async function sendEmailChannel({ clinicId, to, patient, subject, body, ignoreOptOut, source }) {
  if (!to || !/.+@.+\..+/.test(String(to))) {
    return { ok: false, skipped: true, reason: 'invalid_recipient' };
  }
  let patientDoc = null;
  if (patient && patient.marketing !== undefined && patient._id) patientDoc = patient;
  else {
    const pid = patient?._id || patient;
    patientDoc = pid
      ? await Patient.findById(pid)
      : await findPatientByEmail(clinicId, to);
  }
  if (!ignoreOptOut && patientDoc) {
    const m = patientDoc.marketing || {};
    if (m.optOutAt) return { ok: false, skipped: true, reason: 'opt_out' };
    if (m.emailOptIn === false) return { ok: false, skipped: true, reason: 'no_email_consent' };
  }

  const { ok, creds } = await email.loadCreds(clinicId);
  const base = process.env.PUBLIC_API_URL || '';
  const unsubscribeUrl = patientDoc && base ? `${base}/api/public/unsubscribe/${patientDoc._id}` : '';
  // Tracking de apertura/clic: solo si conocemos la URL pública base.
  const EmailSend = require('../models/EmailSend');
  const trackingId = base ? EmailSend.newTrackingId() : '';
  const result = await email.sendEmail(ok ? creds : null, {
    to,
    subject,
    body,
    unsubscribeUrl,
    trackingId,
    trackingBase: base,
  });

  if (result.skipped || result.simulated) {
    return { ok: false, skipped: true, reason: 'provider_unavailable', deliveryStatus: 'skipped' };
  }
  if (!result.ok) {
    return { ok: false, deliveryStatus: 'failed', errorCode: String(result.status || 'email_error'), errorMessage: result.error || 'Error de email' };
  }
  if (trackingId) {
    await EmailSend.create({
      clinic: clinicId,
      campaign: source && source.model === 'Campaign' ? source.ref : null,
      patient: patientDoc?._id || null,
      to,
      subject: subject || '',
      trackingId,
    }).catch(() => {});
  }
  return { ok: true, deliveryStatus: 'sent', externalId: result.data?.id || '' };
}

async function send({
  clinicId,
  channel = 'whatsapp',
  to,
  patient,
  conversation,
  contactName,
  template,
  vars,
  body,
  subject,
  mediaUrl,
  mediaType,
  sentBy,
  sentByName,
  isAutoReply = false,
  ignoreOptOut = false,
  source,
}) {
  const normalizedChannel = channel || 'whatsapp';

  // El email no usa el modelo de conversación (telefónico): rama propia.
  if (normalizedChannel === 'email') {
    return sendEmailChannel({ clinicId, to, patient, subject, body, ignoreOptOut, source });
  }

  const conv = await resolveConversation({
    clinicId,
    conversation,
    channel: normalizedChannel,
    to,
    contactName,
    patient,
  });
  if (!conv) {
    return { ok: false, skipped: true, reason: 'invalid_recipient' };
  }

  const patientDoc = await resolvePatient({ clinicId, patient, conv, to: conv.phone || to });
  if (conv.blocked) return { ok: false, skipped: true, reason: 'blocked' };
  if (!ignoreOptOut) {
    const consentReason = optOutReasonFor(patientDoc, normalizedChannel);
    if (consentReason) return { ok: false, skipped: true, reason: consentReason };
  }

  // Resuelve el número (global) por el que se enviará: el de la conversación o el
  // marcado por defecto. Determina además si aplica la ventana de 24h (solo Cloud API).
  let account = null;
  if (normalizedChannel === 'whatsapp') {
    account = await gateway.resolveAccountForConversation(conv);
    if (!account) return { ok: false, skipped: true, reason: 'provider_unavailable' };
  }

  let templateInfo = normalizeTemplate(template, vars);
  if (templateInfo && normalizedChannel === 'whatsapp') {
    templateInfo = await enrichTemplateHeader(clinicId, templateInfo, patientDoc || patient);
  }
  if (normalizedChannel === 'whatsapp' && gateway.isCloud(account)) {
    const computedWindow = getWhatsappWindowExpiresAt(conv);
    if (!conv.window24hExpiresAt && computedWindow) {
      conv.window24hExpiresAt = computedWindow;
      await conv.save();
    }
    if (!isWhatsappWindowOpen(conv) && !templateInfo) {
      return { ok: false, skipped: true, reason: 'out_of_window' };
    }
  }

  const textBody = String(body || '').trim();
  // Para plantillas guardamos el TEXTO renderizado (cuerpo con las variables ya
  // sustituidas) para que en el chat se vea el contenido real que recibe el paciente
  // y no un `[Plantilla: nombre]`. El envío a Meta sigue usando templateInfo (nombre
  // + componentes); esto es solo el body que se persiste y se muestra en la bandeja.
  let preview = textBody;
  if (!preview) {
    if (templateInfo) preview = await renderTemplateText(templateInfo);
    else if (mediaUrl) preview = '[media]';
    else preview = '';
  }
  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body: preview,
    mediaUrl: mediaUrl || null,
    mediaType: mediaType || null,
    templateName: templateInfo?.name || '',
    deliveryStatus: 'queued',
    sentBy: sentBy || null,
    sentByName: sentByName || '',
    isAutoReply,
  });

  const providerResult = await sendToProvider({
    clinicId,
    channel: normalizedChannel,
    conv,
    body: textBody || preview,
    templateInfo,
    account,
  });

  if (providerResult.ok) {
    msg.deliveryStatus = 'sent';
    msg.externalId = extractProviderMessageId(providerResult);
    msg.statusTimestamps = {
      ...(msg.statusTimestamps?.toObject ? msg.statusTimestamps.toObject() : msg.statusTimestamps || {}),
      sentAt: new Date(),
    };
  } else {
    msg.deliveryStatus = 'failed';
    msg.errorCode = providerErrorCode(providerResult);
    // Incluye POR QUÉ NÚMERO salió el intento: con varios números conectados, un
    // error de permisos (#200) suele ser del número anclado a la conversación,
    // no del que el usuario cree estar usando.
    msg.errorMessage =
      providerErrorMessage(providerResult) +
      (account?.label ? ` — enviado vía «${account.label}»` : '');
    msg.statusTimestamps = {
      ...(msg.statusTimestamps?.toObject ? msg.statusTimestamps.toObject() : msg.statusTimestamps || {}),
      failedAt: new Date(),
    };
  }
  await msg.save();

  conv.lastMessageAt = msg.createdAt;
  conv.lastMessagePreview = preview.slice(0, 140);
  conv.lastMessageDirection = 'out';
  // Recuerda por qué número salió, para que las próximas respuestas usen el mismo.
  if (account && !conv.whatsappAccount) conv.whatsappAccount = account._id;
  if (sentBy) {
    conv.lastAgentReplyAt = new Date();
    if (!conv.firstResponseAt) conv.firstResponseAt = conv.lastAgentReplyAt;
  }
  await conv.save();

  emitToCallCenter('chat:message', { conversationId: conv._id, message: msg });

  return {
    ok: providerResult.ok,
    messageId: msg._id,
    externalId: msg.externalId,
    deliveryStatus: msg.deliveryStatus,
    errorCode: msg.errorCode,
    errorMessage: msg.errorMessage,
    message: msg,
    conversation: conv,
  };
}

function mapProviderStatus(status) {
  const value = String(status || '').toLowerCase();
  if (DELIVERY_STATUSES.has(value)) return value;
  if (value === 'received') return 'delivered';
  return null;
}

function timestampFieldForStatus(status) {
  if (status === 'sent') return 'sentAt';
  if (status === 'delivered') return 'deliveredAt';
  if (status === 'read') return 'readAt';
  if (status === 'failed') return 'failedAt';
  return null;
}

async function updateMessageStatus({
  clinicId,
  externalId,
  status,
  timestamp,
  errorCode,
  errorMessage,
}) {
  const deliveryStatus = mapProviderStatus(status);
  if (!externalId || !deliveryStatus) {
    return { ok: false, reason: 'invalid_status' };
  }
  const msg = await Message.findOne({ clinic: clinicId, externalId });
  if (!msg) return { ok: false, reason: 'message_not_found' };

  msg.deliveryStatus = deliveryStatus;
  const at = timestamp ? new Date(Number(timestamp) * 1000) : new Date();
  const currentTimestamps = msg.statusTimestamps?.toObject
    ? msg.statusTimestamps.toObject()
    : msg.statusTimestamps || {};
  const field = timestampFieldForStatus(deliveryStatus);
  if (field) currentTimestamps[field] = at;
  if (deliveryStatus === 'read' && !currentTimestamps.deliveredAt) {
    currentTimestamps.deliveredAt = at;
  }
  msg.statusTimestamps = currentTimestamps;
  if (errorCode) msg.errorCode = String(errorCode);
  if (errorMessage) msg.errorMessage = String(errorMessage);
  await msg.save();

  emitToCallCenter('chat:message:status', {
    conversationId: msg.conversation,
    messageId: msg._id,
    externalId: msg.externalId,
    deliveryStatus: msg.deliveryStatus,
    statusTimestamps: msg.statusTimestamps,
    errorCode: msg.errorCode,
    errorMessage: msg.errorMessage,
  });

  return { ok: true, message: msg };
}

module.exports = {
  WHATSAPP_WINDOW_MS,
  buildTemplateComponents,
  computeWhatsappWindowExpiresAt,
  getWhatsappWindowExpiresAt,
  isOptOutText,
  isWhatsappWindowOpen,
  mapProviderStatus,
  normalizePhone,
  send,
  timestampFieldForStatus,
  updateMessageStatus,
};
