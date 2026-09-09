const crypto = require('crypto');

/**
 * Meta Conversions API (CAPI): reporta conversiones del CRM a Meta para que el
 * algoritmo de anuncios optimice por resultados reales del chat (CRO).
 *
 * Eventos principales que enviamos (nombres exactos de Business Messaging):
 *  - LeadSubmitted → primera conversación atribuible a un anuncio CTWA.
 *  - QualifiedLead → cita agendada para un paciente atribuible.
 *  - Purchase      → venta completamente pagada. Lleva value + currency.
 *
 * Reglas de Meta que se respetan aquí (spec oficial de business messaging / CTWA:
 * developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging):
 *  - action_source: 'business_messaging' + messaging_channel: 'whatsapp'. OJO: el
 *    valor 'chat' es aceptado por la API pero NO atribuye la conversión al anuncio
 *    click-to-WhatsApp — el evento entra sin error pero no optimiza la campaña.
 *  - user_data: ctwa_clid (SIN hashear, matching fuerte del anuncio) +
 *    whatsapp_business_account_id (WABA). El teléfono/email/nombre se hashean en
 *    SHA-256 (normalizados: trim + minúsculas; teléfono solo dígitos con código de
 *    país).
 *  - event_id único para deduplicación (los reintentos no duplican conversiones).
 *
 * La configuración (datasetId + accessToken CAPI) vive en CallCenterWhatsappConfig
 * (singleton global). Si CAPI está deshabilitado o sin credenciales, todas las
 * funciones devuelven { ok:false, skipped:true } sin lanzar: reportar a Meta
 * NUNCA debe romper el flujo de negocio que lo dispara.
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

// Conversions API for Business Messaging has a narrower event allowlist than
// the web Pixel API. Keep legacy aliases here so workflows saved before this
// correction continue working without sending invalid names to Meta.
const BUSINESS_MESSAGING_EVENTS = new Set([
  'Purchase',
  'LeadSubmitted',
  'QualifiedLead',
  'InitiateCheckout',
  'AddToCart',
  'ViewContent',
  'OrderCreated',
  'OrderShipped',
  'OrderDelivered',
  'OrderCanceled',
  'OrderReturned',
  'CartAbandoned',
  'RatingProvided',
  'ReviewProvided',
]);
const LEGACY_EVENT_NAMES = {
  Lead: 'LeadSubmitted',
  Schedule: 'QualifiedLead',
  Contact: 'LeadSubmitted',
  CompleteRegistration: 'LeadSubmitted',
  SubmitApplication: 'QualifiedLead',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEventName(value) {
  const raw = String(value || '').trim();
  return LEGACY_EVENT_NAMES[raw] || raw;
}

/** SHA-256 en hex sobre el dato normalizado (trim + minúsculas), como exige Meta. */
function hashSha256(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value).trim().toLowerCase();
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

/** Teléfono para matching: solo dígitos, con código de país (ej. 593987654321). */
function normalizePhoneForCapi(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits || null;
}

/**
 * WABA (WhatsApp Business Account) id para los eventos: primero el configurado a
 * mano; si no, se deduce solo cuando hay una única WABA Cloud API activa.
 * Meta lo exige en user_data para atribuir conversiones de business messaging.
 */
async function resolveWabaId(override) {
  if (override && String(override).trim()) return String(override).trim();
  try {
    const WhatsappAccount = require('../models/WhatsappAccount');
    const ids = await WhatsappAccount.distinct('businessAccountId', {
      connectionType: 'cloud_api',
      archivedAt: null,
      businessAccountId: { $nin: ['', null] },
    });
    const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    // Nunca adivinar entre dos WABA: el ctwa_clid solo es válido con la WABA
    // exacta que lo emitió. En ese caso el administrador debe elegirla.
    return unique.length === 1 ? unique[0] : '';
  } catch {
    return '';
  }
}

/** Config CAPI activa o null (deshabilitada / incompleta). */
async function getCapiConfig() {
  const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  const capi = cfg?.conversionsApi;
  if (!capi?.enabled || !capi.datasetId || !capi.accessToken) return null;
  const { decryptSecret } = require('./secretCrypto');
  return {
    datasetId: capi.datasetId,
    accessToken: decryptSecret(capi.accessToken),
    testEventCode: capi.testEventCode || '',
    wabaId: await resolveWabaId(capi.whatsappBusinessAccountId),
  };
}

