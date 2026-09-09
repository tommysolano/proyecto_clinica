/**
 * Integración del webhook de WhatsApp Cloud API contra los controllers reales y
 * un Mongo en memoria: firma, ingesta de mensajes, botones interactivos,
 * deduplicación por reintento, atribución click-to-WhatsApp, calidad del número
 * y envío de eventos a la Conversions API (con fetch interceptado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const callCenterConfig = require('../controllers/callCenterConfigController');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Patient = require('../models/Patient');
const capi = require('../utils/metaConversions');
const { clearCache } = require('../utils/callCenterClinic');

const APP_SECRET = 'test-app-secret';

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); clearCache(); });

/** Config global + número Cloud API listos para recibir webhooks. */
async function seedWhatsapp() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.cloudApi = { appSecret: APP_SECRET, verifyToken: 'tok' };
  cfg.callCenterClinic = clinicId;
  await cfg.save();
  const account = await WhatsappAccount.create({
    label: 'Principal',
    connectionType: 'cloud_api',
    phoneNumberId: '111222333',
    businessAccountId: 'waba1',
    accessToken: 'token-x',
    displayPhone: '+593 99 111 2233',
  });
  return { clinicId, account };
}

/** Simula el POST firmado de Meta al webhook único de WhatsApp. */
async function postWebhook(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  const req = { body, rawBody, headers: { 'x-hub-signature-256': signature }, params: {}, query: {} };
  return H.runController(chat.webhookWhatsappReceive, req);
}

const messagePayload = (msg, { phoneNumberId = '111222333', contacts } = {}) => ({
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: phoneNumberId },
        contacts: contacts || [{ profile: { name: 'Ana Cliente' } }],
        messages: [msg],
      },
    }],
  }],
});

test('rechaza el webhook con firma inválida', async () => {
  await seedWhatsapp();
  const body = messagePayload({ from: '593999000111', id: 'wamid.1', type: 'text', text: { body: 'hola' } });
  const req = {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-hub-signature-256': 'sha256=firma-falsa' },
    params: {},
    query: {},
  };
  const r = await H.runController(chat.webhookWhatsappReceive, req);
  assert.equal(r.statusCode, 403);
  assert.equal(await Message.countDocuments(), 0);
});

test('ingesta texto entrante: conversación + mensaje + atribución click-to-WhatsApp', async () => {
  const { clinicId } = await seedWhatsapp();
  const r = await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.text1',
    type: 'text',
    text: { body: 'Vi su anuncio' },
    referral: { source_id: 'ad_777', headline: 'Promo julio', ctwa_clid: 'CLID-abc' },
  }));
  assert.equal(r.statusCode, 200);

  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593999000111' });
  assert.ok(conv, 'debe crear la conversación');
  assert.equal(conv.attribution.adId, 'ad_777');
  assert.equal(conv.attribution.ctwaClid, 'CLID-abc');
  assert.equal(conv.contactName, 'Ana Cliente');

  const msg = await Message.findOne({ conversation: conv._id });
  assert.equal(msg.body, 'Vi su anuncio');
  assert.equal(msg.externalId, 'wamid.text1');
  assert.equal(msg.direction, 'in');
  // El anuncio de origen queda en el mensaje para pintarlo en el chat.
  assert.equal(msg.referral.sourceId, 'ad_777');
  assert.equal(msg.referral.headline, 'Promo julio');
  assert.equal(msg.referral.ctwaClid, 'CLID-abc');
});

test('reintento de Meta (mismo message id) NO duplica el mensaje', async () => {
  const { clinicId } = await seedWhatsapp();
  const payload = messagePayload({ from: '593999000111', id: 'wamid.dup', type: 'text', text: { body: 'hola' } });
  await postWebhook(payload);
  await postWebhook(payload); // reintento idéntico
  assert.equal(await Message.countDocuments({ clinic: clinicId, externalId: 'wamid.dup' }), 1);
  assert.equal(await Conversation.countDocuments({ clinic: clinicId }), 1);
});

