/**
 * Enviar una imagen de la galería debe SALIR de verdad por el proveedor de
 * WhatsApp. BUG corregido: la ruta /:id/send-image solo creaba el mensaje en la BD
 * (deliveryStatus por defecto 'sent') y NUNCA contactaba a WhatsApp — la imagen se
 * veía "enviada" pero jamás le llegaba al contacto. Ahora pasa por messaging.send:
 * si el proveedor la acepta → 201 con la media por URL pública (Cloud la sube por
 * id); si la rechaza → 502 FALLIDO, nunca un "enviado" falso.
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

    const saved = await Message.findById(out.payload._id).lean();
    assert.equal(saved.deliveryStatus, 'sent', 'quedó enviado SOLO porque el proveedor lo aceptó');
    assert.equal(saved.externalId, 'wamid.GAL1');
    assert.notEqual(saved.body, `[imagen: ${img.name}]`, 'ya no se manda el placeholder de texto');
  } finally {
    gateway.sendMedia = orig;
  }
});

test('send-image: si el proveedor RECHAZA → 502 FALLIDO, nunca 201 "enviado"', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { conv, img } = await seed(clinicId);

  const orig = gateway.sendMedia;
  gateway.sendMedia = async () => ({ ok: false, errorCode: 'media_upload_failed', error: 'Media file size too big.' });
  try {
    const req = H.mockReq(clinicId, userId, { imageId: String(img._id) }, { params: { id: String(conv._id) } });
    const out = await H.runController(chat.sendGalleryImage, req);

    assert.equal(out.statusCode, 502, JSON.stringify(out.payload));
    assert.match(out.payload.message, /too big/i, 'muestra el motivo real');
    const saved = await Message.findById(out.payload.chatMessage._id).lean();
    assert.equal(saved.deliveryStatus, 'failed', 'el mensaje queda FALLIDO, no "enviado"');
  } finally {
    gateway.sendMedia = orig;
  }
});
