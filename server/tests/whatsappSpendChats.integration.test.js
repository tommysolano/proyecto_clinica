/**
 * CHATS DE UNA CATEGORÍA DE META (oct-2026): al pulsar «Servicio» en Gasto de
 * WhatsApp se listan las conversaciones donde salieron esos mensajes, con lo
 * cobrado y lo gratis, sin teléfonos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappSpendDay = require('../models/WhatsappSpendDay');
const spend = require('../utils/whatsappSpend');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('agrupa por chat los mensajes de la categoría pedida en el rango', async () => {
  const { clinicId } = await H.seedClinic();
  const a = await Conversation.create({ clinic: clinicId, phone: '593990000001', channel: 'whatsapp', contactName: 'Ana' });
  const b = await Conversation.create({ clinic: clinicId, phone: '593990000002', channel: 'whatsapp', contactName: 'Beto' });
  const hoy = spend.todayEc();
  const enRango = new Date(spend.ecDayStartMs(hoy) + 10 * 3600e3);
  const fuera = new Date(spend.ecDayStartMs(hoy) - 3 * 86400e3);
  const msg = (conversation, billing, extra = {}) => ({
    clinic: clinicId, conversation, direction: 'out', content: 'hola', createdAt: enRango, billing, ...extra,
  });
  await Message.create([
    msg(a._id, { category: 'service', billable: true }, { sentByName: 'Emily' }),
    msg(a._id, { category: 'service', billable: true }, { sentByName: 'Emily' }),
    msg(a._id, { category: 'service', billable: false }, { isAutoReply: true }),
    msg(b._id, { category: 'service', billable: true }, { sentByName: 'Andreina' }),
    msg(b._id, { category: 'utility', billable: true }, { sentByName: 'Andreina' }),
    msg(b._id, { category: 'service', billable: true }, { createdAt: fuera }),
  ]);

  // Meta cobró ese día $0,09 por 3 mensajes de servicio → $0,03 cada uno.
  await WhatsappSpendDay.create([
    { wabaId: 'w', date: hoy, country: 'EC', pricingCategory: 'SERVICE', pricingType: 'REGULAR', tier: '', volume: 3, cost: 0.09 },
    { wabaId: 'w', date: hoy, country: 'EC', pricingCategory: 'SERVICE', pricingType: 'FREE_ENTRY_POINT', tier: '', volume: 1, cost: 0 },
  ]);

  const r = await spend.readChatsByCategory({ category: 'SERVICE', from: hoy, to: hoy });
  assert.equal(r.totals.chats, 2);
  assert.equal(r.totals.billed, 3);
  assert.equal(r.totals.free, 1);
  assert.equal(r.totals.cost, 0.09, 'la suma de los chats es lo que cobró Meta');
  assert.equal(r.totals.metaCost, 0.09);
  assert.equal(r.chats[0].cost, 0.06, '2 mensajes cobrados × $0,03');
  assert.equal(r.chats[1].cost, 0.03);
  assert.equal(r.chats[0].name, 'Ana', 'primero el que más costó');
  assert.equal(r.chats[0].billed, 2);
  assert.equal(r.chats[0].free, 1);
  assert.equal(r.chats[0].automatic, 1);
  assert.deepEqual(r.chats[0].senders, ['Emily']);
  assert.equal(r.chats[1].billed, 1, 'el de fuera del rango y el de utilidad no cuentan');
  assert.ok(!('phone' in r.chats[0]), 'sin teléfonos');

  const u = await spend.readChatsByCategory({ category: 'utility', from: hoy, to: hoy });
  assert.equal(u.totals.chats, 1);
});