test('captura id y título de botones interactivos y de listas', async () => {
  const { clinicId } = await seedWhatsapp();
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.btn1',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'quiero_promo', title: 'Quiero la promo' } },
  }));
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.list1',
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: 'svc_limpieza', title: 'Limpieza dental' } },
  }));
  // Botón de respuesta rápida de plantilla (formato m.button con payload).
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.tplbtn1',
    type: 'button',
    button: { payload: 'confirmar_cita', text: 'Confirmar' },
  }));

  const btn = await Message.findOne({ clinic: clinicId, externalId: 'wamid.btn1' });
  assert.equal(btn.interactiveReply.id, 'quiero_promo');
  assert.equal(btn.interactiveReply.type, 'button_reply');
  assert.equal(btn.body, 'Quiero la promo');

  const list = await Message.findOne({ clinic: clinicId, externalId: 'wamid.list1' });
  assert.equal(list.interactiveReply.id, 'svc_limpieza');
  assert.equal(list.interactiveReply.type, 'list_reply');
  assert.equal(list.body, 'Limpieza dental');

  const tplBtn = await Message.findOne({ clinic: clinicId, externalId: 'wamid.tplbtn1' });
  assert.equal(tplBtn.interactiveReply.id, 'confirmar_cita');
  assert.equal(tplBtn.body, 'Confirmar');
});

test('webhook de calidad: FLAGGED marca el número en ROJO y crea alerta', async () => {
  const { clinicId, account } = await seedWhatsapp();
  const body = {
    entry: [{
      changes: [{
        field: 'phone_number_quality_update',
        value: { display_phone_number: '+593991112233', event: 'FLAGGED', current_limit: 'TIER_250' },
      }],
    }],
  };
  const r = await postWebhook(body);
  assert.equal(r.statusCode, 200);

  const acc = await WhatsappAccount.findById(account._id);
  assert.equal(acc.qualityRating, 'RED');
  assert.equal(acc.messagingLimit, 'TIER_250');

  const alert = await Notification.findOne({ clinic: clinicId, type: 'whatsapp_quality_changed' });
  assert.ok(alert, 'debe crear la alerta de calidad');
  assert.equal(alert.severity, 'error');
});

test('CAPI: convierte Lead legacy a LeadSubmitted y exige el par CTWA/WABA', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = { enabled: true, datasetId: 'DS123', accessToken: 'capi-token', testEventCode: '' };
  await cfg.save();

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ events_received: 1 }) };
  };
  try {
    const r = await capi.sendConversionEvent({
      eventName: 'Lead',
      eventId: 'lead_conv1',
      user: { phone: '+593 999 000 111', ctwaClid: 'CLID-abc' },
      customData: { chat_funnel_stage: 'nueva_conversacion' },
    });
    assert.equal(r.ok, true);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/DS123/events'), 'postea al dataset configurado');
  const ev = calls[0].body.data[0];
  assert.equal(ev.event_name, 'LeadSubmitted');
  assert.equal(ev.event_id, 'lead_conv1');
  // Formato oficial de CTWA/business messaging (no 'chat'): así Meta atribuye la
  // conversión al anuncio click-to-WhatsApp.
  assert.equal(ev.action_source, 'business_messaging');
  assert.equal(ev.messaging_channel, 'whatsapp');
  const expectedPh = crypto.createHash('sha256').update('593999000111').digest('hex');
  assert.deepEqual(ev.user_data.ph, [expectedPh]);
  assert.equal(ev.user_data.ctwa_clid, 'CLID-abc');
  assert.equal(ev.user_data.whatsapp_business_account_id, 'waba1');
  assert.equal(calls[0].headers.Authorization, 'Bearer capi-token');
  assert.equal(calls[0].url.includes('access_token='), false, 'el token no viaja en la URL');
});

