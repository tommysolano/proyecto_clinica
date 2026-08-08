const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Patient = require('../models/Patient');
const CallCenterConfig = require('../models/CallCenterConfig');
const gateway = require('./whatsappGateway');
const email = require('./emailProvider');
const { emitToCallCenter } = require('../realtime');
const { sanitizeMessageForSocket } = require('./chatMedia');

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

function sameId(a, b) {
  if (!a || !b) return false;
  return String(a._id || a) === String(b._id || b);
}

/**
 * ¿El último entrante llegó por un número DISTINTO al que va a enviar?
 *
 * La ventana de 24h de Meta es de la pareja (NÚMERO DE LA CLÍNICA, contacto): que
 * el paciente le escriba al WhatsApp de recepción no abre ninguna ventana en el
 * número de la API. Mientras la ventana se calculó solo con `lastInboundAt` —sin
 * mirar POR DÓNDE entró— el CRM decía "abierta, te quedan 8 h" y Meta rechazaba
 * el texto con 131047. Pasó en 156 mensajes en un solo día (08-ago-2026), cuando
 * el número QR se borró y se volvió a crear: los 4.585 chats que colgaban de él
 * pasaron a responderse por el número por defecto (Cloud API), al que esos
 * pacientes no le habían escrito jamás.
 *
 * Solo se afirma la discrepancia cuando SE SABE por dónde entró (`lastInboundAccount`).
 * En los chats antiguos, sin ese dato, se mantiene el comportamiento de siempre:
 * "no lo sé" no puede convertirse en "cerrada" para media bandeja.
 */
function inboundCameFromAnotherNumber(conv, sendingAccountId) {
  if (!sendingAccountId || !conv?.lastInboundAccount) return false;
  return !sameId(conv.lastInboundAccount, sendingAccountId);
}

/**
 * Hasta cuándo está abierta la ventana de 24h PARA EL NÚMERO QUE VA A ENVIAR, o
 * null si nunca se abrió (o si la abrió otro número: ver arriba).
 *
 * La ventana solo la abre un mensaje ENTRANTE de verdad. Se toma el máximo entre
 * el campo cacheado y `lastInboundAt` por si uno quedó desfasado; así un mensaje
 * saliente (agente que responde / cotización) nunca "cierra" una ventana viva.
 *
 * NO SE ADIVINA por `lastMessageDirection`: aquí había un respaldo "si el último
 * mensaje fue entrante, la ventana sale de él" para conversaciones viejas sin
 * `lastInboundAt`, y resultó ser un generador de ventanas FANTASMA. Una
 * conversación recién creada por un envío NUESTRO (workflow a alguien que nunca
 * escribió) nace con los valores por defecto del modelo, y con el viejo default
 * `lastMessageDirection:'in'` + `lastMessageAt:ahora` parecía "el contacto acaba
 * de escribir" → ventana abierta 24h que Meta rechazaba con el error 131047
 * ("Re-engagement message"). En producción quedaron 76 chats así y los agentes
 * escribían texto libre que NUNCA llegaba al paciente. El respaldo tampoco servía
 * ya para nada: cero conversaciones reales dependían de él.
 */
function getWhatsappWindowExpiresAt(conv, sendingAccountId = null) {
  if (!conv) return null;
  if (inboundCameFromAnotherNumber(conv, sendingAccountId)) return null;
  const candidates = [];
  if (conv.window24hExpiresAt) candidates.push(new Date(conv.window24hExpiresAt).getTime());
  if (conv.lastInboundAt) candidates.push(computeWhatsappWindowExpiresAt(conv.lastInboundAt).getTime());
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates));
}

function isWhatsappWindowOpen(conv, now = new Date(), sendingAccountId = null) {
  const expiresAt = getWhatsappWindowExpiresAt(conv, sendingAccountId);
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
}

