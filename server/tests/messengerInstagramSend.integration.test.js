/**
 * Envío real de adjuntos por Messenger/Instagram (antes solo mandaban texto,
 * cualquier imagen/video/audio/documento se descartaba en silencio). El Send
 * API de Meta no admite texto+adjunto en una sola llamada (a diferencia de
 * WhatsApp): con ambos, se manda el adjunto primero y el texto como una
 * segunda llamada. Se mockea `fetch` global — no se llama a Meta de verdad.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const CallCenterConfig = require('../models/CallCenterConfig');
const MessageTemplate = require('../models/MessageTemplate');
const Patient = require('../models/Patient');
const { encryptSecret } = require('../utils/secretCrypto');
const messaging = require('../utils/messaging');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedChannel(clinicId, channel) {
  await CallCenterConfig.create({
    clinic: clinicId,
    [channel]: { enabled: true, pageId: 'PAGE1', pageAccessToken: encryptSecret('PAGE_TOKEN_123'), verifyToken: 'v', appSecret: 's' },
  });
  return Conversation.create({
    clinic: clinicId,
    phone: '1000200030004000',
    externalUserId: '1000200030004000',
    channel,
  });
}

function installFetchMock(responder) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return responder(body, calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('Messenger: adjunto + texto se mandan como DOS llamadas (Meta no admite ambos en una)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedChannel(clinicId, 'messenger');
  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_1' }) }));
  try {
    const r = await messaging.send({
      clinicId, channel: 'messenger', conversation: conv, to: conv.phone,
      body: 'Aquí tienes la foto', mediaUrl: 'https://example.com/public/media/abc.jpg', mediaType: 'image',
      sentBy: null, background: false,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(mock.calls.length, 2, 'debe hacer 2 llamadas a Meta (adjunto + texto)');
    assert.deepEqual(mock.calls[0].body.message.attachment, {
      type: 'image',
      payload: { url: 'https://example.com/public/media/abc.jpg' },
    });
    assert.equal(mock.calls[0].body.messaging_type, 'RESPONSE');
    assert.equal(mock.calls[1].body.message.text, 'Aquí tienes la foto');
  } finally {
    mock.restore();
  }
});

test('Instagram: solo adjunto (sin texto) manda UNA sola llamada con attachment', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedChannel(clinicId, 'instagram');
  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'IGSID', message_id: 'mid_2' }) }));
  try {
    const r = await messaging.send({
      clinicId, channel: 'instagram', conversation: conv, to: conv.phone,
      body: '', mediaUrl: 'https://example.com/public/media/nota.ogg', mediaType: 'audio',
      background: false,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].body.message.attachment.type, 'audio');
    // Instagram no manda messaging_type (a diferencia de Messenger).
    assert.equal(mock.calls[0].body.messaging_type, undefined);
  } finally {
    mock.restore();
  }
});

test('documento (PDF) se mapea al tipo "file" que espera el Send API de Meta', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedChannel(clinicId, 'messenger');
  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_3' }) }));
  try {
    await messaging.send({
      clinicId, channel: 'messenger', conversation: conv, to: conv.phone,
      body: '', mediaUrl: 'https://example.com/public/media/ficha.pdf', mediaType: 'document',
      background: false,
    });
    assert.equal(mock.calls[0].body.message.attachment.type, 'file');
  } finally {
    mock.restore();
  }
});

test('si Meta rechaza el adjunto, el mensaje queda FALLIDO y NO se intenta mandar el texto', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedChannel(clinicId, 'messenger');
  const mock = installFetchMock(async (body) => {
    if (body.message?.attachment) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported attachment type' } }) };
    }
    return { ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_4' }) };
  });
  try {
    const r = await messaging.send({
      clinicId, channel: 'messenger', conversation: conv, to: conv.phone,
      body: 'texto que no debe salir', mediaUrl: 'https://example.com/public/media/x.bin', mediaType: 'document',
      background: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.message.deliveryStatus, 'failed');
    assert.match(r.message.errorMessage, /Unsupported attachment type/);
    assert.equal(mock.calls.length, 1, 'no debe llamar una segunda vez a mandar el texto');
  } finally {
    mock.restore();
  }
});

test('canal no configurado (sin token) falla claro, sin llamar a Meta', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, phone: '1', externalUserId: '1', channel: 'messenger' });
  const mock = installFetchMock(async () => { throw new Error('no debería llamarse'); });
  try {
    const r = await messaging.send({
      clinicId, channel: 'messenger', conversation: conv, to: conv.phone,
      body: 'hola', background: false,
    });
    assert.equal(r.ok, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('Messenger: "plantilla" con cabecera de imagen manda el adjunto y luego el texto con la variable resuelta (Meta no tiene HSM fuera de WhatsApp)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedChannel(clinicId, 'messenger');
  await MessageTemplate.create({
    clinic: clinicId,
    channel: 'whatsapp',
    name: 'recordatorio',
    status: 'approved',
    headerType: 'image',
    headerMediaUrl: 'https://example.com/public/media/header.jpg',
    body: 'Hola {{nombre}}, este es tu recordatorio.',
  });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Marta', lastName: 'Ruiz', phone: '0990000000' });

  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_t1' }) }));
  try {
    const r = await messaging.send({
      clinicId, channel: 'messenger', conversation: conv, to: conv.phone, patient,
      template: { name: 'recordatorio', language: 'es' },
      background: false,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(mock.calls.length, 2, 'debe mandar la cabecera (adjunto) y el texto en dos llamadas');
    assert.deepEqual(mock.calls[0].body.message.attachment, {
      type: 'image',
      payload: { url: 'https://example.com/public/media/header.jpg' },
    });
    // Patient.firstName se normaliza a MAYÚSCULAS en el modelo (setter propio).
    assert.equal(mock.calls[1].body.message.text, 'Hola MARTA, este es tu recordatorio.');
  } finally {
    mock.restore();
  }
});