test('CAPI reintenta fallos transitorios sin cambiar el event_id de deduplicación', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = { enabled: true, datasetId: 'DS123', accessToken: 'capi-token' };
  await cfg.save();

  const bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'Meta temporalmente no disponible' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  };
  try {
    const result = await capi.sendConversionEvent({
      eventName: 'LeadSubmitted',
      eventId: 'lead-retry-stable',
      user: { ctwaClid: 'CLID-retry', wabaId: 'waba1' },
    });
    assert.equal(result.ok, true);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].data[0].event_id, 'lead-retry-stable');
  assert.equal(bodies[1].data[0].event_id, 'lead-retry-stable');
});

test('CAPI no envía chats orgánicos sin ctwa_clid ni clics de otra WABA', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = {
    enabled: true,
    datasetId: 'DS123',
    accessToken: 'capi-token',
    whatsappBusinessAccountId: 'waba1',
  };
  await cfg.save();

  let called = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({ events_received: 1 }) }; };
  try {
    const organic = await capi.sendConversionEvent({
      eventName: 'LeadSubmitted',
      eventId: 'organic',
      user: { phone: '593999000111', wabaId: 'waba1' },
    });
    assert.equal(organic.reason, 'missing_ctwa_clid');

    const otherWaba = await capi.sendConversionEvent({
      eventName: 'LeadSubmitted',
      eventId: 'other-waba',
      user: { ctwaClid: 'CLID-other', wabaId: 'waba2' },
    });
    assert.equal(otherWaba.reason, 'waba_mismatch');
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(called, false);
});

test('CAPI valida que el Dataset ID pertenezca a la WABA configurada', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = {
    enabled: true,
    datasetId: '123456789012',
    accessToken: 'capi-token',
    whatsappBusinessAccountId: 'waba1',
  };
  await cfg.save();

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: '123456789012' }] }),
    };
  };
  try {
    const valid = await capi.validateCapiConfiguration();
    assert.equal(valid.ok, true);

    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: '999999999999' }] }),
    });
    const mismatch = await capi.validateCapiConfiguration();
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'dataset_waba_mismatch');
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/waba1/dataset'));
  assert.equal(calls[0].headers.Authorization, 'Bearer capi-token');
});

test('CAPI recupera el ctwa_clid del chat exacto y no lo filtra a otro paciente', async () => {
  const { clinicId } = await seedWhatsapp();
  await postWebhook(messagePayload({
    from: '593999000333',
    id: 'wamid.attr1',
    type: 'text',
    text: { body: 'Vengo del anuncio' },
    referral: { source_id: 'ad_attr', ctwa_clid: 'CLID-paciente-1' },
  }));
  const conversation = await Conversation.findOne({ clinic: clinicId, phone: '593999000333' });
  const patient = await Patient.create({
    clinic: clinicId,
    firstName: 'Ana',
    lastName: 'Atribuida',
    whatsapp: '593999000333',
  });
  const unrelated = await Patient.create({
    clinic: clinicId,
    firstName: 'Otro',
    lastName: 'Paciente',
    whatsapp: '593999000444',
  });
  conversation.patient = patient._id;
  await conversation.save();

  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = {
    enabled: true,
    datasetId: '123456789012',
    accessToken: 'capi-token',
    whatsappBusinessAccountId: 'waba1',
  };
  await cfg.save();

  const attributed = await capi.conversionUserData({ patient });
  assert.equal(attributed.ctwaClid, 'CLID-paciente-1');
  assert.equal(attributed.wabaId, 'waba1');

  const isolated = await capi.conversionUserData({ patient: unrelated });
  assert.equal(isolated.ctwaClid, undefined, 'nunca reutiliza el clic de otro paciente');
  assert.equal(isolated.wabaId, undefined);
});

test('botón Probar CAPI valida credenciales y usa una atribución CTWA real', async () => {
  await seedWhatsapp();
  await postWebhook(messagePayload({
    from: '593999000555',
    id: 'wamid.test-capi',
    type: 'text',
    text: { body: 'Prueba desde anuncio' },
    referral: { source_id: 'ad_test', ctwa_clid: 'CLID-real-test' },
  }));
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = {
    enabled: true,
    datasetId: '123456789012',
    accessToken: 'capi-token',
    testEventCode: 'TEST12345',
    whatsappBusinessAccountId: 'waba1',
  };
  await cfg.save();

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (!opts.method) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: '123456789012' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ events_received: 1, fbtrace_id: 'trace-1' }) };
  };
  try {
    const result = await H.runController(callCenterConfig.testConversionsApi, { body: {} });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.eventsReceived, 1);
    assert.equal(result.payload.fbtraceId, 'trace-1');
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2, 'primero valida Dataset/WABA y luego envía el evento');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body.test_event_code, 'TEST12345');
  assert.equal(calls[1].body.data[0].user_data.ctwa_clid, 'CLID-real-test');
});

