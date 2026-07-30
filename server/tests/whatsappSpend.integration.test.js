/**
 * Gasto REAL de WhatsApp: lo que Meta cobra por los mensajes de plantilla.
 *
 * Se intercepta `fetch` para responder como el endpoint `pricing_analytics` de la
 * WABA y se comprueba lo que de verdad importa: que el importe que se muestra es
 * el de Meta (nunca un estimado), que un re-sync no duplica ni suma dos veces, y
 * que cuando Meta NO informa el importe la pantalla lo dice en vez de cantar 0.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const spend = require('../utils/whatsappSpend');
const ctrl = require('../controllers/whatsappSpendController');
const WhatsappAccount = require('../models/WhatsappAccount');
const WhatsappSpendDay = require('../models/WhatsappSpendDay');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedCloudAccount() {
  return WhatsappAccount.create({
    label: 'Principal', connectionType: 'cloud_api', phoneNumberId: '111',
    businessAccountId: 'waba1', accessToken: 'token-x', isDefault: true,
  });
}

/** Punto de datos como los devuelve Meta (start = medianoche de Ecuador). */
const point = (ymd, over = {}) => ({
  start: Math.floor(spend.ecDayStartMs(ymd) / 1000),
  end: Math.floor((spend.ecDayStartMs(ymd) + 86400000) / 1000),
  country: 'EC',
  tier: '0:1',
  pricing_type: 'REGULAR',
  pricing_category: 'MARKETING',
  volume: 10,
  cost: 1.5,
  ...over,
});

/**
 * Sustituye fetch: responde a la consulta de gasto con `points` y a la de moneda
 * con `currency`. Devuelve las URLs pedidas para poder afirmar sobre la llamada.
 */
function stubMeta(points, { currency = 'USD', fail = null } = {}) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('fields=currency')) {
      return { ok: true, status: 200, json: async () => ({ currency }) };
    }
    if (fail) {
      return { ok: false, status: fail.status || 500, json: async () => ({ error: { message: fail.message } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ pricing_analytics: { data: [{ data_points: points }] } }),
    };
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

test('el importe que se muestra es el que informa Meta, por día y categoría', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await seedCloudAccount();
  const meta = stubMeta([
    point('2026-07-20', { pricing_category: 'MARKETING', volume: 100, cost: 12.5 }),
    point('2026-07-20', { pricing_category: 'UTILITY', volume: 40, cost: 1.2 }),
    point('2026-07-21', { pricing_category: 'MARKETING', volume: 50, cost: 6.25 }),
    // Mensajes gratis: cuentan como volumen pero no como dinero.
    point('2026-07-21', { pricing_category: 'SERVICE', pricing_type: 'FREE_CUSTOMER_SERVICE', volume: 80, cost: 0 }),
  ]);
  try {
    const sync = await spend.syncSpend({ from: '2026-07-20', to: '2026-07-21' });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.equal(sync.saved, 4);
    assert.equal(sync.currency, 'USD');
    // Se pidió DAILY y con las dimensiones de categoría/tipo/país.
    const askUrl = meta.calls.find((u) => u.includes('pricing_analytics'));
    assert.match(decodeURIComponent(askUrl), /granularity\(DAILY\)/);
    assert.match(decodeURIComponent(askUrl), /metric_types\(\['COST','VOLUME'\]\)/);
    assert.match(decodeURIComponent(askUrl), /PRICING_CATEGORY/);

    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-21' });
    // 12.5 + 1.2 + 6.25 = 19.95 exactamente lo que dijo Meta.
    assert.equal(data.totals.cost, 19.95);
    assert.equal(data.totals.billedMessages, 190); // 100+40+50 (los gratis no cuentan)
    assert.equal(data.totals.freeMessages, 80);
    assert.equal(data.totals.messagesWithoutCost, 0);

    assert.equal(data.days.length, 2);
    assert.equal(data.days[0].date, '2026-07-20');
    assert.equal(data.days[0].cost, 13.7);
    assert.equal(data.days[0].byCategory.MARKETING.cost, 12.5);
    assert.equal(data.days[0].byCategory.UTILITY.cost, 1.2);
    assert.equal(data.days[1].cost, 6.25);
    assert.equal(data.days[1].freeVolume, 80);

    const marketing = data.byCategory.find((c) => c.category === 'MARKETING');
    assert.equal(marketing.cost, 18.75);
    assert.equal(marketing.volume, 150);
    assert.deepEqual(data.byCountry, [{ country: 'EC', cost: 19.95, volume: 270 }]);
  } finally {
    meta.restore();
  }
});

