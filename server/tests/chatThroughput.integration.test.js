/**
 * Fluidez del chat del call center. Cubre los tres fallos que el 25-jul-2026
 * tenían al equipo sin poder trabajar:
 *
 *  1. Abrir un chat con un video tardaba o fallaba ("Error al cargar mensajes"),
 *     porque el hilo devolvía los adjuntos en base64 dentro del JSON. Una
 *     conversación de 16 mensajes pesaba 6.8 MB.
 *  2. Enviar un video repetía el mensaje: WhatsApp anunciaba nuestro propio envío
 *     ~72 s después y el de-dup solo miraba 40 s hacia atrás.
 *  3. El agente pulsaba "Enviar" varias veces mientras esperaba y el paciente
 *     recibía el mismo video 3 veces (pasó a las 19:06, 19:07 y 19:08).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');
const gateway = require('../utils/whatsappGateway');

const PHONE = '593987654321';

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedConv(clinicId) {
  await WhatsappAccount.create({
    label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected',
  });
  return Conversation.create({
    clinic: clinicId, phone: PHONE, contactName: 'Nefer', channel: 'whatsapp',
    lastMessageAt: new Date(), lastMessageDirection: 'in',
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
  });
}

// ───────────────────── 1. el hilo nunca viaja con los bytes ─────────────────

test('el hilo NUNCA devuelve adjuntos en base64 (era lo que hacía fallar la carga)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  // Mensaje anterior a la migración: el adjunto sigue dentro del documento.
  const heavy = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', mediaType: 'video',
    mediaUrl: `data:video/mp4;base64,${'A'.repeat(5000)}`,
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', body: 'hola',
  });

  const r = await H.runController(
    chat.listMessages,
    H.mockReq(clinicId, userId, {}, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 200);

  const serialized = JSON.stringify(r.payload);
  assert.ok(!serialized.includes('data:video'), 'el base64 NO puede viajar en el hilo');
  assert.ok(serialized.length < 2000, `el hilo debe ser ligero, pesó ${serialized.length} bytes`);

  // El adjunto sigue siendo accesible: se sirve por su propia URL, aparte.
  const withMedia = r.payload.find((m) => String(m._id) === String(heavy._id));
  assert.equal(withMedia.mediaUrl, `/api/public/message-media/${heavy._id}`);
});

test('el hilo devuelve los mensajes MÁS RECIENTES, no los más viejos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  // Más mensajes que el tope de la página.
  const base = Date.now() - 200 * 60000;
  await Message.insertMany(
    Array.from({ length: 120 }, (_, i) => ({
      clinic: clinicId, conversation: conv._id, direction: 'in',
      body: `msg-${i}`, createdAt: new Date(base + i * 60000),
    }))
  );

  const r = await H.runController(
    chat.listMessages,
    H.mockReq(clinicId, userId, {}, { params: { id: String(conv._id) }, query: { limit: '50' } })
  );
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.length, 50);
  // Cortar por el principio dejaba al agente viendo un chat congelado en el pasado.
  assert.equal(r.payload.at(-1).body, 'msg-119', 'el último de la lista es el más nuevo');
  assert.equal(r.payload[0].body, 'msg-70', 'la página son los 50 últimos, en orden ascendente');
});

// ───────────────────── 2. el eco del teléfono no duplica ────────────────────

test('el eco de WhatsApp de un envío LENTO no duplica el mensaje', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  // Nuestro envío, creado hace 72 s y TODAVÍA en vuelo (el video sigue subiendo).
  // Los 72 s son el tiempo real medido en producción, y son justo lo que hacía
  // fallar al de-dup anterior: solo miraba 40 s hacia atrás.
  const mine = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out',
    body: 'Por favor revise el video para saber cómo llegar',
    mediaType: 'video', mediaUrl: '/api/public/media/aaaaaaaaaaaaaaaaaaaaaaaa',
    deliveryStatus: 'queued', sentByName: 'Emily',
  });
  // Por la colección cruda: mongoose ignora `createdAt` en un $set (timestamps).
  await Message.collection.updateOne(
    { _id: mine._id },
    { $set: { createdAt: new Date(Date.now() - 72_000) } }
  );

  // Ahora WhatsApp lo anuncia como saliente "desde el teléfono", con los bytes
  // enteros. Es la MISMA cosa, no un mensaje nuevo.
  await chat.ingestExternalOutbound({
    clinicId, channel: 'whatsapp', externalUserId: `${PHONE}@c.us`, phone: PHONE,
    body: 'Por favor revise el video para saber cómo llegar', externalId: 'wamid.ECO',
    media: { type: 'video', dataUrl: `data:video/mp4;base64,${'B'.repeat(2000)}` },
    account: null,
  });

  const outs = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(outs.length, 1, 'el video debe quedar UNA vez en el chat, no dos');
  assert.equal(outs[0].externalId, 'wamid.ECO', 'el eco aporta el wamid al mensaje que ya existía');
  assert.ok(!outs[0].mediaUrl.startsWith('data:'), 'y no se guardan los megas del eco');
});

test('un mensaje escrito DE VERDAD desde el teléfono sí entra (y su archivo va aparte)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  await chat.ingestExternalOutbound({
    clinicId, channel: 'whatsapp', externalUserId: `${PHONE}@c.us`, phone: PHONE,
    body: 'le mando la receta', externalId: 'wamid.TEL',
    media: { type: 'image', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', filename: 'receta.jpg' },
    account: null,
  });

  const outs = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(outs.length, 1);
  assert.equal(outs[0].origin, 'phone');
  assert.match(outs[0].mediaUrl, /^\/api\/public\/media\/[a-f0-9]{24}$/);
});

// ───────────────────── 3. el mismo envío nunca sale dos veces ───────────────

test('doble clic en Enviar manda el mensaje UNA sola vez', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  let sends = 0;
  const orig = gateway.sendText;
  gateway.sendText = async () => {
    sends += 1;
    return { ok: true, data: { messages: [{ id: `wamid.${sends}` }] } };
  };
  try {
    const body = { body: 'Estamos en Urdesa Central', clientId: 'abc-123' };
    const params = { params: { id: String(conv._id) } };

    const first = await H.runController(chat.sendMessage, H.mockReq(clinicId, userId, body, params));
    const second = await H.runController(chat.sendMessage, H.mockReq(clinicId, userId, body, params));

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201, 'el segundo intento no es un error para el agente');
    assert.equal(String(first.payload._id), String(second.payload._id), 'devuelve el MISMO mensaje');

    await H.waitForStatus(first.payload._id, 'sent');
    const outs = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
    assert.equal(outs.length, 1, 'el paciente recibe UN mensaje, no dos');
    assert.equal(sends, 1, 'el proveedor se llamó UNA vez');
  } finally {
    gateway.sendText = orig;
  }
});

test('dos clics SIMULTÁNEOS tampoco duplican (lo corta el índice único)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);
  // El índice { conversation, clientId } es el que resuelve la carrera; en el
  // harness los índices se crean bajo demanda.
  await Message.syncIndexes();

  let sends = 0;
  const orig = gateway.sendText;
  gateway.sendText = async () => {
    sends += 1;
    return { ok: true, data: { messages: [{ id: `wamid.${sends}` }] } };
  };
  try {
    const body = { body: 'mismo mensaje', clientId: 'race-1' };
    const params = { params: { id: String(conv._id) } };
    // A la vez: ninguna de las dos ve a la otra en la comprobación previa.
    const [a, b] = await Promise.all([
      H.runController(chat.sendMessage, H.mockReq(clinicId, userId, body, params)),
      H.runController(chat.sendMessage, H.mockReq(clinicId, userId, body, params)),
    ]);

    assert.equal(a.statusCode, 201, JSON.stringify(a.payload));
    assert.equal(b.statusCode, 201, JSON.stringify(b.payload));
    const outs = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
    assert.equal(outs.length, 1, 'el paciente recibe UN mensaje aunque las peticiones sean simultáneas');
  } finally {
    gateway.sendText = orig;
  }
});

test('sin clientId (envíos automáticos) el comportamiento no cambia', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  const orig = gateway.sendText;
  gateway.sendText = async () => ({ ok: true, data: { messages: [{ id: 'wamid.X' }] } });
  try {
    const params = { params: { id: String(conv._id) } };
    const a = await H.runController(chat.sendMessage, H.mockReq(clinicId, userId, { body: 'uno' }, params));
    const b = await H.runController(chat.sendMessage, H.mockReq(clinicId, userId, { body: 'dos' }, params));
    await H.waitForStatus(a.payload._id, 'sent');
    await H.waitForStatus(b.payload._id, 'sent');
    const outs = await Message.find({ conversation: conv._id, direction: 'out' }).lean();
    assert.equal(outs.length, 2, 'dos mensajes distintos siguen siendo dos mensajes');
  } finally {
    gateway.sendText = orig;
  }
});

test('el envío responde SIN esperar al proveedor (el agente puede pasar al siguiente chat)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const conv = await seedConv(clinicId);

  let release;
  const blocked = new Promise((r) => { release = r; });
  const orig = gateway.sendText;
  // Simula un video por QR: el proveedor tarda una eternidad en contestar.
  gateway.sendText = async () => {
    await blocked;
    return { ok: true, data: { messages: [{ id: 'wamid.SLOW' }] } };
  };
  try {
    const startedAt = Date.now();
    const out = await H.runController(
      chat.sendMessage,
      H.mockReq(clinicId, userId, { body: 'mira el video' }, { params: { id: String(conv._id) } })
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(out.statusCode, 201);
    assert.equal(out.payload.deliveryStatus, 'queued', 'se acepta como "enviando", nunca como "enviado"');
    assert.ok(elapsed < 1000, `la petición no debe esperar al proveedor (tardó ${elapsed}ms)`);

    // Y cuando el proveedor por fin contesta, el estado se resuelve solo.
    release();
    const settled = await H.waitForStatus(out.payload._id, 'sent');
    assert.equal(settled.externalId, 'wamid.SLOW');
  } finally {
    release();
    gateway.sendText = orig;
  }
});
