/**
 * ¿Por qué número sale un envío masivo?
 *
 * La regla del negocio: al contacto se le escribe por el número al que ÉL nos
 * escribió la última vez. Si nos habló al WhatsApp del QR, se le contesta por el
 * QR — no por el de la API, que es lo que estaba pasando. Y si nunca nos ha
 * escrito, sale por el número marcado como principal.
 *
 * Sobre eso, el usuario puede FIJAR un número para toda la campaña. Ese es el
 * único caso en el que se ignora el historial del contacto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Anota por qué cuenta salió cada mensaje, sin mandar nada de verdad. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate };
  gw.sendText = async (account, to, body) => {
    sent.push({ cuenta: account.label, tipo: account.connectionType, to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, templateName) => {
    sent.push({ cuenta: account.label, tipo: account.connectionType, to, templateName });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

/** Los dos números conectados: el de la API es el principal. */
async function dosNumeros() {
  const api = await WhatsappAccount.create({
    label: 'API Shiluv', connectionType: 'cloud_api', enabled: true, isDefault: true,
    phoneNumberId: '111', accessToken: 'tok',
  });
  const qr = await WhatsappAccount.create({
    label: 'QR Recepción', connectionType: 'qr', enabled: true, status: 'connected',
  });
  return { api, qr };
}

test('el contacto escribió por el QR: se le responde por el QR, no por el número de la API', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const { qr } = await dosNumeros();
    // Conversación SIN número enlazado: se resuelve por el último mensaje entrante.
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
    await Message.create({
      clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola, quiero información',
      whatsappAccount: qr._id,
    });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999111222', body: 'Promo de julio',
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent.length, 1);
    assert.equal(gw.sent[0].cuenta, 'QR Recepción', 'se responde por donde el contacto escribió');
  } finally {
    gw.restore();
  }
});

test('contacto que nunca nos escribió: sale por el número marcado como principal', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await dosNumeros(); // el principal es el de la API
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999333444' });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999333444',
      template: { name: 'promo_julio', language: 'es' },
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent[0].cuenta, 'API Shiluv');
  } finally {
    gw.restore();
  }
});

test('número FIJADO: manda ese, aunque el contacto nos hubiera escrito a otro', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const { api, qr } = await dosNumeros();
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
    await Message.create({
      clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola', whatsappAccount: qr._id,
    });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999111222', body: 'Promo',
      whatsappAccount: api._id,
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent[0].cuenta, 'API Shiluv', 'lo que el usuario fija manda sobre el historial');
  } finally {
    gw.restore();
  }
});

test('número fijado que ya está DESACTIVADO: no se pierde el envío, cae al del contacto', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const { qr } = await dosNumeros();
    const viejo = await WhatsappAccount.create({
      label: 'Número dado de baja', connectionType: 'qr', enabled: false,
    });
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
    await Message.create({
      clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola', whatsappAccount: qr._id,
    });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999111222', body: 'Promo',
      whatsappAccount: viejo._id,
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent[0].cuenta, 'QR Recepción');
  } finally {
    gw.restore();
  }
});

test('por QR, una plantilla se manda como texto normal (Meta no la cobra)', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    const { qr } = await dosNumeros();
    const MessageTemplate = require('../models/MessageTemplate');
    await MessageTemplate.create({
      clinic: clinicId, channel: 'whatsapp', name: 'promo_julio', language: 'es',
      status: 'approved', body: 'Hola {{nombre}}, tenemos promo en julio',
      variables: [{ key: 'nombre', example: 'María' }],
    });
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
    await Message.create({
      clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola', whatsappAccount: qr._id,
    });

    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999111222',
      template: { name: 'promo_julio', language: 'es' },
    });

    assert.equal(r.ok, true, r.reason || r.errorMessage);
    assert.equal(gw.sent[0].cuenta, 'QR Recepción');
    assert.equal(gw.sent[0].templateName, undefined, 'el QR no manda plantillas de Meta');
    assert.match(gw.sent[0].body, /promo en julio/, 'sino el texto ya renderizado');
  } finally {
    gw.restore();
  }
});
