const crypto = require('crypto');

/**
 * Meta Conversions API (CAPI): reporta conversiones del CRM a Meta para que el
 * algoritmo de anuncios optimice por resultados reales del chat (CRO).
 *
 * Eventos estándar que enviamos (nombres exactos, CamelCase — Meta los valida):
 *  - Lead      → primera conversación de WhatsApp de un contacto.
 *  - Schedule  → cita agendada para un paciente.
 *  - Purchase  → venta pagada (contado) o cobro registrado (crédito). Lleva
 *                value + currency (obligatorios para ROAS).
 *
 * Reglas de Meta que se respetan aquí:
 *  - user_data hasheado en SHA-256, normalizado (trim + minúsculas; el teléfono
 *    solo dígitos con código de país).
 *  - action_source: 'chat' (la conversión ocurre en una conversación, no en web).
 *  - event_id único para deduplicación (los reintentos no duplican conversiones).
 *  - ctwa_clid (click-to-WhatsApp) se envía SIN hashear: es el matching más
 *    fuerte cuando el contacto llegó desde un anuncio.
 *
 * La configuración (datasetId + accessToken CAPI) vive en CallCenterWhatsappConfig
 * (singleton global). Si CAPI está deshabilitado o sin credenciales, todas las
 * funciones devuelven { ok:false, skipped:true } sin lanzar: reportar a Meta
 * NUNCA debe romper el flujo de negocio que lo dispara.
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

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
  };
}

/**
 * Construye el user_data con matching hasheado. `ctwaClid` va en claro (regla de Meta).
 */
function buildUserData({ phone, email, firstName, lastName, ctwaClid }) {
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
  return userData;
}

/**
 * Envía UN evento de conversión a Meta. No lanza jamás.
 *
 * @param {string} opts.eventName  Nombre estándar exacto ('Lead', 'Schedule', 'Purchase'…)
 * @param {string} opts.eventId    Id único para deduplicación (ej. 'lead_<convId>')
 * @param {object} opts.user       { phone, email, firstName, lastName, ctwaClid }
 * @param {object} opts.customData custom_data extra; para Purchase incluir { value, currency }
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, data?:object}>}
 */
async function sendConversionEvent({ eventName, eventId, user = {}, customData = {} }) {
  try {
    const cfg = await getCapiConfig();
    if (!cfg) return { ok: false, skipped: true, reason: 'capi_not_configured' };

    const userData = buildUserData(user);
    // Sin ningún identificador no hay matching posible: no vale la pena enviar.
    if (!userData.ph && !userData.em && !userData.ctwa_clid) {
      return { ok: false, skipped: true, reason: 'no_user_identifiers' };
    }

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId || `${eventName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          action_source: 'chat',
          user_data: userData,
          custom_data: { lead_source: 'whatsapp_crm', ...customData },
        },
      ],
    };
    if (cfg.testEventCode) payload.test_event_code = cfg.testEventCode;

    const url = `https://graph.facebook.com/${API_VERSION}/${cfg.datasetId}/events?access_token=${encodeURIComponent(cfg.accessToken)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = data?.error?.message || `HTTP ${res.status}`;
      console.error(`[CAPI] Error al enviar '${eventName}':`, error);
      return { ok: false, error, data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error(`[CAPI] Error al enviar '${eventName}':`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Datos de matching de un paciente (teléfono/email/nombre + ctwa_clid si vino de anuncio). */
function patientUserData(patient) {
  if (!patient) return {};
  return {
    phone: patient.whatsapp || patient.phone || '',
    email: patient.email || '',
    firstName: patient.firstName || '',
    lastName: patient.lastName || '',
    ctwaClid: patient.attribution?.ctwaClid || '',
  };
}

/**
 * Lead: primera conversación entrante de WhatsApp. Lo llama el webhook al crear
 * la conversación (chatController.ingestExternalMessage). Fire-and-forget.
 */
function reportLead({ conversationId, phone, contactName, ctwaClid, adId }) {
  return sendConversionEvent({
    eventName: 'Lead',
    eventId: `lead_${conversationId}`,
    user: { phone, firstName: contactName, ctwaClid },
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
function subscribeDomainEvents() {
  const { onDomainEvent, DOMAIN_EVENTS } = require('./events');
  const Patient = require('../models/Patient');

  // Cita agendada → Schedule
  onDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, async (payload) => {
    if (!payload?.patientId) return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    await sendConversionEvent({
      eventName: 'Schedule',
      eventId: `schedule_${payload.appointmentId || payload.patientId + '_' + Date.now()}`,
      user: patientUserData(patient),
      customData: { chat_funnel_stage: 'cita_agendada' },
    });
  });

  // Venta creada → Purchase (solo si quedó pagada; una venta a crédito reporta
  // Purchase cuando se registra el cobro — evento payment.received).
  onDomainEvent(DOMAIN_EVENTS.SALE_CREATED, async (payload) => {
    if (!payload?.saleId || !payload?.patientId) return;
    const Sale = require('../models/Sale');
    const sale = await Sale.findById(payload.saleId);
    if (!sale || sale.paymentMethod === 'credito') return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    await sendConversionEvent({
      eventName: 'Purchase',
      eventId: `purchase_sale_${sale._id}`,
      user: patientUserData(patient),
      customData: {
        value: Number(sale.total || 0),
        currency: 'USD',
        content_type: 'product',
        chat_funnel_stage: 'venta_pagada',
      },
    });
  });

  // Cobro registrado a un paciente (ventas a crédito, facturas) → Purchase
  onDomainEvent(DOMAIN_EVENTS.PAYMENT_RECEIVED, async (payload) => {
    if (!payload?.patientId || !(Number(payload.total) > 0)) return;
    const patient = await Patient.findById(payload.patientId);
    if (!patient) return;
    await sendConversionEvent({
      eventName: 'Purchase',
      eventId: `purchase_payment_${payload.paymentId}`,
      user: patientUserData(patient),
      customData: {
        value: Number(payload.total),
        currency: 'USD',
        content_type: 'product',
        chat_funnel_stage: 'cobro_registrado',
      },
    });
  });
}

module.exports = {
  hashSha256,
  normalizePhoneForCapi,
  buildUserData,
  getCapiConfig,
  sendConversionEvent,
  reportLead,
  subscribeDomainEvents,
};