/**
 * Estado COMPLETO de la ventana de 24h de una conversación, calculado en el
 * servidor y enviado tal cual a la UI.
 *
 * POR QUÉ: la ventana se calculaba DOS veces (aquí para decidir si se envía, y
 * otra vez en el navegador para pintar el aviso "ventana cerrada"). Dos copias de
 * la misma regla = dos formas de equivocarse: bastaba que el front resolviera el
 * tipo de conexión distinto al que de verdad usa el envío para que el compositor
 * se bloqueara con la ventana abierta (o al revés). Ahora la regla vive SOLO aquí.
 *
 * `connectionType` y `sendingAccountId` son los del número por el que REALMENTE
 * saldría el mensaje (los resuelve quien llama, con la misma regla que el envío).
 * Los números QR (WhatsApp Web) no tienen ventana: `applies:false` → siempre abierta.
 *
 * Devuelve también `lastInboundAt` para que la UI pueda decir CUÁNDO escribió el
 * contacto por última vez, en vez de un "cerrada" sin contexto (el motivo #1 de
 * "la ventana no se está cumpliendo": el último entrante era de hace días, pero
 * en el hilo solo se veía la hora y parecía de anoche); y `otherNumber` cuando lo
 * que la cerró es que el contacto escribió a OTRO de nuestros números, que sin
 * explicación parece directamente un fallo del sistema.
 */
