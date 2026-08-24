/**
 * Cuatro quejas del call center, agosto de 2026, con su prueba.
 *
 *  1. OPORTUNIDADES FANTASMA. Abrir un chat desde un anuncio creaba sola una
 *     oportunidad EN BLANCO. Como casi ninguna se rellenaba después, el embudo
 *     acabó lleno de «Sin nombre» y las estadísticas no valían nada. Una
 *     oportunidad nace SOLO desde una automatización o a mano.
 *  2. LA BANDEJA TARDABA EN ABRIR. Se pedían los 300 chats de golpe y no se
 *     pintaba ninguno hasta que llegaban todos. Ahora entra de 25 en 25 — y los
 *     contadores de las pestañas siguen siendo los REALES.
 *  3. EL RECORDATORIO SE VEÍA DOS VECES. Un mensaje con botones enviado por un
 *     número QR viaja con unas líneas de respaldo al final ("1. Responde: …"),
 *     así que su eco no casaba con el mensaje guardado y se archivaba como si lo
 *     hubiera escrito alguien desde el móvil: dos burbujas, la segunda firmada
 *     "WhatsApp (teléfono)".
 *  4. EL CHAT NO SE LLAMABA COMO LA PERSONA. Si el contacto escribe su nombre,
 *     el chat pasa a llamarse así (sin pisar lo escrito a mano).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { clearCache } = require('../utils/callCenterClinic');

const APP_SECRET = 'test-app-secret';

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); clearCache(); });

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

async function postWebhook(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  const req = { body, rawBody, headers: { 'x-hub-signature-256': signature }, params: {}, query: {} };
  return H.runController(chat.webhookWhatsappReceive, req);
}

const messagePayload = (msg, { contacts } = {}) => ({
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: '111222333' },
        contacts: contacts || [{ profile: { name: 'Yo…!!!' } }],
        messages: [msg],
      },
    }],
  }],
});

// ─────────── 1. abrir un chat no crea una oportunidad ───────────

test('un chat que llega desde un anuncio NO deja una oportunidad en blanco', async () => {
  const { clinicId } = await seedWhatsapp();

  await postWebhook(messagePayload({
    from: '593991398683',
    id: 'wamid.ad-sin-flujo',
    type: 'text',
    text: { body: 'Hola, vi el anuncio' },
    referral: { source_id: 'ad_777', headline: 'Revisa Tu Próstata A Tiempo', ctwa_clid: 'CLID-x' },
  }));

  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' }).lean();
  assert.equal(conv.opportunities.length, 0, 'sin automatización que diga qué es, no hay oportunidad');
  assert.equal(conv.opportunity?.isOpportunity ?? false, false);
  // La atribución SÍ se guarda: es lo que responde "de qué anuncio vino este chat".
  assert.equal(conv.attribution.adId, 'ad_777');
});

test('el alta manual de una oportunidad se queda con el anuncio del chat', async () => {
  const { clinicId } = await seedWhatsapp();
  const userId = new H.mongoose.Types.ObjectId();
  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.ad2', type: 'text', text: { body: 'info' },
    referral: { source_id: 'ad_555', headline: 'Blanqueamiento', ctwa_clid: 'CLID-y' },
  }));
  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' });

  const r = await H.runController(
    chat.addOpportunity,
    H.mockReq(clinicId, userId, { name: 'Blanqueamiento dental', stage: 'nuevo' },
      { role: 'call_center', params: { id: String(conv._id) } })
  );
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));

  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.opportunities.length, 1);
  assert.equal(fresh.opportunities[0].name, 'Blanqueamiento dental');
  assert.equal(fresh.opportunities[0].attribution.adId, 'ad_555', 'la analítica sigue sabiendo de qué anuncio vino');
});

// ─────────── 2. la bandeja entra por páginas, los contadores no ───────────

test('la bandeja devuelve 25 chats por página y el total REAL', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const base = Date.now();
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: `59399900${String(i).padStart(4, '0')}`,
      contactName: `Contacto ${i}`, lastMessageAt: new Date(base - i * 1000),
    });
  }

  const p1 = await H.runController(
    chat.listConversations, H.mockReq(clinicId, userId, {}, { role: 'admin', query: {} })
  );
  assert.equal(p1.payload.items.length, 25, 'de entrada, una página');
  assert.equal(p1.payload.total, 40, 'pero dice cuántos hay de verdad');
  assert.equal(p1.payload.hasMore, true);

  const p2 = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, userId, {}, { role: 'admin', query: { skip: 25, limit: 25 } })
  );
  assert.equal(p2.payload.items.length, 15);
  assert.equal(p2.payload.hasMore, false);
  // Sin solapamiento: las dos páginas son 40 chats distintos.
  const ids = new Set([...p1.payload.items, ...p2.payload.items].map((c) => String(c._id)));
  assert.equal(ids.size, 40);
});

test('los contadores de las pestañas cuentan en la BASE, no lo cargado', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: `59399911${String(i).padStart(4, '0')}`,
      unreadCount: i < 28 ? 3 : 0,
      isFeatured: i < 2,
    });
  }

  const r = await H.runController(
    chat.unreadCounts, H.mockReq(clinicId, userId, {}, { role: 'admin' })
  );
  assert.equal(r.payload.all, 28, 'no leídos reales, aunque la lista solo haya traído 25');
  assert.equal(r.payload.featured, 2);
  // "Todos" excluye destacados, igual que el listado.
  assert.equal(r.payload.total, 28);
});

// ─────────── 3. el eco del número QR no duplica el recordatorio ───────────

test('el eco de un mensaje CON BOTONES no se guarda como "WhatsApp (teléfono)"', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const account = await WhatsappAccount.create({
    label: 'QR', connectionType: 'qr', connectedPhone: '593999888777',
  });
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593991398683', contactName: 'Ana',
  });
  const cuerpo = 'Hola Ana, te recordamos tu cita del martes a las 09:00.';
  // Lo que el CRM guarda: el texto limpio, con los botones aparte.
  await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'out',
    body: cuerpo,
    buttons: [{ id: 'b1', type: 'quick_reply', text: 'Confirmar' }],
    deliveryStatus: 'sent',
  });

  // Lo que WhatsApp Web devuelve por `message_create`: el mismo texto MÁS las
  // líneas de respaldo de los botones (un número QR no admite botones).
  await chat.ingestExternalOutbound({
    clinicId,
    account,
    externalUserId: '593991398683@c.us',
    phone: '593991398683',
    body: `${cuerpo}\n\n1. Responde: Confirmar`,
    externalId: 'wamid.eco-1',
  });

  const salientes = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(salientes.length, 1, 'una sola burbuja: el eco es nuestro propio envío');
  assert.notEqual(salientes[0].sentByName, 'WhatsApp (teléfono)');
  assert.equal(salientes[0].externalId, 'wamid.eco-1', 'y de paso se le guarda el wamid');
});

test('un mensaje escrito de verdad desde el móvil SÍ entra en el chat', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const account = await WhatsappAccount.create({
    label: 'QR', connectionType: 'qr', connectedPhone: '593999888777',
  });
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593991398683', contactName: 'Ana',
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out',
    body: 'Hola Ana, te recordamos tu cita del martes a las 09:00.',
    buttons: [{ id: 'b1', type: 'quick_reply', text: 'Confirmar' }],
    deliveryStatus: 'sent',
  });

  await chat.ingestExternalOutbound({
    clinicId,
    account,
    externalUserId: '593991398683@c.us',
    phone: '593991398683',
    body: 'Ah y trae tus exámenes anteriores porfa',
    externalId: 'wamid.movil-1',
  });

  const salientes = await Message.find({ conversation: conv._id, direction: 'out' }).sort({ createdAt: 1 }).lean();
  assert.equal(salientes.length, 2);
  assert.equal(salientes[1].sentByName, 'WhatsApp (teléfono)');
});

// ─────────── 4. el chat se llama como la persona ───────────

test('si el contacto dice su nombre, el chat deja de llamarse como su perfil', async () => {
  const { clinicId } = await seedWhatsapp();

  // Nace con el apodo del perfil de WhatsApp.
  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.n1', type: 'text', text: { body: 'Hola, buenas' },
  }));
  let conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' }).lean();
  assert.equal(conv.contactName, 'Yo…!!!');

  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.n2', type: 'text', text: { body: 'me llamo Reina Solórzano' },
  }));
  conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' }).lean();
  assert.equal(conv.contactName, 'Reina Solórzano');
  assert.equal(conv.contactNameSource, 'chat');
  assert.equal(conv.contactNameEditedAt, null, 'sigue siendo automático: una persona puede corregirlo');
});

test('lo escrito a mano no lo pisa lo que el contacto escriba después', async () => {
  const { clinicId } = await seedWhatsapp();
  const userId = new H.mongoose.Types.ObjectId();
  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.n3', type: 'text', text: { body: 'Hola' },
  }));
  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' });
  await H.runController(
    chat.updateConversation,
    H.mockReq(clinicId, userId, { contactName: 'Reina S. (mamá de Ana)' },
      { role: 'call_center', params: { id: String(conv._id) } })
  );

  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.n4', type: 'text', text: { body: 'mi nombre es Reina Solorzano' },
  }));
  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(fresh.contactName, 'Reina S. (mamá de Ana)');
});

test('un mensaje normal no renombra el chat', async () => {
  const { clinicId } = await seedWhatsapp();
  await postWebhook(messagePayload({
    from: '593991398683', id: 'wamid.n5', type: 'text', text: { body: 'Soy de Portoviejo, ¿atienden allá?' },
  }));
  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593991398683' }).lean();
  assert.equal(conv.contactName, 'Yo…!!!', 'ante la duda, no se toca');
});
