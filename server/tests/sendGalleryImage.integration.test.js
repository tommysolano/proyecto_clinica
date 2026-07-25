/**
 * Enviar una imagen de la galería debe SALIR de verdad por el proveedor de
 * WhatsApp. BUG corregido: la ruta /:id/send-image solo creaba el mensaje en la BD
 * (deliveryStatus por defecto 'sent') y NUNCA contactaba a WhatsApp — la imagen se
 * veía "enviada" pero jamás le llegaba al contacto. Ahora pasa por messaging.send:
 * si el proveedor la acepta, la media va por URL pública (Cloud la sube por id);
 * si la rechaza, el mensaje queda FALLIDO con su motivo.
 *
 * La entrega ocurre en SEGUNDO PLANO desde jul-2026 (ver `messaging.send` con
 * `background`): la respuesta HTTP es 201 'queued' en cuanto el mensaje está
 * guardado, y el resultado real se escribe poco después — por eso los tests
 * esperan con `H.waitForStatus`. Lo que NO cambia es la garantía: nunca se
 * responde 'sent' antes de que el proveedor conteste, así que sigue sin existir
 * el "dice enviado y nunca llega".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const gateway = require('../utils/whatsappGateway');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed(clinicId) {
  await WhatsappAccount.create({ label: 'Cloud', connectionType: 'cloud_api', accessToken: 'T', phoneNumberId: '1', enabled: true, isDefault: true });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593987654321', contactName: 'Emily', channel: 'whatsapp',
    lastMessageAt: new Date(), lastMessageDirection: 'in',
    window24hExpiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
  });
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'captura.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png',
  });
  return { conv, img };
}

test('send-image SALE por el proveedor con la media por URL pública (no crea "enviado" en falso)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { conv, img } = await seed(clinicId);

  const calls = [];
  const orig = gateway.sendMedia;
  gateway.sendMedia = async (...args) => { calls.push(args); return { ok: true, data: { messages: [{ id: 'wamid.GAL1' }] } }; };
  try {
    const req = H.mockReq(clinicId, userId, { imageId: String(img._id), caption: 'mira esto' }, { params: { id: String(conv._id) } });
    req.user.name = 'Agente';
    const out = await H.runController(chat.sendGalleryImage, req);

    assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
    assert.equal(calls.length, 1, 'se llamó al proveedor UNA vez');
    const [, to, url, caption, type] = calls[0];
    assert.equal(to, '593987654321');
    assert.match(String(url), /\/api\/public\/media\/[a-f0-9]{24}/, 'la media va por URL pública (Cloud la sube por id), NO como dataUrl');
    assert.equal(caption, 'mira esto');
    assert.equal(type, 'image');

    const saved = await H.waitForStatus(out.payload._id, 'sent');
    assert.equal(saved.deliveryStatus, 'sent', 'quedó enviado SOLO porque el proveedor lo aceptó');
    assert.equal(saved.externalId, 'wamid.GAL1');
    assert.notEqual(saved.body, `[imagen: ${img.name}]`, 'ya no se manda el placeholder de texto');
  } finally {
    gateway.sendMedia = orig;
  }
});

test('send-image: si el proveedor RECHAZA, el mensaje acaba FALLIDO y nunca se muestra como "enviado"', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { conv, img } = await seed(clinicId);

  const orig = gateway.sendMedia;
  gateway.sendMedia = async () => ({ ok: false, errorCode: 'media_upload_failed', error: 'Media file size too big.' });
  try {
    const req = H.mockReq(clinicId, userId, { imageId: String(img._id) }, { params: { id: String(conv._id) } });
    const out = await H.runController(chat.sendGalleryImage, req);

    // La entrega ocurre en segundo plano (la petición ya no espera al proveedor),
    // así que la respuesta es "aceptado", NO "enviado": el estado que viaja es
    // 'queued' y el chat pinta "enviando…", nunca un ✓.
    assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
    assert.equal(out.payload.deliveryStatus, 'queued', 'jamás responder "sent" antes de que el proveedor conteste');

    // Y cuando el proveedor lo rechaza, el mensaje queda FALLIDO con su motivo:
    // sigue sin existir el "dice enviado y nunca llega".
    const saved = await H.waitForStatus(out.payload._id, 'failed');
    assert.equal(saved.deliveryStatus, 'failed', 'el mensaje queda FALLIDO, no "enviado"');
    assert.match(saved.errorMessage, /too big/i, 'guarda el motivo real para mostrarlo en la burbuja');
  } finally {
    gateway.sendMedia = orig;
  }
});
