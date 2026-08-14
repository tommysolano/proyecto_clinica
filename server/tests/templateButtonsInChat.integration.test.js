/**
 * «EN WHATSAPP SALE EL BOTÓN Y EN NUESTRO CHAT NO».
 *
 * Los botones de un nodo de workflow viajan en la llamada a `messaging.send`, así
 * que se guardaban en el mensaje. Los de una PLANTILLA no los manda nadie: viven
 * en la plantilla aprobada y los pinta WhatsApp en el móvil del paciente. Como
 * nada los copiaba al mensaje, en el chat del sistema el agente veía el texto
 * pelado ("¿Asistirás mañana?") mientras el paciente tenía delante un botón
 * "Si asistiré", y al pulsarlo aparecía una respuesta suelta sin contexto.
 *
 * Medido en producción el 13-ago-2026: de 1.824 plantillas enviadas en 15 días,
 * CERO llevaban botones guardados — y las cuatro más enviadas sí los tienen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** No manda nada de verdad: solo deja constancia de la llamada al proveedor. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate, sendButtons: gw.sendButtons };
  const sent = [];
  gw.sendText = async (account, to, body) => {
    sent.push({ tipo: 'texto', to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendButtons = async (account, to, body, buttons) => {
    sent.push({ tipo: 'botones', to, body, buttons });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, name) => {
    sent.push({ tipo: 'plantilla', to, name });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

const numeroApi = () => WhatsappAccount.create({
  label: 'API', connectionType: 'cloud_api', enabled: true, isDefault: true,
  phoneNumberId: '111', accessToken: 'tok',
});

test('la plantilla con botones los deja guardados en el mensaje del chat', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numeroApi();
    await MessageTemplate.create({
      clinic: clinicId, channel: 'whatsapp', name: '24h_flujo', status: 'approved',
      body: '¿Asistirás mañana a tu cita?',
      buttons: [
        { type: 'quick_reply', text: 'Si asistire' },
        { type: 'url', text: 'Ver ubicación', url: 'https://maps.example/clinica' },
      ],
    });
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });

    const r = await messaging.send({
      clinicId,
      channel: 'whatsapp',
      conversation: conv,
      to: '593999111222',
      template: { name: '24h_flujo', language: 'es' },
    });
    assert.equal(r.ok, true, r.reason || r.errorMessage);

    const msg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
    assert.equal(msg.templateName, '24h_flujo');
    assert.deepEqual(
      msg.buttons.map((b) => [b.type, b.text, b.url]),
      [['quick_reply', 'Si asistire', ''], ['url', 'Ver ubicación', 'https://maps.example/clinica']],
      'la burbuja del chat enseña los mismos botones que recibe el paciente'
    );
  } finally {
    gw.restore();
  }
});

test('sin plantilla mandan los botones de quien envía (nodo de workflow)', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numeroApi();
    const conv = await Conversation.create({
      clinic: clinicId, channel: 'whatsapp', phone: '593999111333', lastInboundAt: new Date(),
    });

    const r = await messaging.send({
      clinicId,
      channel: 'whatsapp',
      conversation: conv,
      to: '593999111333',
      body: 'Elige una opción',
      buttons: [{ id: 'b1', type: 'quick_reply', text: 'Confirmar' }],
    });
    assert.equal(r.ok, true, r.reason || r.errorMessage);

    const msg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
    assert.deepEqual(msg.buttons.map((b) => [b.id, b.type, b.text]), [['b1', 'quick_reply', 'Confirmar']]);
  } finally {
    gw.restore();
  }
});

test('una plantilla SIN botones no inventa ninguno', async () => {
  const { clinicId } = await H.seedClinic();
  const gw = fakeGateway();
  try {
    await numeroApi();
    await MessageTemplate.create({
      clinic: clinicId, channel: 'whatsapp', name: 'aviso_simple', status: 'approved',
      body: 'Te esperamos mañana.',
    });
    const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111444' });

    await messaging.send({
      clinicId, channel: 'whatsapp', conversation: conv, to: '593999111444',
      template: { name: 'aviso_simple', language: 'es' },
    });

    const msg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
    assert.deepEqual(msg.buttons, []);
  } finally {
    gw.restore();
  }
});
