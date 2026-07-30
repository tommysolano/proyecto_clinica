/**
 * Gasto REAL de WhatsApp: cuánto nos ha cobrado Meta por los mensajes de plantilla.
 *
 * La cifra NO se calcula aquí. Se le pregunta a Meta con el endpoint
 * `pricing_analytics` de la WABA, que desde el 1-jul-2025 (cobro POR MENSAJE)
 * devuelve, por día, el costo y el número de mensajes cobrados por categoría de
 * precio (marketing / utility / authentication / service), tipo de precio
 * (regular o gratis) y país:
 *
 *   GET /<WABA_ID>?fields=pricing_analytics.start(<unix>).end(<unix>)
 *       .granularity(DAILY).metric_types(['COST','VOLUME'])
 *       .dimensions(['PRICING_CATEGORY','PRICING_TYPE','COUNTRY'])
 *
 * Respuesta: pricing_analytics.data[0].data_points[] con
 *   { start, end, country, tier, pricing_type, pricing_category, volume, cost }
 *
 * OJO: Meta NO informa el costo cuando la cuenta se factura a través de un socio
 * (Solution Partner). En ese caso se guarda `cost: null` y la pantalla lo dice;
 * jamás se rellena con una tarifa estimada, porque el usuario pidió cifras reales.
 *
 * Requiere que el token tenga `whatsapp_business_management` sobre la WABA.
 */
const WhatsappSpendDay = require('../models/WhatsappSpendDay');