function describeWhatsappWindow(conv, connectionType, now = new Date(), sendingAccountId = null) {
  const isWhatsapp = (conv?.channel || 'whatsapp') === 'whatsapp';
  const applies = isWhatsapp && connectionType !== 'qr';
  const expiresAt = isWhatsapp ? getWhatsappWindowExpiresAt(conv, sendingAccountId) : null;
  // Solo un entrante REAL cuenta como "el contacto escribió" (ver
  // getWhatsappWindowExpiresAt): sin él, la UI dice "todavía no te ha escrito".
  const lastInboundAt = conv?.lastInboundAt ? new Date(conv.lastInboundAt) : null;
  const open = !applies || Boolean(expiresAt && expiresAt.getTime() > now.getTime());
  return {
    applies,
    open,
    expiresAt: expiresAt || null,
    lastInboundAt,
    // La ventana existe, pero en OTRO número: el contacto escribió a uno y el
    // envío sale por otro. Sirve para explicarlo en el chat.
    otherNumber: applies && isWhatsapp && inboundCameFromAnotherNumber(conv, sendingAccountId),
    // Milisegundos que quedan de ventana (0 si está cerrada o no aplica).
    msRemaining: applies && expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0,
  };
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
async function buildKnownVariableResolver(patient, appointmentId, contact = null) {
  // Sin paciente (contactos importados del CRM), el nombre sale del CONTACTO.
  // Sin este fallback, la variable caía al EJEMPLO documentado de la plantilla y
  // todos los contactos de un workflow recibían "Hola María".
  const contactFirst =
    String(contact?.firstName || '').trim() ||
    String(contact?.displayName || '').trim().split(' ')[0] ||
    '';
  const firstName = String(patient?.firstName || '').trim() || contactFirst;
  const lastName = String(patient?.lastName || '').trim() || String(contact?.lastName || '').trim();
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

  // Campos personalizados del CONTACTO (importación del CRM): mapa normalizado
  // clave→valor (sin tildes, minúsculas). Es la fuente de {{servicio}}/{{hora}} y
  // cualquier otra variable cuando NO hay cita — antes caían al ejemplo de la
  // plantilla y todos recibían "Limpieza facial / 14:30" en vez del dato del Excel.
  const norm = (k) => String(k || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const custom = new Map();
  const cf = contact?.customFields;
  if (cf) {
    const pairs = cf instanceof Map ? [...cf.entries()] : Object.entries(cf);
    for (const [k, v] of pairs) {
      if (v != null && String(v).trim() !== '') custom.set(norm(k), String(v).trim());
    }
  }

  return (key) => {
    const k = norm(key);
    if (/^(nombre|nombres|firstname|name)$/i.test(key)) return firstName;
    if (/^(apellido|apellidos|lastname)$/i.test(key)) return lastName;
    if (/^(nombre_?completo|fullname)$/i.test(key)) return `${firstName} ${lastName}`.trim();
    // La cita (si hay) MANDA; si no, el campo personalizado del contacto; luego vacío.
    if (/^(fecha(_?cita)?|date|appointmentdate)$/i.test(key)) return fecha || custom.get(k) || custom.get('fecha') || '';
    if (/^(hora(_?cita)?|time|appointmenttime)$/i.test(key)) return hora || custom.get(k) || custom.get('hora') || '';
    if (/^(servicios?|service|tratamiento)$/i.test(key)) return servicio || custom.get(k) || custom.get('servicio') || '';
    if (/^(doctora?|medico|profesional)$/i.test(key)) return doctor || custom.get(k) || custom.get('doctor') || '';
    if (/^(sede|sucursal|clinica|clinic)$/i.test(key)) return sede || custom.get(k) || '';
    // Cualquier otra variable: un campo personalizado del contacto con esa clave.
    return custom.get(k) || '';
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
async function enrichTemplateHeader(clinicId, templateInfo, patient, appointmentId, contact = null) {
  if (!templateInfo?.name) return templateInfo;
  const MessageTemplate = require('../models/MessageTemplate');
  const tpl = await MessageTemplate.findOne({
    clinic: clinicId,
    channel: 'whatsapp',
    name: templateInfo.name,
  }).select('headerType headerText headerMediaUrl body variables').lean();
  if (!tpl) return templateInfo;

  const info = { ...templateInfo, components: [...(templateInfo.components || [])] };

  // Resolutor de variables por NOMBRE (paciente + cita real + contacto), perezoso y
  // COMPARTIDO por el cuerpo y la cabecera de texto (no reconstruirlo dos veces).
  const exampleOf = new Map((tpl.variables || []).map((v) => [v.key, v.example]));
  const firstName =
    String(patient?.firstName || '').trim() ||
    String(contact?.firstName || '').trim() ||
    String(contact?.displayName || '').trim().split(' ')[0] ||
    '';
  let _known = null;
  const resolveVar = async (key) => {
    if (!_known) _known = await buildKnownVariableResolver(patient, appointmentId, contact);
    let val = _known(key);
    if (!val) val = exampleOf.get(key) || '';
    if (!val) val = firstName || '-'; // Meta rechaza parámetros vacíos
    return String(val);
  };
  const varKeysOf = (text) => {
    const out = [];
    for (const m of String(text || '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
  };

  // ── 1) Parámetros del cuerpo ──
  // Variables distintas en orden de aparición (mismo criterio que el registro).
  const keys = varKeysOf(tpl.body);
  const expected = keys.length;
  const bodyIdx = info.components.findIndex((c) => c.type === 'body');
  let params = bodyIdx >= 0 ? [...(info.components[bodyIdx].parameters || [])] : [];
  if (params.length > expected) params = params.slice(0, expected);
  if (params.length < expected) {
    for (let i = params.length; i < expected; i++) {
      params.push({ type: 'text', text: await resolveVar(keys[i]) });
    }
  }
  if (expected === 0) {
    if (bodyIdx >= 0) info.components.splice(bodyIdx, 1);
  } else if (bodyIdx >= 0) {
    info.components[bodyIdx] = { ...info.components[bodyIdx], parameters: params };
  } else {
    info.components.push({ type: 'body', parameters: params });
  }

  // ── 1b) Cabecera de TEXTO con variable ──
  // Si la cabecera es texto y trae {{var}}, Meta EXIGE su parámetro (si falta →
  // #132000 "number of parameters does not match"). Meta admite 1 variable en la
  // cabecera; se resuelve por nombre igual que el cuerpo.
  if (tpl.headerType === 'text' && /\{\{/.test(tpl.headerText || '')) {
    const alreadyHasHeader = info.components.some((c) => c.type === 'header');
    if (!alreadyHasHeader) {
      const hkeys = varKeysOf(tpl.headerText);
      if (hkeys.length) {
        const hparams = [];
        for (const key of hkeys) hparams.push({ type: 'text', text: await resolveVar(key) });
        info.components.unshift({ type: 'header', parameters: hparams });
      }
    }
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

/**
 * Conversación de una PERSONA a partir de su teléfono, contando también los chats
 * de "número oculto" (@lid) que quedaron enlazados a ese número (`linkedPhone`).
 *
 * POR QUÉ no basta con buscar por `phone`: quien escribe al número QR puede entrar
 * con un identificador oculto, y entonces su chat se guarda con el LID como
 * teléfono. Si esa persona YA tenía un chat por el número de Cloud API, el CRM
 * acaba con DOS conversaciones suyas. Buscar solo por `phone` encuentra siempre la
 * de Cloud, así que una campaña le escribía por ahí aunque su última conversación
 * real fuera la del QR — el "me llegó desde el número equivocado".
 *
 * Se devuelve la conversación con el ÚLTIMO MENSAJE ENTRANTE, que es la regla del
 * negocio: se le escribe por donde él escribió la última vez. A igualdad (o si
 * ninguna tiene entrantes), manda la del teléfono exacto.
 */
async function findConversationForPerson(clinicId, phone, channel) {
  if (!phone) return null;
  const q = { clinic: clinicId, $or: [{ phone }, { linkedPhone: phone }] };
  if (channel) q.channel = channel;
  const convs = await Conversation.find(q);
  if (convs.length <= 1) return convs[0] || null;
  const score = (c) => (c.lastInboundAt ? new Date(c.lastInboundAt).getTime() : 0);
  return convs.sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    return (b.phone === phone ? 1 : 0) - (a.phone === phone ? 1 : 0);
  })[0];
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
  // Sin filtrar por canal, igual que siempre: la identidad es el teléfono.
  let conv = await findConversationForPerson(clinicId, phone, null);
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
    // Este chat nace de un envío NUESTRO: el contacto no ha escrito nada. Se deja
    // explícito para que nadie lo confunda con "el paciente acaba de escribir"
    // (era el origen de la ventana de 24h fantasma).
    lastMessageDirection: 'out',
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
        return gateway.sendMedia(account, dest, hm.url, text, 'image', contextMessageId, quoteBody);
      }
      // Mensaje suelto con adjunto (imagen pegada, mensaje guardado, nota de voz).
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
    // Adjunto suelto por Cloud API. La media (URL pública propia o data URL) la
    // sube el gateway a Meta y la envía por id; NUNCA se degrada a "solo texto"
    // en silencio (eso marcaba "enviado" un mensaje SIN su adjunto). Si el envío
    // de la media falla, el resultado es FALLIDO con motivo, no un texto vacío.
    if (mediaUrl) {
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
    // "Plantilla" fuera de WhatsApp = solo su TEXTO ya resuelto (Meta no tiene HSM
    // para Messenger/Instagram, así que no hay nada que "aprobar"): `body` ya llega
    // renderizado desde `send()` (mismo `preview` que arma el mensaje del chat). La
    // cabecera multimedia de la plantilla (si tiene) se manda como adjunto real,
    // igual que ya hacían los números QR de WhatsApp con `templateInfo.headerMedia`.
    const hm = templateInfo?.headerMedia;
    const effectiveMediaUrl = mediaUrl || hm?.url || null;
    const effectiveMediaType = mediaUrl ? mediaType : hm?.type;
    if (!effectiveMediaUrl && !body) {
      return { ok: false, errorCode: 'invalid_recipient', error: 'Mensaje vacío' };
    }
    const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v23.0'}/me/messages?access_token=${pageAccessToken}`;
    const recipient = { id: conv.externalUserId || conv.phone };
    const extra = channel === 'messenger' ? { messaging_type: 'RESPONSE' } : {};
    // El Send API de Meta admite texto O adjunto por mensaje, NUNCA los dos a la
    // vez (a diferencia de WhatsApp, que sí manda imagen+pie en un solo envío).
    // Con adjunto Y texto, se manda el adjunto primero y el texto como una
    // segunda burbuja — así se ve un mensaje "con imagen y nota" como en la app.
    const ATTACHMENT_TYPE = { image: 'image', video: 'video', audio: 'audio', document: 'file' };
    let mediaResult = null;
    if (effectiveMediaUrl) {
      mediaResult = await postMetaMessage({
        accessToken: pageAccessToken,
        url,
        payload: {
          recipient,
          message: { attachment: { type: ATTACHMENT_TYPE[effectiveMediaType] || 'file', payload: { url: effectiveMediaUrl } } },
          ...extra,
        },
      });
      if (!mediaResult.ok) {
        return { ...mediaResult, error: mediaResult.error || 'El adjunto fue rechazado' };
      }
    }
    if (body) {
      const textResult = await postMetaMessage({
        accessToken: pageAccessToken,
        url,
        payload: { recipient, message: { text: body }, ...extra },
      });
      if (!textResult.ok) {
        return effectiveMediaUrl
          ? { ...textResult, error: `El adjunto se envió, pero el texto no: ${textResult.error}` }
          : textResult;
      }
      return textResult;
    }
    return mediaResult;
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
  mediaName,
  mediaSize,
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
  // `true` = aceptar el mensaje y entregarlo por detrás (lo usa el chat del call
  // center). El llamador recibe la respuesta en cuanto el mensaje está guardado,
  // sin esperar al proveedor; el resultado real llega por `chat:message:status`.
  // Por defecto false: workflows, campañas y tests siguen siendo síncronos y
  // conservan el `ok` del proveedor en la misma llamada.
  background = false,
  // Identificador que genera el navegador para ESTE envío. Si llega dos veces
  // (doble clic, reintento del navegador, red inestable) el segundo no se envía:
  // se devuelve el mensaje ya creado. Ver la comprobación de más abajo.
  clientId = '',
  // Número por el que FORZAR el envío (id de WhatsappAccount). Sin esto se usa el
  // del contacto (el último por el que escribió) y, si nunca escribió, el
  // principal. Lo usan las campañas y las importaciones cuando el usuario elige
  // "enviar todo desde este número" en vez de dejarlo automático.
  whatsappAccount = null,
  // Ficha de CONTACTO exacta de la que salen las variables de la campaña
  // ({{servicio}}, {{hora}}… del Excel importado). La trae la inscripción del
  // workflow. Ver la búsqueda del contacto más abajo: sin esto se buscaba por
  // teléfono y, con dos fichas del mismo número, salía el dato de la campaña VIEJA.
  contactId = null,
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

  // Idempotencia: el mismo envío pedido dos veces se manda UNA. Cubre el doble
  // clic del agente, el reintento automático del navegador y la petición repetida
  // tras una red inestable — las tres formas en que un paciente acababa
  // recibiendo el mismo video varias veces.
  if (clientId) {
    const already = await Message.findOne({ clinic: clinicId, conversation: conv._id, clientId });
    if (already) {
      return {
        ok: already.deliveryStatus !== 'failed',
        duplicate: true,
        messageId: already._id,
        externalId: already.externalId,
        deliveryStatus: already.deliveryStatus,
        errorCode: already.errorCode,
        errorMessage: already.errorMessage,
        message: already,
        conversation: conv,
      };
    }
  }

  const patientDoc = await resolvePatient({ clinicId, patient, conv, to: conv.phone || to });
  if (conv.blocked) return { ok: false, skipped: true, reason: 'blocked' };
  if (!ignoreOptOut) {
    const consentReason = optOutReasonFor(patientDoc, normalizedChannel);
    if (consentReason) return { ok: false, skipped: true, reason: consentReason };
  }

  // Resuelve el número (global) por el que se enviará. Determina además si aplica
  // la ventana de 24h (solo Cloud API).
  //   - `whatsappAccount` explícito → ese número, sin discusión (el usuario lo
  //     eligió a mano en la campaña o en la importación).
  //   - Sin él → el número del contacto: el enlazado a la conversación o, si no
  //     hay, aquel por el que ENTRÓ su último mensaje; y si nunca escribió, el
  //     principal. Es lo que hace que a quien nos escribió por el QR se le
  //     responda por el QR y no por el número de la API.
  let account = null;
  if (normalizedChannel === 'whatsapp') {
    if (whatsappAccount) {
      account = await gateway.getAccountById(whatsappAccount);
      if (account && !account.enabled) account = null;
    }
    if (!account) account = await gateway.resolveAccountForConversation(conv);
    if (!account) return { ok: false, skipped: true, reason: 'provider_unavailable' };
  }

  let templateInfo = normalizeTemplate(template, vars);
  // Las plantillas viven en el catálogo de WhatsApp (única fuente: aprobación de
  // Meta), pero su TEXTO se reutiliza para Messenger/Instagram — ahí no hay
  // plantillas HSM ni aprobación: se manda como mensaje normal (ver sendToProvider,
  // igual que ya hacían los números QR de WhatsApp, que tampoco admiten HSM).
  if (templateInfo && ['whatsapp', 'messenger', 'instagram'].includes(normalizedChannel)) {
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
    // El CONTACTO del CRM aporta las variables de la campaña ({{servicio}}/{{hora}}…
    // del Excel importado) y el nombre. Se carga SIEMPRE, aunque el teléfono también
    // sea un paciente: si no, un contacto que además es paciente (o cuyo número
    // coincide con uno) perdía sus customFields y las variables caían al EJEMPLO de la
    // plantilla. La cita real (si la hay) sigue teniendo prioridad en el resolutor;
    // los customFields solo rellenan lo que la cita no aporta.
    //
    // POR ID SIEMPRE QUE SE SEPA. `Contact` es único por (sede, teléfono), así que
    // un mismo número puede tener DOS fichas y buscar por teléfono devolvía la
    // primera del disco = la MÁS VIEJA. Resultado real en producción (27-jul-2026):
    // el recordatorio salió con "12:00 / bioresonancia" —la ficha de otra sede,
    // sin tocar desde el 23-jul— en vez del "08:00 / REVISION" que traía el Excel
    // recién importado. La inscripción sabe de qué ficha nació: se usa esa.
    // Como respaldo (envío manual desde el chat, sin inscripción), la más RECIENTE.
    let contactRef = null;
    try {
      const Contact = require('../models/Contact');
      const fields = 'firstName lastName displayName customFields';
      if (contactId) contactRef = await Contact.findById(contactId).select(fields).lean();
      if (!contactRef) {
        // En un chat de número oculto, `conv.phone` es el LID y ahí no hay ninguna
        // ficha: el teléfono real está en `linkedPhone` o es el destino pedido.
        const phones = [...new Set([normalizePhone(to), conv.linkedPhone, conv.phone].filter(Boolean))];
        if (phones.length) {
          contactRef = await Contact.findOne({ phone: { $in: phones } })
            .sort({ updatedAt: -1 })
            .select(fields)
            .lean();
        }
      }
    } catch {
      contactRef = null;
    }
    templateInfo = await enrichTemplateHeader(clinicId, templateInfo, patientRef, aptId, contactRef);
  }
  if (normalizedChannel === 'whatsapp' && gateway.isCloud(account)) {
    // Aquí se GUARDABA en `window24hExpiresAt` la ventana recién calculada. Eso
    // era lo que hacía PERMANENTE la ventana fantasma: bastaba que el cálculo se
    // equivocara una vez (chat recién nacido de un envío nuestro) para que la
    // conversación arrastrara para siempre una ventana que Meta no reconoce. El
    // campo lo escribe solo la ingesta de entrantes, que es quien la abre de verdad.
    // La ventana se mide contra el número por el que SALE este mensaje: si el
    // contacto escribió a otro de nuestros números, aquí no hay ventana ninguna
    // (Meta la lleva por pareja número-contacto) y el texto libre se perdería.
    if (!isWhatsappWindowOpen(conv, new Date(), account._id) && !templateInfo) {
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
    else if (mediaUrl) {
      preview = mediaType === 'audio' ? '[nota de voz]'
        : mediaType === 'document' ? `📎 ${mediaName || 'Archivo'}`
          : '[media]';
    } else preview = '';
  }
  // La cabecera multimedia de la plantilla se guarda en el mensaje para que la
  // burbuja del chat muestre la plantilla TAL CUAL la recibe el paciente.
  const tplMedia = templateInfo?.headerMedia || null;
  let msg;
  try {
    msg = await Message.create({
      clinic: clinicId,
      conversation: conv._id,
      direction: 'out',
      body: preview,
      mediaUrl: mediaUrl || tplMedia?.url || null,
      mediaType: mediaType || tplMedia?.type || null,
      mediaName: mediaName || '',
      mediaSize: Number(mediaSize) || 0,
      templateName: templateInfo?.name || '',
      // Por qué número SALIÓ. Sin esto, "¿por qué Meta dice que la ventana está
      // cerrada?" no se podía contestar mirando la base: los 44.720 salientes que
      // había no decían por dónde habían ido.
      whatsappAccount: account?._id || null,
      ...(clientId ? { clientId } : {}),
      ...(replyTo ? { replyTo } : {}),
      deliveryStatus: 'queued',
      sentBy: sentBy || null,
      sentByName: sentByName || '',
      isAutoReply,
    });
  } catch (err) {
    // Dos peticiones a la vez con el mismo `clientId` (doble clic de verdad
    // simultáneo): la comprobación de arriba puede no verlas y es el índice único
    // { conversation, clientId } el que corta la segunda. Se devuelve el mensaje
    // que ganó la carrera en vez de reventar — el paciente recibe UNO.
    if (err?.code === 11000 && clientId) {
      const existing = await Message.findOne({ clinic: clinicId, conversation: conv._id, clientId });
      if (existing) {
        return {
          ok: existing.deliveryStatus !== 'failed',
          duplicate: true,
          messageId: existing._id,
          deliveryStatus: existing.deliveryStatus,
          message: existing,
          conversation: conv,
        };
      }
    }
    throw err;
  }

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

  /**
   * Deja la conversación al día tras aceptar el mensaje. Se aplica ANTES de que
   * el proveedor conteste: la bandeja tiene que reordenarse en el acto, no dentro
   * de 72 segundos cuando termine de subir un video.
   */
  async function touchConversation() {
    conv.lastMessageAt = msg.createdAt;
    conv.lastMessagePreview = preview.slice(0, 140);
    conv.lastMessageDirection = 'out';
    // Recuerda por qué número salió, para que las próximas respuestas usen el mismo.
    if (account && !conv.whatsappAccount) conv.whatsappAccount = account._id;
    if (sentBy) {
      conv.lastAgentReplyAt = new Date();
      if (!conv.firstResponseAt) conv.firstResponseAt = conv.lastAgentReplyAt;
      // El "no leído" se limpia SOLO cuando un agente responde (no al abrir el
      // chat). Los envíos automáticos/workflows no traen `sentBy`, así que no
      // borran el pendiente: el chat sigue marcado hasta que alguien conteste.
      conv.unreadCount = 0;
      await Message.updateMany(
        { conversation: conv._id, direction: 'in', isRead: false },
        { isRead: true }
      );
    }
    await conv.save();
  }

  // ENVÍO EN SEGUNDO PLANO (lo usa el chat del call center). El mensaje ya está
  // guardado como 'queued' y se anuncia YA por socket: el agente lo ve al
  // instante y puede saltar al siguiente chat. La entrega real sigue por detrás y
  // el estado (enviado/fallido) llega por `chat:message:status`.
  //
  // Antes esto era síncrono: la petición HTTP se quedaba colgada hasta 5 minutos
  // enviando un video por QR (ver whatsappQrManager.sendMedia). El agente creía
  // que no se había enviado, volvía a pulsar y el paciente recibía el mismo video
  // tres veces — pasó en producción el 25-jul-2026 a las 19:06, 19:07 y 19:08.
  if (background) {
    await touchConversation();
    // Copia CONGELADA del mensaje tal y como se acepta. `deliver()` sigue
    // mutando el documento de mongoose por detrás, así que devolver el documento
    // vivo haría que la respuesta HTTP dijera una cosa u otra según lo rápido que
    // conteste el proveedor. Lo que el llamador recibe siempre es "aceptado, en
    // cola"; el desenlace llega por `chat:message:status`.
    const accepted = sanitizeMessageForSocket(msg);
    emitToCallCenter('chat:message', { conversationId: conv._id, message: accepted });
    deliver().catch((err) => {
      console.error('[messaging] fallo entregando en segundo plano msg=%s: %s', String(msg._id), err.message);
    });
    return {
      ok: true,
      queued: true,
      messageId: msg._id,
      deliveryStatus: 'queued',
      message: accepted,
      conversation: conv,
    };
  }

  return deliver();

  // eslint-disable-next-line func-style
  async function deliver() {
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

    // En segundo plano la conversación ya se actualizó al aceptar el mensaje.
    if (!background) await touchConversation();

    // El resultado de la entrega viaja como CAMBIO DE ESTADO, no como mensaje
    // nuevo: en segundo plano la burbuja ya está pintada en el chat y volver a
    // emitir `chat:message` la duplicaría.
    if (background) {
      emitToCallCenter('chat:message:status', {
        conversationId: conv._id,
        messageId: msg._id,
        externalId: msg.externalId,
        deliveryStatus: msg.deliveryStatus,
        statusTimestamps: msg.statusTimestamps,
        errorCode: msg.errorCode,
        errorMessage: msg.errorMessage,
      });
    } else {
      emitToCallCenter('chat:message', {
        conversationId: conv._id,
        message: sanitizeMessageForSocket(msg),
      });
    }

    if (!providerResult.ok) {
      console.warn(
        '[messaging] envío FALLIDO conv=%s msg=%s code=%s: %s',
        String(conv._id), String(msg._id), msg.errorCode || '', msg.errorMessage || ''
      );
    }

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
}

function mapProviderStatus(status) {
  const value = String(status || '').toLowerCase();
  if (DELIVERY_STATUSES.has(value)) return value;
  if (value === 'received') return 'delivered';
  return null;
}

// Orden natural de la entrega. El estado solo debe AVANZAR.
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * ¿Debe el estado `next` reemplazar al `current`? Los webhooks de Meta y los acks
 * de whatsapp-web.js son callbacks INDEPENDIENTES que llegan fuera de orden y se
 * reintentan. Sin esta guarda, un 'sent' tardío pisa un 'delivered'/'read' real, o
 * —lo más peligroso— un estado tardío REVIVE un 'failed' y el sistema muestra
 * "enviado/entregado" un mensaje que el contacto NUNCA recibió. Reglas:
 *  - 'failed' es TERMINAL: no se revive con estados posteriores.
 *  - un 'failed' entrante gana solo sobre 'queued'/'sent' (Meta aceptó el POST pero
 *    después no pudo entregar); nunca borra una entrega real ('delivered'/'read').
 *  - el resto solo aplica si AVANZA en el rango (nunca retrocede).
 */
function shouldApplyStatus(current, next) {
  if (current === next) return false;
  if (!current) return true;
  if (current === 'failed') return false;
  if (next === 'failed') return current === 'queued' || current === 'sent';
  return (STATUS_RANK[next] ?? -1) > (STATUS_RANK[current] ?? -1);
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
  pricing = null,
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

  // Cómo cobró Meta este mensaje. Se guarda ANTES de la guardia de orden: el
  // bloque `pricing` viaja en el estado 'sent', que llega después del
  // 'delivered' con frecuencia — si se ignorara con el estado, se perdería el
  // único dato que dice con qué categoría se cobró el mensaje.
  if (pricing) {
    const prev = msg.billing || {};
    const next = {
      billable: pricing.billable ?? prev.billable ?? null,
      category: String(pricing.category || prev.category || '').toLowerCase(),
      type: String(pricing.type || prev.type || '').toLowerCase(),
      model: String(pricing.model || prev.model || '').toUpperCase(),
    };
    if (next.billable !== prev.billable || next.category !== (prev.category || '')
      || next.type !== (prev.type || '') || next.model !== (prev.model || '')) {
      msg.billing = next;
      await msg.save();
    }
  }

  // Solo AVANZAR el estado: un callback fuera de orden no debe pisar una entrega
  // real ni revivir un 'failed'. Si no aplica, se ignora sin tocar la etiqueta
  // (así "entregado"/"leído"/"fallido" son fiables y no mienten sobre la entrega).
  const apply = shouldApplyStatus(msg.deliveryStatus, deliveryStatus);
  if (!apply) {
    return { ok: true, message: msg, ignored: true, deliveryStatus: msg.deliveryStatus };
  }

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
  findConversationForPerson,
  buildTemplateComponents,
  enrichTemplateHeader,
  computeWhatsappWindowExpiresAt,
  describeWhatsappWindow,
  getWhatsappWindowExpiresAt,
  isOptOutText,
  isWhatsappWindowOpen,
  mapProviderStatus,
  normalizePhone,
  send,
  shouldApplyStatus,
  timestampFieldForStatus,
  updateMessageStatus,
};