test('CAPI deshabilitada: no llama a Meta y devuelve skipped', async () => {
  await seedWhatsapp(); // sin conversionsApi
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  try {
    const r = await capi.sendConversionEvent({ eventName: 'Lead', eventId: 'x', user: { phone: '593999000111' } });
    assert.equal(r.skipped, true);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(called, false);
});

test('el webhook con anuncio reporta LeadSubmitted al crear la conversación', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = { enabled: true, datasetId: 'DS123', accessToken: 'capi-token', testEventCode: '' };
  await cfg.save();

  const capiCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/DS123/events')) capiCalls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ events_received: 1 }) };
  };
  try {
    await postWebhook(messagePayload({
      from: '593999000222',
      id: 'wamid.lead1',
      type: 'text',
      text: { body: 'hola' },
      referral: { source_id: 'ad_9', ctwa_clid: 'CLID-lead' },
    }));
    // reportLead es fire-and-forget: dale un tick para completar.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capiCalls.length, 1, 'debe enviar exactamente un LeadSubmitted');
  const ev = capiCalls[0].data[0];
  assert.equal(ev.event_name, 'LeadSubmitted');
  assert.equal(ev.user_data.ctwa_clid, 'CLID-lead');
  assert.ok(ev.event_id.startsWith('lead_'), 'event_id determinístico por conversación');
});

/**
 * DE PUNTA A PUNTA: un mensaje desde un anuncio deja UNA oportunidad, no dos.
 *
 * La ingesta crea sola una oportunidad EN BLANCO con la atribución del anuncio, y
 * justo detrás la automatización de ESE anuncio creaba OTRA con el nombre: cada
 * chat de anuncio contaba por dos y la gráfica "Qué oportunidades son" enseñaba
 * «Sin nombre» como la barra más alta mientras el chat mostraba la oportunidad
 * con su nombre. La prueba va por el webhook real para cubrir también el paso de
 * la inscripción: el `adId` tiene que viajar en el contexto hasta el paso.
 */
test('anuncio: el chat queda con UNA oportunidad, con nombre y con la atribución', async () => {
  const { clinicId } = await seedWhatsapp();
  const Workflow = require('../models/Workflow');
  await Workflow.create({
    clinic: clinicId,
    name: 'Prostata meta',
    active: true,
    triggers: [{ type: 'ctwa_ad', audience: 'all', adFilter: 'ad_prost' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'ctwa_ad', adFilter: 'ad_prost' }] } },
      {
        id: 'op',
        type: 'create_opportunity',
        position: { x: 0, y: 130 },
        data: { opportunityName: 'Prostata 1', stage: 'nuevo', opportunityValueMode: 'manual', opportunityValue: 29, ifExists: 'new' },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'op', sourceHandle: 'default' }],
  });

  await postWebhook(messagePayload({
    from: '593991398683',
    id: 'wamid.ad1',
    type: 'text',
    text: { body: 'Hola, vi el anuncio' },
    referral: { source_id: 'ad_prost', headline: 'Revisa Tu Próstata A Tiempo', ctwa_clid: 'CLID-p' },
  }));

  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' }).lean();
  assert.equal(conv.opportunities.length, 1, 'una sola oportunidad: el anuncio y el nombre son la misma');
  assert.equal(conv.opportunities[0].name, 'Prostata 1');
  assert.equal(conv.opportunities[0].expectedValue, 29);
  assert.equal(conv.opportunities[0].attribution.adId, 'ad_prost');
  assert.equal(conv.opportunity.name, 'Prostata 1');
});
