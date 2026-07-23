/**
 * Contactos de número OCULTO (@lid) en el gateway QR: se debe mostrar el TELÉFONO
 * real (resuelto vía whatsapp-web.js), no el identificador largo del LID. La
 * identidad estable del chat es el JID @lid → no se duplica el chat ni se pisa el
 * número real cuando una resolución posterior falla.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const LID = '249718173090026@lid';
const LID_DIGITS = '249718173090026';
const REAL = '593984216034';

test('LID resuelto: la conversación muestra el teléfono real, con el JID como identidad', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({
    clinicId, channel: 'whatsapp', externalUserId: LID, phone: REAL,
    body: 'hola', externalId: 'm1', account: null,
  });
  const convs = await Conversation.find({ clinic: clinicId });
  assert.equal(convs.length, 1);
  assert.equal(convs[0].phone, REAL, 'debe mostrar el número real, no el LID');
  assert.equal(convs[0].externalUserId, LID);
});

test('2º mensaje del MISMO @lid sin resolver (phone=LID): mismo chat y NO pisa el número real', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({ clinicId, channel: 'whatsapp', externalUserId: LID, phone: REAL, body: 'hola', externalId: 'm1', account: null });
  // Ahora la resolución falla y el mensaje llega con los dígitos del LID como "phone".
  await chat.ingestExternalMessage({ clinicId, channel: 'whatsapp', externalUserId: LID, phone: LID_DIGITS, body: 'hola2', externalId: 'm2', account: null });
  const convs = await Conversation.find({ clinic: clinicId });
  assert.equal(convs.length, 1, 'no debe duplicar el chat');
  assert.equal(convs[0].phone, REAL, 'no debe sobrescribir el número real con el LID');
});

test('el contacto ya existía por su número real (Cloud): el @lid se fusiona, no duplica', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({ clinicId, channel: 'whatsapp', externalUserId: '', phone: REAL, body: 'por cloud', externalId: 'c1', account: null });
  // Luego escribe por el número QR desde un anuncio, como @lid que resuelve al MISMO real.
  await chat.ingestExternalMessage({ clinicId, channel: 'whatsapp', externalUserId: LID, phone: REAL, body: 'por qr', externalId: 'c2', account: null });
  const convs = await Conversation.find({ clinic: clinicId });
  assert.equal(convs.length, 1, 'debe fusionarse en un solo chat');
  assert.equal(convs[0].phone, REAL);
  assert.equal(convs[0].externalUserId, LID, 'se le fija el JID @lid para poder responder al número oculto');
});

test('control @c.us: un contacto normal se sigue identificando por su teléfono', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({ clinicId, channel: 'whatsapp', externalUserId: '593977001122@c.us', phone: '593977001122', body: 'hola', externalId: 'n1', account: null });
  const convs = await Conversation.find({ clinic: clinicId });
  assert.equal(convs.length, 1);
  assert.equal(convs[0].phone, '593977001122');
});
