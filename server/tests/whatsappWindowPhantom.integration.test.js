/**
 * VENTANA DE 24 H FANTASMA: el mensaje que "se envía" y el paciente nunca recibe.
 *
 * Caso real (7-ago-2026, chat 593982921699). Una automatización mandó la plantilla
 * `24h_flujo` a una paciente que NUNCA le había escrito a la clínica. Eso creó la
 * conversación. Al día siguiente la agente abrió ese chat, vio en verde "Ventana de
 * 24h ABIERTA: puedes escribir libremente durante 7 h 43 min más", escribió cuatro
 * veces "Buen día, estimada si pudo llegar a su cita?" y las cuatro las rechazó Meta
 * con el error 131047 ("Re-engagement message"). La paciente no recibió ninguna.
 *
 * La ventana de 24 h solo la abre un mensaje ENTRANTE del contacto. Pero la
 * conversación nacía con los valores por defecto del modelo —`lastMessageDirection:'in'`
 * y `lastMessageAt:ahora`— y el cálculo tenía un respaldo "si el último mensaje fue
 * entrante, la ventana sale de él". Un chat recién creado por un envío NUESTRO pasaba
 * ese respaldo, y el envío GUARDABA la ventana inventada en `window24hExpiresAt`, con
 * lo que la mentira se volvía permanente. En producción quedaron 76 chats así y 20
 * mensajes perdidos en 30 días.
 *
 * Estos tests fijan la regla: sin entrante real, NO hay ventana.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const chatController = require('../controllers/chatController');
const { clearPhantomWindows } = require('../scripts/clearPhantomWhatsappWindowOnce');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593982921699';

/** Cuenta Cloud API por defecto (la ventana de 24h solo aplica a Cloud, no al QR). */
function cuentaCloud() {
  return WhatsappAccount.create({
    label: 'Recepcion', connectionType: 'cloud_api', accessToken: 'T',
    phoneNumberId: '1', enabled: true, isDefault: true,
  });
}

