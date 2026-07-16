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
 * Resuelve variables "conocidas" por su nombre: datos del paciente y, si el
 * envío trae una cita (`appointmentId`, típico de workflows de recordatorio),
 * datos REALES de la cita (servicio, fecha, hora, doctor, sede). Devuelve una
 * función key → valor ('' si no la reconoce).
 */
async function buildKnownVariableResolver(patient, appointmentId) {
  const firstName = String(patient?.firstName || '').trim();
  const lastName = String(patient?.lastName || '').trim();
  let apt = null;
  if (appointmentId) {
    try {
      const Appointment = require('../models/Appointment');
      apt = await Appointment.findById(appointmentId)
        .populate('doctor', 'name')
        .populate('clinic', 'name')
        .lean();
    } catch {
      apt = null;
    }
  }
  const fecha = apt?.date
    ? new Date(apt.date).toLocaleDateString('es-EC', {
        timeZone: 'America/Guayaquil',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : '';
  const hora = apt?.startTime || '';
  const servicio = (apt?.services || []).map((s) => s.name).filter(Boolean).join(', ');
  const doctor = apt?.doctor?.name || '';
  const sede = apt?.clinic?.name || '';
  return (key) => {
    if (/^(nombre|nombres|firstname|name)$/i.test(key)) return firstName;
    if (/^(apellido|apellidos|lastname)$/i.test(key)) return lastName;
    if (/^(nombre_?completo|fullname)$/i.test(key)) return `${firstName} ${lastName}`.trim();
    if (/^(fecha(_?cita)?|date|appointmentdate)$/i.test(key)) return fecha;
    if (/^(hora(_?cita)?|time|appointmenttime)$/i.test(key)) return hora;
    if (/^(servicios?|service|tratamiento)$/i.test(key)) return servicio;
    if (/^(doctora?|medico|profesional)$/i.test(key)) return doctor;
    if (/^(sede|sucursal|clinica|clinic)$/i.test(key)) return sede;
    return '';
  };
}

/**
 * Prepara la plantilla para el envío por Cloud API contra su definición local:
 *  1) Reconcilia los parámetros del CUERPO con las variables que la plantilla
 *     declara de verdad: recorta los que sobran (p.ej. los workflows mandaban
 *     siempre el nombre aunque la plantilla no tuviera variables → #132000
 *     "number of parameters does not match") y completa los que faltan por el
 *     NOMBRE de la variable (paciente y datos reales de la cita si hay
 *     `appointmentId`), o con el ejemplo documentado como último recurso.
 *  2) Si tiene cabecera multimedia (imagen/documento/video) con URL pública,
 *     antepone el componente `header` que exige la Cloud API; si la exige y no
 *     hay archivo guardado, marca `missingHeaderMedia` para fallar con un
 *     mensaje claro (Meta devolvería #131008).
 */
async function enrichTemplateHeader(clinicId, templateInfo, patient, appointmentId) {
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
    const known = await buildKnownVariableResolver(patient, appointmentId);
    for (let i = params.length; i < expected; i++) {
      const key = keys[i];
      let val = known(key);
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
  // Se expone la cabecera para: (a) enviarla como imagen real por números QR
  // (que no admiten plantillas) y (b) mostrarla en la burbuja del chat.
  if (kind && tpl.headerMediaUrl) info.headerMedia = { type: kind, url: tpl.headerMediaUrl };
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
  const text = tpl?.body || `[${templateInfo.name}]`;
  const bodyComp = (templateInfo.components || []).find((c) => c.type === 'body');
  const params = (bodyComp?.parameters || []).map((p) => p.text);
  // Claves distintas en orden de aparición: el MISMO criterio con el que se
  // construyeron los parámetros (soporta variables nombradas, no solo {{1}}).
  const order = [];
  for (const m of text.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
    if (!order.includes(m[1])) order.push(m[1]);
  }
  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, k) => {
    const idx = /^\d+$/.test(k) ? Number(k) - 1 : order.indexOf(k);
    return params[idx] ?? m;
  });
}

async function sendToProvider({ clinicId, channel, conv, body, templateInfo, account, mediaUrl, mediaType, contextMessageId, quoteBody }) {
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
      // Plantilla con cabecera de IMAGEN: por QR se envía la imagen real con el
      // texto como pie (antes la cabecera se ignoraba en silencio y el paciente
      // recibía solo texto).
      const hm = templateInfo?.headerMedia;
      if (hm?.type === 'image' && hm.url) {
        return gateway.sendMedia(account, dest, hm.url, text, contextMessageId, quoteBody);
      }
      // Mensaje suelto con adjunto (mensajes guardados con imagen/video).
      if (mediaUrl) {
        return gateway.sendMedia(account, dest, mediaUrl, text, mediaType || 'image', contextMessageId, quoteBody);
      }
      return gateway.sendText(account, dest, text, contextMessageId, quoteBody);
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
    if (templateInfo) {
      return gateway.sendTemplate(
        account,
        conv.phone,
        templateInfo.name,
        templateInfo.language,
        templateInfo.components
      );
    }
    // Adjunto suelto por Cloud API: se envía el link público con el texto como
    // caption. Un data URL no es enviable por link → cae a texto solo (el
    // adjunto queda igualmente visible en la burbuja del chat interno).
    if (mediaUrl && !/^data:/i.test(String(mediaUrl))) {
      return gateway.sendMedia(account, conv.phone, mediaUrl, body || '', mediaType || 'image', contextMessageId);
    }
    return gateway.sendText(account, conv.phone, body || '', contextMessageId);
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
    const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v23.0'}/me/messages?access_token=${pageAccessToken}`;
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
  // Cita de contexto (workflows de recordatorio/confirmación): permite rellenar
  // las variables {{servicio}}/{{fecha}}/{{hora}}/{{doctor}}/{{sede}} con datos reales.
  appointmentId,
  // Respuesta a un mensaje específico (cita estilo WhatsApp). Snapshot listo
  // para persistir; su `externalId` se manda a WhatsApp como `context` para que
  // el contacto también vea la cita.
  replyTo,
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
    // Plantilla enviada SIN cita explícita (a mano desde el chat, campañas):
    // usar la PRÓXIMA cita del paciente para que {{servicio}}/{{fecha}}/{{hora}}
    // lleven datos reales y no el ejemplo documentado.
    let aptId = appointmentId;
    const patientRef = patientDoc || patient;
    if (!aptId && patientRef?._id) {
      try {
        const Appointment = require('../models/Appointment');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const next = await Appointment.findOne({
          patient: patientRef._id,
          date: { $gte: today },
          status: { $ne: 'cancelada' },
        })
          .sort({ date: 1, startTime: 1 })
          .select('_id')
          .lean();
        if (next) aptId = next._id;
      } catch {
        /* sin cita próxima: se usan los ejemplos */
      }
    }
    templateInfo = await enrichTemplateHeader(clinicId, templateInfo, patientRef, aptId);
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
  // La cabecera multimedia de la plantilla se guarda en el mensaje para que la
  // burbuja del chat muestre la plantilla TAL CUAL la recibe el paciente.
  const tplMedia = templateInfo?.headerMedia || null;
  const msg = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body: preview,
    mediaUrl: mediaUrl || tplMedia?.url || null,
    mediaType: mediaType || tplMedia?.type || null,
    templateName: templateInfo?.name || '',
    ...(replyTo ? { replyTo } : {}),
    deliveryStatus: 'queued',
    sentBy: sentBy || null,
    sentByName: sentByName || '',
    isAutoReply,
  });

  // Diagnóstico de citas: un mensaje sin wamid (p.ej. creado por "Simular
  // entrante") NO se puede citar en WhatsApp, aunque el CRM muestre el bloque.
  if (replyTo) {
    console.log(
      '[reply]',
      replyTo.externalId
        ? `citando wamid ${replyTo.externalId} (canal ${normalizedChannel}, cuenta ${account?.connectionType || 'n/a'})`
        : 'el mensaje citado NO tiene wamid: se enviará sin cita en WhatsApp (¿mensaje simulado?)'
    );
  }

  const providerResult = await sendToProvider({
    clinicId,
    channel: normalizedChannel,
    conv,
    // Sin plantilla y sin texto el body va vacío: el placeholder '[media]' es
    // solo para la vista interna, no debe llegar como caption al paciente.
    body: textBody || (templateInfo ? preview : ''),
    templateInfo,
    account,
    mediaUrl,
    mediaType,
    // Cita en WhatsApp: por Cloud API se usa el wamid; por QR, si no tenemos el
    // wamid guardado, se pasa el TEXTO del mensaje citado para localizarlo en
    // vivo dentro del chat y citarlo igual.
    contextMessageId: replyTo?.externalId || null,
    quoteBody: replyTo ? (replyTo.body || '') : null,
  });

  if (providerResult.ok) {
    msg.deliveryStatus = 'sent';
    msg.externalId = extractProviderMessageId(providerResult);
    // Contador de uso de la plantilla (ordena el menú del chat por "más usadas").
    if (templateInfo?.name) {
      require('../models/MessageTemplate')
        .updateOne(
          { clinic: clinicId, channel: 'whatsapp', name: templateInfo.name },
          { $inc: { usageCount: 1 } }
        )
        .catch(() => {});
    }
    msg.statusTimestamps = {
      ...(msg.statusTimestamps?.toObject ? msg.statusTimestamps.toObject() : msg.statusTimestamps || {}),
      sentAt: new Date(),
    };
    // Auditoría de la cita: registra si la respuesta llegó CITADA de verdad.
    if (replyTo && normalizedChannel === 'whatsapp') {
      const q = providerResult.quote;
      if (q) {
        // QR: el gateway verificó tras enviar si el mensaje lleva la cita.
        msg.quoteResult = q.applied ? `quoted_by_${q.how}` : `failed:${q.reason || 'not_found'}`;
        // Si el mensaje citado se localizó EN VIVO (p.ej. por texto), ya
        // conocemos su wamid: se respalda en el mensaje original para que las
        // próximas citas vayan directo por id.
        if (q.wamid && replyTo.message) {
          await Message.updateOne(
            { _id: replyTo.message, externalId: { $in: [null, ''] } },
            { externalId: q.wamid }
          ).catch(() => {});
        }
      } else {
        // Cloud API: la cita viaja como `context.message_id`; sin wamid no hay
        // forma de citar (Meta no admite búsqueda por texto).
        msg.quoteResult = replyTo.externalId ? 'quoted_by_id' : 'failed:no_wamid';
      }
      if (msg.quoteResult.startsWith('failed')) {
        console.warn('[reply] la cita NO se aplicó en WhatsApp:', msg.quoteResult);
      }
    }
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
  let msg = await Message.findOne({ clinic: clinicId, externalId });
  if (!msg) {
    // Chats LID (número oculto): el ack puede llegar con el wamid bajo la OTRA
    // forma del JID (@c.us vs @lid) y no coincidir con el guardado — por eso
    // los salientes se quedaban en "enviado" aunque el contacto ya los leyó.
    // La parte única del wamid (hash) identifica el mensaje igual.
    const parts = String(externalId).split('_');
    const hash = parts.length >= 3 ? parts[2] : '';
    if (hash && hash.length >= 8) {
      const esc = hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      msg = await Message.findOne({ clinic: clinicId, externalId: new RegExp(`_${esc}$`) });
    }
  }
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
  buildKnownVariableResolver,
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
