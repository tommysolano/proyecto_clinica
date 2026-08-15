/**
 * Nombre del chat.
 *
 * Lo que se ve arriba de una conversación es el nombre del PERFIL de WhatsApp
 * —"Yo…!!!", emojis, apodos—, que casi nunca es el nombre de la persona. Los
 * contactos sí nos dan su nombre, así que hace falta poder guardarlo.
 *
 * Llega por tres vías: escrito a mano en el panel, el del contacto importado y el
 * de un envío masivo. La regla que fija este archivo es una sola y es la que
 * evita el desastre: **lo escrito a mano no lo pisa nadie**.
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

test('N4) el nombre que ya trae el chat gana al automático, aunque no esté sellado', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593979549272', contactName: 'Yo…!!!',
  });

  // Sin sello, pero con nombre: lo automático solo rellena huecos, nunca sustituye.
  assert.equal(messaging.applyContactName(conv, 'Otro Nombre'), false);
  assert.equal(conv.contactName, 'Yo…!!!');
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