test('re-sincronizar el mismo rango no duplica ni suma dos veces', async () => {
  await seedCloudAccount();
  const meta = stubMeta([point('2026-07-20', { volume: 10, cost: 2 })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(await WhatsappSpendDay.countDocuments({}), 1);
    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(data.totals.cost, 2);
    assert.equal(data.totals.billedMessages, 10);
  } finally {
    meta.restore();
  }
});

test('si Meta corrige el día, el dato viejo se reemplaza (no se acumula)', async () => {
  await seedCloudAccount();
  const first = stubMeta([point('2026-07-20', { volume: 10, cost: 2 })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
  } finally {
    first.restore();
  }
  const second = stubMeta([point('2026-07-20', { volume: 25, cost: 5.75 })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(data.totals.cost, 5.75);
    assert.equal(data.totals.billedMessages, 25);
  } finally {
    second.restore();
  }
});

test('lo que Meta deja de informar se borra del rango (sin datos fantasma)', async () => {
  await seedCloudAccount();
  const first = stubMeta([
    point('2026-07-20', { pricing_category: 'MARKETING', cost: 2 }),
    point('2026-07-20', { pricing_category: 'UTILITY', cost: 1 }),
  ]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(await WhatsappSpendDay.countDocuments({}), 2);
  } finally {
    first.restore();
  }
  const second = stubMeta([point('2026-07-20', { pricing_category: 'MARKETING', cost: 2 })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(await WhatsappSpendDay.countDocuments({}), 1);
    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(data.totals.cost, 2);
  } finally {
    second.restore();
  }
});

test('si Meta no informa el importe NO se inventa: se avisa', async () => {
  // Pasa cuando la cuenta se factura a través de un socio de Meta.
  await seedCloudAccount();
  const meta = stubMeta([point('2026-07-20', { volume: 30, cost: null })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    const row = await WhatsappSpendDay.findOne({ date: '2026-07-20' });
    assert.equal(row.cost, null, 'sin importe se guarda null, no 0');

    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(data.totals.cost, 0);
    assert.equal(data.totals.billedMessages, 30);
    // La bandera que hace que la pantalla explique por qué el total no cuadra.
    assert.equal(data.totals.messagesWithoutCost, 30);
  } finally {
    meta.restore();
  }
});

test('si Meta falla, el error se reporta (no se muestra un 0 tranquilizador)', async () => {
  await seedCloudAccount();
  const meta = stubMeta([], { fail: { status: 400, message: 'Error validating access token' } });
  try {
    const r = await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'meta_error');
    assert.match(r.error, /access token/);
  } finally {
    meta.restore();
  }
});

test('sin número Cloud API configurado se explica qué falta', async () => {
  const r = await spend.syncSpend({ from: '2026-07-20', to: '2026-07-20' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_configured');
  assert.match(r.error, /WABA/);

  const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-20' });
  assert.equal(data.configured, false);
  assert.match(data.notConfigured, /Cloud API/);
});

test('la serie por día es continua: los días sin gasto salen en 0', async () => {
  await seedCloudAccount();
  const meta = stubMeta([point('2026-07-22', { cost: 3 })]);
  try {
    await spend.syncSpend({ from: '2026-07-20', to: '2026-07-22' });
    const data = await spend.readSpend({ from: '2026-07-20', to: '2026-07-22' });
    assert.deepEqual(data.days.map((d) => d.date), ['2026-07-20', '2026-07-21', '2026-07-22']);
    assert.deepEqual(data.days.map((d) => d.cost), [0, 0, 3]);
  } finally {
    meta.restore();
  }
});

test('el desglose por plantilla usa la categoría con la que Meta cobró cada mensaje', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999111222', channel: 'whatsapp' });
  const at = new Date(spend.ecDayStartMs('2026-07-20') + 3600000);
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'hola',
    templateName: 'recordatorio_cita', createdAt: at,
    billing: { billable: true, category: 'utility', type: 'regular', model: 'PMP' },
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'hola',
    templateName: 'recordatorio_cita', createdAt: at,
    billing: { billable: true, category: 'utility', type: 'regular', model: 'PMP' },
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'promo',
    templateName: 'promo_julio', createdAt: at,
    billing: { billable: false, category: 'marketing', type: 'free_customer_service', model: 'PMP' },
  });
  // Un mensaje normal (sin plantilla) NO entra: no lo cobra Meta como plantilla.
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'suelto', createdAt: at,
  });

  const rows = await spend.readByTemplate({ clinicId, from: '2026-07-20', to: '2026-07-20' });
  assert.equal(rows.length, 2);
  const rec = rows.find((r) => r.template === 'recordatorio_cita');
  assert.equal(rec.messages, 2);
  assert.equal(rec.billed, 2);
  assert.equal(rec.category, 'utility');
  const promo = rows.find((r) => r.template === 'promo_julio');
  assert.equal(promo.billed, 0);
  assert.equal(promo.free, 1);
});

test('el webhook guarda cómo cobró Meta cada mensaje, incluso si el ack llega tarde', async () => {
  // El bloque `pricing` viaja en el estado 'sent', que muchas veces llega DESPUÉS
  // del 'delivered'. Si se descartara junto con el estado fuera de orden, se
  // perdería el único dato que dice con qué categoría se cobró el mensaje.
  const messaging = require('../utils/messaging');
  const clinicId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999111222', channel: 'whatsapp' });
  const msg = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'hola',
    templateName: 'promo_julio', externalId: 'wamid.AAA', deliveryStatus: 'delivered',
  });

  const r = await messaging.updateMessageStatus({
    clinicId,
    externalId: 'wamid.AAA',
    status: 'sent', // atrasado: no debe pisar 'delivered'
    pricing: { billable: true, category: 'MARKETING', type: 'REGULAR', model: 'PMP' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ignored, true, 'el estado atrasado se ignora…');

  const fresh = await Message.findById(msg._id).lean();
  assert.equal(fresh.deliveryStatus, 'delivered', '…y "entregado" no retrocede');
  // …pero la facturación SÍ se guardó, normalizada.
  assert.equal(fresh.billing.billable, true);
  assert.equal(fresh.billing.category, 'marketing');
  assert.equal(fresh.billing.type, 'regular');
  assert.equal(fresh.billing.model, 'PMP');
});

test('el endpoint por defecto trae los últimos 30 días y respeta el rango pedido', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await seedCloudAccount();
  const meta = stubMeta([]);
  try {
    const res = await H.runController(
      ctrl.get,
      H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, {
        role: 'marketing',
        query: { from: '2026-07-20', to: '2026-07-21' },
      })
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.from, '2026-07-20');
    assert.equal(res.payload.to, '2026-07-21');
    assert.equal(res.payload.days.length, 2);

    // Sin rango: 30 días hasta hoy.
    const def = await H.runController(
      ctrl.get,
      H.mockReq(clinicId, new H.mongoose.Types.ObjectId(), {}, { role: 'admin' })
    );
    assert.equal(def.statusCode, 200);
    assert.equal(def.payload.to, spend.todayEc());
    assert.equal(def.payload.days.length, 30);
  } finally {
    meta.restore();
  }
});
