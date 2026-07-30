/**
 * Buscador de la lista de chats: el agente escribe el número como lo tenga
 * apuntado (0988535561) y el chat, guardado en E.164 (593988535561), aparece.
 *
 * Antes se buscaba con el texto tal cual, así que el formato local NO encontraba
 * nada y el agente tenía que adivinar cómo escribirlo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const mongoose = require('mongoose');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const clinicId = () => new mongoose.Types.ObjectId();

/** GET /chats?q=... con el controller real. */
async function search(clinic, userId, q) {
  const res = await H.runController(
    chat.listConversations,
    H.mockReq(clinic, userId, {}, { role: 'call_center', query: q === undefined ? {} : { q } })
  );
  assert.equal(res.statusCode, 200);
  return res.payload.map((c) => c.phone);
}

test('el número se encuentra escrito en cualquier formato', async () => {
  const clinic = clinicId();
  const me = new mongoose.Types.ObjectId();
  await Conversation.create({ clinic, phone: '593988535561', contactName: 'María Vera', channel: 'whatsapp' });
  await Conversation.create({ clinic, phone: '593999111222', contactName: 'Otro', channel: 'whatsapp' });
  await Conversation.create({ clinic, phone: '573113380263', contactName: 'Colombia', channel: 'whatsapp' });

  for (const escrito of [
    '0988535561',       // el caso del reclamo: local con 0
    '098 853 5561',     // con espacios
    '098-853-5561',     // con guiones
    '988535561',        // sin 0 ni país
    '593988535561',     // tal cual está guardado
    '+593 98 853 5561', // internacional
    '00593988535561',   // prefijo internacional 00
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const found = await search(clinic, me, escrito);
    assert.deepEqual(found, ['593988535561'], `"${escrito}" debería encontrar SOLO ese chat`);
  }

  // El de Colombia también, con su formato local.
  assert.deepEqual(await search(clinic, me, '311 3380263'), ['573113380263']);
});

test('sigue buscando por nombre y por el último mensaje', async () => {
  const clinic = clinicId();
  const me = new mongoose.Types.ObjectId();
  await Conversation.create({
    clinic, phone: '593988535561', contactName: 'María Vera', channel: 'whatsapp',
    lastMessagePreview: 'Quiero cotizar bioresonancia',
  });
  await Conversation.create({ clinic, phone: '593999111222', contactName: 'Juan Pérez', channel: 'whatsapp' });

  assert.deepEqual(await search(clinic, me, 'maría'), ['593988535561']);       // nombre, sin importar mayúsculas
  assert.deepEqual(await search(clinic, me, 'bioresonancia'), ['593988535561']); // último mensaje
  assert.deepEqual(await search(clinic, me, 'Juan'), ['593999111222']);
  assert.deepEqual(await search(clinic, me, 'zzz'), []);
});

test('un chat de otra sede nunca aparece en la búsqueda', async () => {
  const clinic = clinicId();
  const otra = clinicId();
  const me = new mongoose.Types.ObjectId();
  await Conversation.create({ clinic: otra, phone: '593988535561', channel: 'whatsapp' });

  assert.deepEqual(await search(clinic, me, '0988535561'), []);
});

test('la vista de oportunidades filtra por teléfono en cualquier formato', async () => {
  const clinic = clinicId();
  const me = new mongoose.Types.ObjectId();
  await Conversation.create({
    clinic, phone: '593988535561', contactName: 'María Vera', channel: 'whatsapp',
    opportunities: [{ stage: 'interesado', expectedValue: 120, notes: 'Bioresonancia' }],
  });
  await Conversation.create({
    clinic, phone: '593999111222', contactName: 'Juan Pérez', channel: 'whatsapp',
    opportunities: [{ stage: 'nuevo', expectedValue: 50 }],
  });

  const byPhone = await H.runController(
    chat.listAllOpportunities,
    H.mockReq(clinic, me, {}, { role: 'marketing', query: { patient: '098 853 5561' } })
  );
  assert.equal(byPhone.statusCode, 200);
  assert.deepEqual(byPhone.payload.map((r) => r.phone), ['593988535561']);

  // Y el nombre sigue funcionando igual.
  const byName = await H.runController(
    chat.listAllOpportunities,
    H.mockReq(clinic, me, {}, { role: 'marketing', query: { patient: 'juan' } })
  );
  assert.deepEqual(byName.payload.map((r) => r.phone), ['593999111222']);
});
