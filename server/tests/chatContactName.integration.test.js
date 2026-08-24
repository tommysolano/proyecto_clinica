/**
 * Nombre del chat.
 *
 * Lo que se ve arriba de una conversación es el nombre del PERFIL de WhatsApp
 * —"Yo…!!!", emojis, apodos—, que casi nunca es el nombre de la persona. Los
 * contactos sí nos dan su nombre, así que hace falta poder guardarlo.
 *
 * Llega por cuatro vías, y este archivo fija en qué orden mandan:
 *
 *   manual (panel)  >  ficha del CRM / Excel  >  lo que el contacto escribió
 *                                                en el chat  >  perfil de WhatsApp
 *
 * Las dos reglas que evitan el desastre: **lo escrito a mano no lo pisa nadie**,
 * y **el apodo del perfil no bloquea al nombre real** (hasta ago-2026 sí lo
 * hacía: lo automático solo rellenaba huecos, así que un chat nacido como
 * "Yo…!!!" se quedaba así por muchos Excel que se importaran).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const messaging = require('../utils/messaging');
const chat = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const renombrar = (clinicId, userId, convId, contactName) =>
  H.runController(
    chat.updateConversation,
    H.mockReq(clinicId, userId, { contactName }, { role: 'call_center', params: { id: String(convId) } })
  );

// ─────────────────────────────────────────────────────────────────────────────

test('N1) renombrar desde el panel guarda el nombre y lo deja sellado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272', contactName: 'Yo…!!!',
  });

  const r = await renombrar(clinicId, userId, conv._id, 'Reina Solórzano');
  assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.payload));

  const saved = await Conversation.findById(conv._id);
  assert.equal(saved.contactName, 'Reina Solórzano');
  assert.ok(saved.contactNameEditedAt, 'queda el sello de que lo escribió una persona');
});

test('N2) el nombre escrito a mano NO lo pisa el del contacto importado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272', contactName: 'Yo…!!!',
  });
  await renombrar(clinicId, userId, conv._id, 'Reina Solórzano');

  const fresco = await Conversation.findById(conv._id);
  const tocado = messaging.applyContactName(fresco, 'REINA S. (excel)');

  assert.equal(tocado, false, 'no toca el documento');
  assert.equal(fresco.contactName, 'Reina Solórzano');
});

test('N3) un chat SIN nombre sí adopta el del contacto (import / envío masivo)', async () => {
  const { clinicId } = await H.seedClinic();
  // Messenger e Instagram nacen sin nombre: ahí esto es lo único que hay.
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'messenger', phone: '593979549272', contactName: '',
  });

  assert.equal(messaging.applyContactName(conv, 'Reina Solórzano'), true);
  assert.equal(conv.contactName, 'Reina Solórzano');
  // Y no se marca como editado a mano: sigue siendo automático y otro import
  // posterior podría no ser lo que manda, pero un humano siempre puede corregirlo.
  assert.equal(conv.contactNameEditedAt, null);
});

test('N4) el nombre del CRM SUSTITUYE al apodo del perfil de WhatsApp', async () => {
  const { clinicId } = await H.seedClinic();
  // Así nacen los chats: con el nombre del PERFIL de WhatsApp, que casi nunca es
  // el de la persona. Antes ese apodo se quedaba para siempre —lo automático solo
  // rellenaba huecos— y el Excel con el nombre real no llegaba nunca a la bandeja.
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272',
    contactName: 'Yo…!!!', contactNameSource: 'profile',
  });

  assert.equal(messaging.applyContactName(conv, 'Reina Solórzano', { source: 'contact' }), true);
  assert.equal(conv.contactName, 'Reina Solórzano');
  assert.equal(conv.contactNameSource, 'contact');
  // Y sigue sin ser "escrito a mano": una persona puede corregirlo después.
  assert.equal(conv.contactNameEditedAt, null);
});

test('N4b) chats antiguos (sin campo de origen) también dejan pasar el nombre del CRM', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272', contactName: '🌸Mi vida🌸',
  });

  // `contactNameSource` vacío = lo que hay viene del perfil de WhatsApp.
  assert.equal(messaging.applyContactName(conv, 'Ana Pérez', { source: 'contact' }), true);
  assert.equal(conv.contactName, 'Ana Pérez');
});

test('N4c) el nombre del Excel gana al que el contacto escribió en el chat, no al revés', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272',
    contactName: 'Yo…!!!', contactNameSource: 'profile',
  });

  // Lo que dijo el contacto pisa su propio apodo…
  assert.equal(messaging.applyContactName(conv, 'Ana Perez', { source: 'chat' }), true);
  // …y la ficha del CRM (Excel importado) pisa a lo que dijo el contacto.
  assert.equal(messaging.applyContactName(conv, 'Ana Lucía Pérez Mora', { source: 'contact' }), true);
  assert.equal(conv.contactName, 'Ana Lucía Pérez Mora');
  // Pero no al revés: un mensaje suelto no deshace el dato con el que trabaja la clínica.
  assert.equal(messaging.applyContactName(conv, 'Anita', { source: 'chat' }), false);
  assert.equal(conv.contactName, 'Ana Lucía Pérez Mora');
});

test('N5) un nombre vacío o en blanco no borra lo que hay', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '1', contactName: '' });

  assert.equal(messaging.applyContactName(conv, '   '), false);
  assert.equal(messaging.applyContactName(conv, null), false);
  assert.equal(conv.contactName, '');
});

test('N6) el nombre viaja en la bandeja y se puede buscar por él', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272', contactName: 'Yo…!!!',
  });
  await renombrar(clinicId, userId, conv._id, 'Reina Solórzano');

  const lista = await H.runController(
    chat.listConversations,
    H.mockReq(clinicId, userId, {}, { role: 'admin', query: { q: 'Reina' } })
  );
  const items = lista.payload.items || lista.payload;
  assert.equal(items.length, 1, 'el buscador de la bandeja encuentra por el nombre real');
  assert.equal(items[0].contactName, 'Reina Solórzano');
});

test('N7) un envío masivo con la conversación YA cargada también renombra el chat', async () => {
  // ESTE ERA EL AGUJERO. Las automatizaciones y las campañas no buscan el chat por
  // teléfono: se lo pasan a `messaging.send` ya cargado. Por ese camino el nombre
  // de la ficha no se aplicaba nunca, así que el Excel se importaba y en la
  // bandeja seguía el apodo del perfil de WhatsApp.
  const { clinicId } = await H.seedClinic();
  const WhatsappAccount = require('../models/WhatsappAccount');
  const gw = require('../utils/whatsappGateway');
  const orig = gw.sendText;
  gw.sendText = async () => ({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  try {
    await WhatsappAccount.create({
      label: 'Recepcion', connectionType: 'qr', enabled: true, isDefault: true, connectedPhone: '593999000111',
    });
    const conv = await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: '593979549272',
      contactName: 'Yo…!!!', contactNameSource: 'profile',
      lastInboundAt: new Date(),
    });

    const r = await messaging.send({
      clinicId,
      channel: 'whatsapp',
      conversation: conv,
      to: '593979549272',
      contactName: 'Reina Solórzano',
      body: 'Te recordamos tu cita de mañana.',
      isAutoReply: true,
    });
    assert.ok(r.ok, JSON.stringify(r));

    const fresco = await Conversation.findById(conv._id);
    assert.equal(fresco.contactName, 'Reina Solórzano');
    assert.equal(fresco.contactNameSource, 'contact');
  } finally {
    gw.sendText = orig;
  }
});