/** Comprueba token, WABA y que el dataset pertenezca a esa misma WABA. */
async function validateCapiConfiguration() {
  const cfg = await getCapiConfig();
  if (!cfg) return { ok: false, reason: 'capi_not_configured' };
  if (!cfg.wabaId) return { ok: false, reason: 'missing_waba_id' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${cfg.wabaId}/dataset`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}`, data };
    const ids = (data?.data || []).map((item) => String(item?.id || '')).filter(Boolean);
    if (!ids.includes(String(cfg.datasetId))) {
      return {
        ok: false,
        reason: 'dataset_waba_mismatch',
        error: `El Dataset ID configurado no pertenece a la WABA ${cfg.wabaId}`,
        data,
      };
    }
    return { ok: true, cfg, data };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Tiempo de espera agotado al validar la configuración con Meta' : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Encuentra el clic CTWA más reciente que pertenece a la WABA configurada.
 * Message es el snapshot más fiable: conserva el ctwa_clid y el número exacto
 * por el que entró, aun cuando el contacto vuelva a hacer clic en otro anuncio.
 */
async function findLatestCtwaAttribution({ wabaId, conversationIds = [] } = {}) {
  if (!wabaId) return null;
  const WhatsappAccount = require('../models/WhatsappAccount');
  const Message = require('../models/Message');
  const accountIds = await WhatsappAccount.find({
    connectionType: 'cloud_api',
    businessAccountId: String(wabaId),
  }).distinct('_id');
  if (!accountIds.length) return null;

  const query = {
    direction: 'in',
    whatsappAccount: { $in: accountIds },
    'referral.ctwaClid': { $type: 'string', $ne: '' },
  };
  if (conversationIds.length) query.conversation = { $in: conversationIds };
  return Message.findOne(query)
    .sort({ createdAt: -1 })
    .populate('conversation', 'phone contactName patient')
    .populate('whatsappAccount', 'businessAccountId label connectionType')
    .lean();
}

/**
 * Construye el user_data con matching hasheado. `ctwa_clid` y
 * `whatsapp_business_account_id` van en claro (regla de Meta para business messaging).
 */
function buildUserData({ phone, email, firstName, lastName, ctwaClid, wabaId }) {
  const userData = {};
  const ph = hashSha256(normalizePhoneForCapi(phone));
  if (ph) userData.ph = [ph];
  const em = hashSha256(email);
  if (em) userData.em = [em];
  const fn = hashSha256(firstName);
  if (fn) userData.fn = [fn];
  const ln = hashSha256(lastName);
  if (ln) userData.ln = [ln];
  if (ctwaClid) userData.ctwa_clid = String(ctwaClid);
  if (wabaId) userData.whatsapp_business_account_id = String(wabaId);
  return userData;
}

/**
 * Envía UN evento de conversión a Meta. No lanza jamás.
 *
 * @param {string} opts.eventName  Evento admitido por Business Messaging.
 * @param {string} opts.eventId    Id único para deduplicación (ej. 'lead_<convId>')
 * @param {object} opts.user       { phone, email, firstName, lastName, ctwaClid }
 * @param {object} opts.customData custom_data extra; para Purchase incluir { value, currency }
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, data?:object}>}
 */
async function sendConversionEvent({ eventName, eventId, user = {}, customData = {} }) {
  try {
    const cfg = await getCapiConfig();
    if (!cfg) return { ok: false, skipped: true, reason: 'capi_not_configured' };

    const normalizedEventName = normalizeEventName(eventName);
    if (!BUSINESS_MESSAGING_EVENTS.has(normalizedEventName)) {
      return {
        ok: false,
        skipped: true,
        reason: 'unsupported_business_messaging_event',
        error: `El evento ${eventName || '(vacío)'} no es válido para WhatsApp Business Messaging`,
      };
    }

    const eventWabaId = String(user.wabaId || cfg.wabaId || '').trim();
    if (!user.ctwaClid) return { ok: false, skipped: true, reason: 'missing_ctwa_clid' };
    if (!eventWabaId) return { ok: false, skipped: true, reason: 'missing_waba_id' };
    if (cfg.wabaId && eventWabaId !== String(cfg.wabaId)) {
      return { ok: false, skipped: true, reason: 'waba_mismatch' };
    }

    const userData = buildUserData({ ...user, wabaId: eventWabaId });
    if (normalizedEventName === 'Purchase') {
      const value = Number(customData.value);
      const currency = String(customData.currency || '').trim().toUpperCase();
      if (!(value >= 0) || !/^[A-Z]{3}$/.test(currency)) {
        return { ok: false, skipped: true, reason: 'invalid_purchase_data' };
      }
      customData = { ...customData, value, currency };
    }

    const payload = {
      data: [
        {
          event_name: normalizedEventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId || `${normalizedEventName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          // Business messaging (no 'chat'): así Meta atribuye la conversión al
          // anuncio click-to-WhatsApp vía ctwa_clid.
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: userData,
          custom_data: { lead_source: 'whatsapp_crm', ...customData },
        },
      ],
    };
    if (cfg.testEventCode) payload.test_event_code = cfg.testEventCode;

    const url = `https://graph.facebook.com/${API_VERSION}/${cfg.datasetId}/events`;
    let lastError = '';
    let lastData = {};
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.accessToken}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        lastData = data;
        if (res.ok && Number(data?.events_received) > 0) {
          return { ok: true, data, eventName: normalizedEventName };
        }

        lastError = data?.error?.message || data?.messages?.join?.('; ') ||
          (res.ok ? 'Meta no confirmó la recepción del evento' : `HTTP ${res.status}`);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === 3) break;
      } catch (err) {
        lastError = err.name === 'AbortError' ? 'Tiempo de espera agotado al conectar con Meta' : err.message;
        if (attempt === 3) break;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(attempt * 300);
    }
    console.error(`[CAPI] Error al enviar '${normalizedEventName}':`, lastError);
    return { ok: false, error: lastError, data: lastData };
  } catch (err) {
    console.error(`[CAPI] Error al enviar '${eventName}':`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Datos personales de matching. La atribución CTWA se resuelve desde Message. */
function patientUserData(patient) {
  if (!patient) return {};
  return {
    phone: patient.whatsapp || patient.phone || '',
    email: patient.email || '',
    firstName: patient.firstName || '',
    lastName: patient.lastName || '',
  };
}

/**
 * Datos del paciente más la atribución CTWA real y más reciente de sus chats.
 * `conversationId` tiene prioridad para citas creadas directamente desde un chat.
 */
async function conversionUserData({ patient, conversationId, phone } = {}) {
  const base = patientUserData(patient);
  if (!base.phone && phone) base.phone = phone;

  const cfg = await getCapiConfig();
  if (!cfg?.wabaId) return base;

  const Conversation = require('../models/Conversation');
  let conversationIds = [];
  if (conversationId) {
    conversationIds = [conversationId];
  } else if (patient?._id) {
    conversationIds = await Conversation.find({ patient: patient._id, channel: 'whatsapp' }).distinct('_id');
  }
  if ((conversationId || patient?._id) && !conversationIds.length) {
    return base;
  }

  const hit = await findLatestCtwaAttribution({ wabaId: cfg.wabaId, conversationIds });
  if (hit?.referral?.ctwaClid) {
    const conv = hit.conversation || {};
    return {
      ...base,
      phone: base.phone || conv.phone || phone || '',
      firstName: base.firstName || conv.contactName || '',
      ctwaClid: hit.referral.ctwaClid,
      wabaId: hit.whatsappAccount?.businessAccountId || cfg.wabaId,
    };
  }

  return base;
}

/**
 * Lead: primera conversación entrante de WhatsApp. Lo llama el webhook al crear
 * la conversación (chatController.ingestExternalMessage). Fire-and-forget.
 */
function reportLead({ conversationId, phone, contactName, ctwaClid, adId, wabaId }) {
  return sendConversionEvent({
    eventName: 'LeadSubmitted',
    eventId: `lead_${conversationId}`,
    user: { phone, firstName: contactName, ctwaClid, wabaId },
    customData: {
      chat_funnel_stage: 'nueva_conversacion',
      ...(adId ? { ad_id: String(adId) } : {}),
    },
  });
}

/**
 * Suscribe los disparadores CAPI al bus de eventos de dominio. Se registra una
 * vez en index.js. Cada handler carga el paciente para armar el matching.
 */
let domainEventsSubscribed = false;
function subscribeDomainEvents() {
  if (domainEventsSubscribed) return;
  domainEventsSubscribed = true;
  const { onDomainEvent, DOMAIN_EVENTS } = require('./events');
  const Patient = require('../models/Patient');

  // Cita agendada → QualifiedLead (Schedule es un evento web y Meta lo rechaza
  // cuando action_source es business_messaging).
  onDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, async (payload) => {
    if (!payload?.patientId) return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    const user = await conversionUserData({ patient, conversationId: payload.conversationId });
    await sendConversionEvent({
      eventName: 'QualifiedLead',
      eventId: `schedule_${payload.appointmentId || payload.patientId + '_' + Date.now()}`,
      user,
      customData: { chat_funnel_stage: 'cita_agendada' },
    });
  });

  // Venta creada → Purchase (solo si quedó pagada; una venta a crédito reporta
  // Purchase cuando se registra el cobro — evento payment.received).
  onDomainEvent(DOMAIN_EVENTS.SALE_CREATED, async (payload) => {
    if (!payload?.saleId || !payload?.patientId) return;
    const Sale = require('../models/Sale');
    const sale = await Sale.findById(payload.saleId);
    if (!sale || !sale.paid || !(Number(sale.total) >= 0)) return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    const user = await conversionUserData({ patient });
    await sendConversionEvent({
      eventName: 'Purchase',
      eventId: `purchase_sale_${sale._id}`,
      user,
      customData: {
        value: Number(sale.total || 0),
        currency: 'USD',
        content_type: 'product',
        chat_funnel_stage: 'venta_pagada',
      },
    });
  });

  // Cobro que termina de pagar una venta → Purchase. El event_id es el mismo que
  // usa SALE_CREATED para que un reintento o una carrera no duplique la compra.
  onDomainEvent(DOMAIN_EVENTS.PAYMENT_RECEIVED, async (payload) => {
    if (!payload?.patientId) return;
    const Sale = require('../models/Sale');
    const saleIds = [];
    if (payload.saleId) saleIds.push(payload.saleId);
    // collectSale usa un JournalEntry como paymentId y ya entrega saleId. Solo
    // consultar Payment cuando el evento vino del controlador general de cobros.
    if (payload.paymentId && !payload.saleId) {
      const Payment = require('../models/Payment');
      const payment = await Payment.findById(payload.paymentId).select('applications').lean();
      for (const app of payment?.applications || []) {
        if (app.docModel === 'Sale' && app.docRef) saleIds.push(app.docRef);
      }
    }
    if (!saleIds.length) return;
    const uniqueSaleIds = [...new Set(saleIds.map(String))];
    const sales = await Sale.find({
      _id: { $in: uniqueSaleIds },
      patient: payload.patientId,
      status: 'completada',
      paid: true,
    });
    if (!sales.length) return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    const user = await conversionUserData({ patient });
    for (const sale of sales) {
      await sendConversionEvent({
        eventName: 'Purchase',
        eventId: `purchase_sale_${sale._id}`,
        user,
        customData: {
          value: Number(sale.total || 0),
          currency: 'USD',
          content_type: 'product',
          chat_funnel_stage: 'venta_pagada',
        },
      });
    }
  });
}

module.exports = {
  hashSha256,
  normalizePhoneForCapi,
  normalizeEventName,
  BUSINESS_MESSAGING_EVENTS,
  buildUserData,
  patientUserData,
  conversionUserData,
  findLatestCtwaAttribution,
  resolveWabaId,
  getCapiConfig,
  validateCapiConfiguration,
  sendConversionEvent,
  reportLead,
  subscribeDomainEvents,
};