/** Anota qué se mandó de verdad al proveedor: lo que NO aparece aquí, no salió. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate };
  gw.sendText = async (account, to, body) => {
    sent.push({ tipo: 'texto', to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, templateName) => {
    sent.push({ tipo: 'plantilla', to, templateName });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

function plantilla(clinicId) {
  return MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: '24h_flujo', status: 'approved',
    body: 'Este es un recordatorio de tu cita de mañana.',
  });
}

// ─────────── 1. el chat que nace de un envío nuestro no abre ventana ───────────

test('un chat creado por un envío NUESTRO no abre ninguna ventana de 24h', async () => {
  const { clinicId } = await H.seedClinic();
  await cuentaCloud();
  await plantilla(clinicId);
  const gw = fakeGateway();

  try {
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', to: TEL,
      template: { name: '24h_flujo', language: 'es' },
      isAutoReply: true,
    });
    assert.equal(r.ok, true, 'la plantilla sí puede salir (funciona fuera de la ventana)');
  } finally {
    gw.restore();
  }

  const conv = await Conversation.findOne({ clinic: clinicId, phone: TEL }).lean();
  assert.ok(conv, 'la conversación se creó con el envío');
  assert.equal(conv.lastInboundAt, null, 'el contacto no ha escrito nada');
  assert.equal(conv.window24hExpiresAt, null, 'NO se guarda ninguna ventana inventada');
  assert.equal(conv.lastMessageDirection, 'out', 'el último mensaje es nuestro, no suyo');

  const win = messaging.describeWhatsappWindow(conv, 'cloud_api');
  assert.equal(win.applies, true, 'es Cloud API: la ventana aplica');
  assert.equal(win.open, false, 'y está CERRADA: nadie nos ha escrito');
  assert.equal(win.msRemaining, 0);
});

// ─────────── 2. el texto libre se detiene ANTES de llegar a Meta ───────────

test('el texto libre a ese chat se omite por ventana cerrada (no se manda a Meta)', async () => {
  const { clinicId } = await H.seedClinic();
  await cuentaCloud();
  await plantilla(clinicId);
  const gw = fakeGateway();

  try {
    await messaging.send({
      clinicId, channel: 'whatsapp', to: TEL,
      template: { name: '24h_flujo', language: 'es' }, isAutoReply: true,
    });
    // Al día siguiente la agente escribe a mano, como en el caso real.
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', to: TEL,
      body: 'Buen día, estimada si pudo llegar a su cita?',
    });

    assert.equal(r.ok, false);
    assert.equal(r.skipped, true, 'se para aquí en vez de gastar un envío que Meta rechaza');
    assert.equal(r.reason, 'out_of_window');
    assert.deepEqual(
      gw.sent.map((s) => s.tipo),
      ['plantilla'],
      'a Meta solo fue la plantilla: el texto libre NUNCA se intentó'
    );
  } finally {
    gw.restore();
  }
});

// ─────────── 3. con un entrante real la ventana sí se abre ───────────

test('cuando el contacto escribe de verdad, el texto libre pasa', async () => {
  const { clinicId } = await H.seedClinic();
  await cuentaCloud();
  const gw = fakeGateway();

  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    // Lo que hace la ingesta de un entrante real (ver chatController#ingest).
    lastInboundAt: new Date(),
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(new Date()),
    lastMessageDirection: 'in',
  });

  try {
    const r = await messaging.send({ clinicId, channel: 'whatsapp', to: TEL, body: 'Hola, ¿en qué le ayudo?' });
    assert.equal(r.ok, true);
    assert.deepEqual(gw.sent.map((s) => s.tipo), ['texto']);
  } finally {
    gw.restore();
  }

  const win = messaging.describeWhatsappWindow(await Conversation.findById(conv._id).lean(), 'cloud_api');
  assert.equal(win.open, true);
  assert.ok(win.msRemaining > 23 * 3600 * 1000);
});

// ─────────── 4. la limpieza de las ventanas que ya estaban guardadas ───────────

test('la tarea de una sola vez borra la ventana fantasma y cura la que sí tenía entrante', async () => {
  const { clinicId } = await H.seedClinic();
  const enUnRato = new Date(Date.now() + 7 * 3600 * 1000);

  // (a) Fantasma exacto del caso real: ventana guardada, cero mensajes entrantes.
  const fantasma = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    window24hExpiresAt: enUnRato, lastInboundAt: null, lastMessageDirection: 'out',
  });
  await Message.create({
    clinic: clinicId, conversation: fantasma._id, direction: 'out',
    body: 'Este es un recordatorio…', templateName: '24h_flujo', deliveryStatus: 'sent',
  });

  // (b) Conversación legítima a la que solo le faltaba `lastInboundAt`.
  const legitima = await Conversation.create({
    clinic: clinicId, phone: '593999888777', channel: 'whatsapp',
    window24hExpiresAt: enUnRato, lastInboundAt: null, lastMessageDirection: 'in',
  });
  const entrante = await Message.create({
    clinic: clinicId, conversation: legitima._id, direction: 'in',
    body: 'Buenas, quiero una cita', deliveryStatus: 'delivered',
  });

  const stats = await clearPhantomWindows({ commit: true, log: () => {} });
  assert.equal(stats.revisadas, 2);
  assert.equal(stats.fantasmas, 1);
  assert.equal(stats.curadas, 1);

  const f = await Conversation.findById(fantasma._id).lean();
  assert.equal(f.window24hExpiresAt, null, 'la ventana inventada desaparece');
  assert.equal(messaging.describeWhatsappWindow(f, 'cloud_api').open, false);

  const l = await Conversation.findById(legitima._id).lean();
  assert.equal(
    new Date(l.lastInboundAt).getTime(),
    new Date(entrante.createdAt).getTime(),
    'la legítima recupera la fecha de su entrante real'
  );
  assert.equal(messaging.describeWhatsappWindow(l, 'cloud_api').open, true, 'y sigue abierta');
});

// ─────────── 5. el motivo del rechazo, en castellano ───────────

test('el error de Meta se guarda explicado, no como "Re-engagement message"', () => {
  // Lo que manda Meta de verdad en el webhook de estado del caso real.
  const texto = chatController.metaErrorText({
    code: 131047,
    title: 'Re-engagement message',
    message: '(#131047) Re-engagement message',
    error_data: { details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.' },
  });
  assert.match(texto, /24 h/, 'dice qué pasó');
  assert.match(texto, /plantilla aprobada/, 'y qué hacer para arreglarlo');

  // Un código que no está en la lista cae en la explicación larga de Meta, no en el título.
  const otro = chatController.metaErrorText({
    code: 999999, title: 'Something', error_data: { details: 'La explicación larga de Meta.' },
  });
  assert.equal(otro, 'La explicación larga de Meta.');
});