const EC_OFFSET_MS = 5 * 60 * 60 * 1000; // Ecuador UTC-5 (sin horario de verano)
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' del instante dado, en hora de Ecuador. */
function ecDate(dateOrMs) {
  const ms = dateOrMs instanceof Date ? dateOrMs.getTime() : Number(dateOrMs);
  return new Date(ms - EC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Medianoche de Ecuador de 'YYYY-MM-DD', en milisegundos UTC. */
function ecDayStartMs(ymd) {
  return Date.parse(`${ymd}T00:00:00.000Z`) + EC_OFFSET_MS;
}

/** Hoy en Ecuador, 'YYYY-MM-DD'. */
const todayEc = () => ecDate(Date.now());

/**
 * Credenciales de la WABA (número Cloud API por defecto). Devuelve
 * { ok:false, reason:'not_configured' } si todavía no hay número Cloud conectado:
 * no es un error, es que aún no hay nada que cobrar.
 */
async function resolveWaba() {
  const gateway = require('./whatsappGateway');
  const account = await gateway.getDefaultCloudAccount();
  if (!account || !account.businessAccountId || !account.accessToken) {
    return {
      ok: false,
      reason: 'not_configured',
      error:
        'No hay un número Cloud API con WABA y token configurado. El gasto de plantillas lo informa Meta ' +
        'para la cuenta de WhatsApp Business (WABA); añádelo en Configuración del Call Center.',
    };
  }
  const accessToken = require('./secretCrypto').decryptSecret(account.accessToken);
  return { ok: true, wabaId: String(account.businessAccountId), accessToken, account };
}

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

/**
 * Moneda en la que Meta factura esta WABA. Va en una petición APARTE a propósito:
 * si el campo no estuviera disponible, no debe tumbar la consulta del gasto.
 */
async function fetchCurrency(wabaId, accessToken) {
  try {
    const url = `https://graph.facebook.com/${API_VERSION}/${wabaId}?fields=currency&access_token=${accessToken}`;
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    return r.ok && data?.currency ? String(data.currency) : 'USD';
  } catch {
    return 'USD';
  }
}

/**
 * Pide a Meta el gasto por DÍA de un rango (inclusive). `from`/`to` en
 * 'YYYY-MM-DD' (días de Ecuador).
 */
async function fetchSpendFromMeta({ from, to }) {
  const waba = await resolveWaba();
  if (!waba.ok) return waba;

  const start = Math.floor(ecDayStartMs(from) / 1000);
  // `end` es exclusivo en la práctica: se pide hasta el final del último día.
  const end = Math.floor((ecDayStartMs(to) + DAY_MS) / 1000);

  const field =
    `pricing_analytics.start(${start}).end(${end}).granularity(DAILY)` +
    `.metric_types(['COST','VOLUME'])` +
    `.dimensions(['PRICING_CATEGORY','PRICING_TYPE','COUNTRY'])`;
  const url =
    `https://graph.facebook.com/${API_VERSION}/${waba.wabaId}` +
    `?fields=${encodeURIComponent(field)}&access_token=${waba.accessToken}`;

  let r;
  let data;
  try {
    r = await fetch(url);
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, reason: 'network', error: e.message };
  }
  if (!r.ok) {
    return {
      ok: false,
      reason: 'meta_error',
      error: data?.error?.message || `HTTP ${r.status}`,
      code: data?.error?.code || null,
    };
  }

  const points = data?.pricing_analytics?.data?.[0]?.data_points || [];
  const currency = await fetchCurrency(waba.wabaId, waba.accessToken);
  const rows = points.map((p) => ({
    wabaId: waba.wabaId,
    date: ecDate(Number(p.start) * 1000),
    country: String(p.country || ''),
    pricingCategory: String(p.pricing_category || '').toUpperCase(),
    pricingType: String(p.pricing_type || '').toUpperCase(),
    tier: String(p.tier || ''),
    volume: Number(p.volume || 0),
    // `cost` ausente ≠ 0: Meta no lo informa si factura un socio.
    cost: p.cost === undefined || p.cost === null ? null : Number(p.cost),
    currency,
  }));
  return { ok: true, wabaId: waba.wabaId, currency, rows, points: points.length };
}

/**
 * Trae el rango de Meta y lo guarda (upsert idempotente). Las filas del rango que
 * Meta ya no informa se borran, para que un re-sync no deje datos fantasma.
 */
async function syncSpend({ from, to }) {
  const fetched = await fetchSpendFromMeta({ from, to });
  if (!fetched.ok) return fetched;

  const keys = [];
  for (const row of fetched.rows) {
    const key = {
      wabaId: row.wabaId,
      date: row.date,
      country: row.country,
      pricingCategory: row.pricingCategory,
      pricingType: row.pricingType,
      tier: row.tier,
    };
    keys.push(key);
    // eslint-disable-next-line no-await-in-loop
    await WhatsappSpendDay.updateOne(
      key,
      { $set: { volume: row.volume, cost: row.cost, currency: row.currency, fetchedAt: new Date() } },
      { upsert: true }
    );
  }

  // Limpieza del rango: lo que ya no viene de Meta deja de existir aquí.
  const stale = { wabaId: fetched.wabaId, date: { $gte: from, $lte: to } };
  if (keys.length) {
    stale.$nor = keys.map((k) => ({
      date: k.date,
      country: k.country,
      pricingCategory: k.pricingCategory,
      pricingType: k.pricingType,
      tier: k.tier,
    }));
  }
  const removed = await WhatsappSpendDay.deleteMany(stale);

  return {
    ok: true,
    wabaId: fetched.wabaId,
    currency: fetched.currency,
    saved: fetched.rows.length,
    removed: removed.deletedCount || 0,
    hasCost: fetched.rows.some((r) => r.cost !== null),
  };
}

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE'];
const isFreeType = (t) => String(t || '').startsWith('FREE');

/** Suma vacía por categoría, para que la tabla tenga todas las columnas siempre. */
const emptyByCategory = () =>
  CATEGORIES.reduce((acc, c) => ({ ...acc, [c]: { cost: 0, volume: 0 } }), {});

/**
 * Lee de la base el gasto guardado y lo arma para la pantalla: totales, serie por
 * día, desglose por categoría y por país.
 */
async function readSpend({ from, to }) {
  const waba = await resolveWaba();
  const filter = { date: { $gte: from, $lte: to } };
  if (waba.ok) filter.wabaId = waba.wabaId;
  const rows = await WhatsappSpendDay.find(filter).lean();

  const dayMap = new Map();
  const byCategory = emptyByCategory();
  const byCountry = new Map();
  let cost = 0;
  let billedMessages = 0;
  let freeMessages = 0;
  let missingCost = 0; // filas con volumen cobrable pero sin costo informado
  let currency = 'USD';
  let lastFetchedAt = null;

  for (const r of rows) {
    currency = r.currency || currency;
    if (!lastFetchedAt || (r.fetchedAt && r.fetchedAt > lastFetchedAt)) lastFetchedAt = r.fetchedAt;

    const day = dayMap.get(r.date) || {
      date: r.date,
      cost: 0,
      volume: 0,
      freeVolume: 0,
      byCategory: emptyByCategory(),
    };
    const free = isFreeType(r.pricingType);
    const rowCost = r.cost === null || r.cost === undefined ? 0 : r.cost;
    if (r.cost === null && !free && r.volume > 0) missingCost += r.volume;

    day.cost += rowCost;
    if (free) day.freeVolume += r.volume;
    else day.volume += r.volume;
    if (day.byCategory[r.pricingCategory]) {
      day.byCategory[r.pricingCategory].cost += rowCost;
      day.byCategory[r.pricingCategory].volume += r.volume;
    }
    dayMap.set(r.date, day);

    cost += rowCost;
    if (free) freeMessages += r.volume;
    else billedMessages += r.volume;

    if (!byCategory[r.pricingCategory]) byCategory[r.pricingCategory] = { cost: 0, volume: 0 };
    byCategory[r.pricingCategory].cost += rowCost;
    byCategory[r.pricingCategory].volume += r.volume;

    const c = byCountry.get(r.country) || { country: r.country, cost: 0, volume: 0 };
    c.cost += rowCost;
    c.volume += r.volume;
    byCountry.set(r.country, c);
  }

  // Serie CONTINUA: los días sin gasto salen en 0 (si no, el gráfico miente sobre
  // la forma del gasto al saltarse los días sin envíos).
  const days = [];
  for (let ms = ecDayStartMs(from); ms <= ecDayStartMs(to); ms += DAY_MS) {
    const date = ecDate(ms);
    days.push(dayMap.get(date) || { date, cost: 0, volume: 0, freeVolume: 0, byCategory: emptyByCategory() });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    from,
    to,
    currency,
    configured: waba.ok,
    notConfigured: waba.ok ? '' : waba.error,
    lastFetchedAt,
    totals: {
      cost: round2(cost),
      billedMessages,
      freeMessages,
      avgPerMessage: billedMessages ? round2(cost / billedMessages) : 0,
      // Mensajes que Meta contó como cobrables pero de los que NO informó importe
      // (facturación por socio): el total mostrado se queda corto y hay que decirlo.
      messagesWithoutCost: missingCost,
    },
    days: days.map((d) => ({ ...d, cost: round2(d.cost) })),
    byCategory: Object.entries(byCategory)
      .map(([category, v]) => ({ category, cost: round2(v.cost), volume: v.volume }))
      .filter((c) => c.volume > 0 || c.cost > 0)
      .sort((a, b) => b.cost - a.cost || b.volume - a.volume),
    byCountry: [...byCountry.values()]
      .map((c) => ({ ...c, cost: round2(c.cost) }))
      .sort((a, b) => b.cost - a.cost),
  };
}

/**
 * Mensajes de plantilla que ENVIÓ el sistema en el rango, agrupados por plantilla,
 * con la categoría que Meta usó para cobrarlos (`Message.billing`, tal cual la
 * informó el webhook). Es el "quién generó el gasto" que Meta no da: su API no
 * tiene dimensión por plantilla. Son mensajes, no dinero.
 */
async function readByTemplate({ clinicId, from, to }) {
  const Message = require('../models/Message');
  const start = new Date(ecDayStartMs(from));
  const end = new Date(ecDayStartMs(to) + DAY_MS);
  const rows = await Message.aggregate([
    {
      $match: {
        clinic: clinicId,
        direction: 'out',
        templateName: { $ne: '' },
        createdAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: { template: '$templateName', category: { $ifNull: ['$billing.category', ''] } },
        messages: { $sum: 1 },
        billed: { $sum: { $cond: [{ $eq: ['$billing.billable', true] }, 1, 0] } },
        free: { $sum: { $cond: [{ $eq: ['$billing.billable', false] }, 1, 0] } },
      },
    },
    { $sort: { messages: -1 } },
    { $limit: 100 },
  ]);
  return rows.map((r) => ({
    template: r._id.template,
    category: r._id.category || '',
    messages: r.messages,
    billed: r.billed,
    free: r.free,
  }));
}

module.exports = {
  fetchSpendFromMeta,
  syncSpend,
  readSpend,
  readByTemplate,
  resolveWaba,
  ecDate,
  ecDayStartMs,
  todayEc,
};
