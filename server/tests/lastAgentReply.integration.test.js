/**
 * «¿Qué asesora atendió por última vez este chat?»
 *
 * La bandeja mostraba el agente ASIGNADO (`assignedToName`), que se fija con el
 * PRIMERO que tocó el chat y ya no se mueve salvo transferencia: un chat seguía
 * rotulado "Emily" aunque llevara semanas contestándolo otra persona. Ahora se
 * muestra `lastAgentReplyName`, que sí se mueve.
 *
 * Lo que este archivo fija es CUÁNDO se mueve y cuándo NO, porque el matiz es
 * todo: si contara cualquier saliente, una difusión dejaría al supervisor como
 * "última asesora" de cientos de chats a la vez.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const chat = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Acepta cualquier envío sin mandar nada de verdad. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const orig = { sendText: gw.sendText };
  let n = 0;
  gw.sendText = async () => { n += 1; return { ok: true, data: { messages: [{ id: `wamid.${n}` }] } }; };
  return { restore: () => Object.assign(gw, orig) };
}

// Número QR a propósito: los QR no tienen ventana de 24h, así que el envío de
// texto libre no se salta por `out_of_window` y el test mide lo que quiere medir.
const numero = () =>
  WhatsappAccount.create({
    label: 'QR Recepción', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected',
  });

/** Chat ya asignado a Emily: es el estado del que se quejaba el usuario. */
const chatDeEmily = (clinicId, emilyId) =>
  Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593993151453',
    contactName: 'Angi', assignedTo: emilyId, assignedToName: 'Emily',
  });

const responder = (clinicId, conv, extra) =>
  messaging.send({ clinicId, channel: 'whatsapp', conversation: conv, to: conv.phone, body: 'Hola', ...extra });

// ─────────────────────────────────────────────────────────────────────────────

test('A1) responder deja anotada a la asesora, sin tocar la asignación', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numero();
    const emilyId = new H.mongoose.Types.ObjectId();
    const anaId = new H.mongoose.Types.ObjectId();
    const conv = await chatDeEmily(clinicId, emilyId);

    const r = await responder(clinicId, conv, { sentBy: anaId, sentByName: 'Ana' });
    assert.equal(r.ok, true, r.reason || r.errorMessage);

    const saved = await Conversation.findById(conv._id);
    assert.equal(saved.lastAgentReplyName, 'Ana', 'la última que respondió fue Ana');
    assert.equal(String(saved.lastAgentReplyBy), String(anaId));
    assert.ok(saved.lastAgentReplyAt, 'y queda la marca de cuándo');
    // Lo que el usuario veía antes sigue intacto: son dos cosas distintas.
    assert.equal(saved.assignedToName, 'Emily', 'la asignación NO se toca');
    assert.equal(String(saved.assignedTo), String(emilyId));
  } finally {
    gw.restore();
  }
});

test('A2) la siguiente asesora que responde reemplaza a la anterior', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numero();
    const conv = await chatDeEmily(clinicId, new H.mongoose.Types.ObjectId());
    const anaId = new H.mongoose.Types.ObjectId();
    const soniaId = new H.mongoose.Types.ObjectId();

    await responder(clinicId, conv, { sentBy: anaId, sentByName: 'Ana' });
    await responder(clinicId, conv, { sentBy: soniaId, sentByName: 'Sonia' });

    const saved = await Conversation.findById(conv._id);
    assert.equal(saved.lastAgentReplyName, 'Sonia');
    assert.equal(String(saved.lastAgentReplyBy), String(soniaId));
    // La PRIMERA respuesta sigue siendo de Ana: esa métrica no se pisa.
    assert.equal(String(saved.firstResponseBy), String(anaId));
  } finally {
    gw.restore();
  }
});

test('A3) un envío automático o de workflow NO cuenta como atender', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numero();
    const conv = await chatDeEmily(clinicId, new H.mongoose.Types.ObjectId());
    const anaId = new H.mongoose.Types.ObjectId();

    await responder(clinicId, conv, { sentBy: anaId, sentByName: 'Ana' });
    // Los workflows y las respuestas automáticas no traen `sentBy`.
    await responder(clinicId, await Conversation.findById(conv._id), { isAutoReply: true });

    const saved = await Conversation.findById(conv._id);
    assert.equal(saved.lastAgentReplyName, 'Ana', 'sigue siendo Ana: el robot no atendió');
    assert.equal(String(saved.lastAgentReplyBy), String(anaId));
  } finally {
    gw.restore();
  }
});

test('A4) una difusión NO deja al supervisor como última asesora', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numero();
    const conv = await chatDeEmily(clinicId, new H.mongoose.Types.ObjectId());
    const anaId = new H.mongoose.Types.ObjectId();

    await responder(clinicId, conv, { sentBy: anaId, sentByName: 'Ana' });
    // Envío masivo: lleva persona, pero mandar lo mismo a 300 chats no es atender.
    await responder(clinicId, await Conversation.findById(conv._id), {
      sentBy: new H.mongoose.Types.ObjectId(), sentByName: 'Supervisor', broadcast: true,
    });

    const saved = await Conversation.findById(conv._id);
    assert.equal(saved.lastAgentReplyName, 'Ana', 'la difusión no pisa a quien sí atendió');
    // Lo demás de una difusión no cambia: sigue contando como respuesta a efectos
    // de la marca de tiempo y del "no leído" (comportamiento previo intacto).
    assert.ok(saved.lastAgentReplyAt);
    assert.equal(saved.unreadCount, 0);
  } finally {
    gw.restore();
  }
});

test('A5) la bandeja recibe el nombre: viaja en la proyección de GET /chats', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numero();
    const conv = await chatDeEmily(clinicId, new H.mongoose.Types.ObjectId());
    await responder(clinicId, conv, { sentBy: new H.mongoose.Types.ObjectId(), sentByName: 'Ana' });

    const r = await H.runController(
      chat.listConversations,
      H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'admin', query: {} })
    );
    assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
    const fila = (r.payload.items || r.payload).find((c) => String(c._id) === String(conv._id));
    assert.ok(fila, 'el chat aparece en la bandeja');
    // La lista va PROYECTADA: si el campo no está en el .select, no llega nunca.
    assert.equal(fila.lastAgentReplyName, 'Ana');
  } finally {
    gw.restore();
  }
});
