/**
 * El estado de entrega (deliveryStatus) debe ser MONÓTONO: los webhooks de Meta y
 * los acks de whatsapp-web.js llegan fuera de orden y se reintentan. Sin esta
 * guarda, un 'sent' tardío pisa un 'delivered'/'read' real, o —lo peligroso— un
 * estado tardío REVIVE un 'failed' y el chat muestra "enviado/entregado" un mensaje
 * que el contacto NUNCA recibió. Estos tests reproducen esos escenarios reales
 * contra el updateMessageStatus de verdad (Mongo en memoria).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const messaging = require('../utils/messaging');
const Message = require('../models/Message');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedOut(clinicId, externalId, deliveryStatus = 'sent') {
  const conv = await require('../models/Conversation').create({
    clinic: clinicId, phone: '593999999999', channel: 'whatsapp', lastMessageAt: new Date(),
  });
  return Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out',
    body: 'hola', externalId, deliveryStatus,
  });
}

test('un "sent" tardío NO retrocede un mensaje ya "read"', async () => {
  const { clinicId } = await H.seedClinic();
  const msg = await seedOut(clinicId, 'wamid.A', 'sent');

  await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.A', status: 'delivered' });
  await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.A', status: 'read' });
  // Callback fuera de orden: llega un 'sent' viejo DESPUÉS del 'read'.
  const r = await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.A', status: 'sent' });

  assert.equal(r.ignored, true, 'el sent tardío se ignora');
  const fresh = await Message.findById(msg._id).lean();
  assert.equal(fresh.deliveryStatus, 'read', 'sigue leído, no retrocede a enviado');
});

test('un "failed" NO se revive con un "sent"/"delivered" tardío (no miente sobre la entrega)', async () => {
  const { clinicId } = await H.seedClinic();
  const msg = await seedOut(clinicId, 'wamid.B', 'sent');

  // Meta reporta que el mensaje falló (no se pudo entregar al contacto).
  await messaging.updateMessageStatus({
    clinicId, externalId: 'wamid.B', status: 'failed',
    errorMessage: 'Número no está en WhatsApp',
  });
  // Reintento/reorden del webhook: llega un 'sent' viejo DESPUÉS del failed.
  const r1 = await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.B', status: 'sent' });
  const r2 = await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.B', status: 'delivered' });

  assert.equal(r1.ignored, true);
  assert.equal(r2.ignored, true);
  const fresh = await Message.findById(msg._id).lean();
  assert.equal(fresh.deliveryStatus, 'failed', 'sigue fallido: NO dice enviado/entregado');
  assert.equal(fresh.errorMessage, 'Número no está en WhatsApp', 'conserva el motivo real');
});

test('un "failed" tardío SÍ marca fallido un mensaje que sólo estaba "sent"', async () => {
  const { clinicId } = await H.seedClinic();
  const msg = await seedOut(clinicId, 'wamid.C', 'sent');

  // Meta aceptó el POST (sent) pero luego no pudo entregar → failed.
  const r = await messaging.updateMessageStatus({
    clinicId, externalId: 'wamid.C', status: 'failed', errorMessage: 'Media file size too big.',
  });

  assert.equal(r.ok, true);
  assert.notEqual(r.ignored, true);
  const fresh = await Message.findById(msg._id).lean();
  assert.equal(fresh.deliveryStatus, 'failed');
  assert.equal(fresh.errorMessage, 'Media file size too big.');
});

test('un "failed" tardío NO borra una entrega real ("delivered")', async () => {
  const { clinicId } = await H.seedClinic();
  const msg = await seedOut(clinicId, 'wamid.D', 'sent');

  await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.D', status: 'delivered' });
  const r = await messaging.updateMessageStatus({ clinicId, externalId: 'wamid.D', status: 'failed' });

  assert.equal(r.ignored, true, 'un failed espurio no borra una entrega confirmada');
  const fresh = await Message.findById(msg._id).lean();
  assert.equal(fresh.deliveryStatus, 'delivered');
});
