const CardSettlement = require('../models/CardSettlement');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const ChartOfAccount = require('../models/ChartOfAccount');
const Counter = require('../models/Counter');
const RetentionRule = require('../models/RetentionRule');
const Sale = require('../models/Sale');
const CreditCardBatch = require('../models/CreditCardBatch');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N } = require('../utils/idempotency');
const voucherIdentity = require('../utils/cardVoucherIdentity');

const round = (n) => +(Number(n) || 0).toFixed(2);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RET_TYPES = ['RENTA', 'IVA'];

async function syncBatchStatus(batchId, clinicId, session) {
  if (!batchId) return;
  const batch = await CreditCardBatch.findOne({ _id: batchId, clinic: clinicId }).session(session);
  if (!batch || batch.status === 'ANULADO' || batch.journalEntry) return;
  const settlements = await CardSettlement.find({
    clinic: clinicId, batch: batch._id, status: 'CONTABILIZADO',
  }).select('totalDeposit').session(session);
  const settled = round(settlements.reduce((sum, item) => sum + Number(item.totalDeposit || 0), 0));
  batch.settledAmount = settled;
  batch.status = settled <= 0.005 ? 'ABIERTO'
    : settled < Number(batch.grossAmount || 0) - 0.01 ? 'PARCIAL'
      : settled > Number(batch.grossAmount || 0) + 0.01 ? 'SOBRANTE' : 'LIQUIDADO';
  await batch.save({ session });
}

async function validateSourceSales(settlement, clinicId, session) {
  const sources = settlement.sourceSales || [];
  const ids = [...new Set(sources.map((item) => String(item.sale || '')).filter(Boolean))];
  if (sources.some((item) => !item.sale || Number.isNaN(voucherIdentity.paymentIndex(item.paymentIndex))) ||
      sources.some((item, i) => sources.slice(i + 1).some((other) => voucherIdentity.conflicts(item, other)))) {
    throw Object.assign(new Error('Cada voucher de origen debe estar identificado una sola vez'), { status: 409, code: 'CARD_SOURCE_DUPLICATE' });
  }
  if (settlement.batch) {
    const batch = await CreditCardBatch.findOne({ _id: settlement.batch, clinic: clinicId }).session(session);
    if (!batch || batch.status === 'ANULADO' || batch.journalEntry) {
      throw Object.assign(new Error('El lote no está disponible para recibir esta liquidación'), { status: 409, code: 'CARD_BATCH_UNAVAILABLE' });
    }
    const batchVouchers = (batch.vouchers || []).filter((v) => v.sale);
    if (sources.some((item) => !batchVouchers.some((v) => voucherIdentity.conflicts(item, v)))) {
      throw Object.assign(new Error('Las ventas de la liquidación deben pertenecer al lote'), { status: 409, code: 'CARD_BATCH_SOURCES' });
    }
    const sourceTotal = round(sources.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    if (sources.length && Math.abs(sourceTotal - settlement.totalDeposit) > 0.01) {
      throw Object.assign(new Error('El bruto de las ventas seleccionadas no coincide con la liquidación'), { status: 409, code: 'CARD_BATCH_AMOUNT' });
    }
    for (const item of sources) {
      const voucher = batchVouchers.find((v) => voucherIdentity.conflicts(item, v));
      if (Math.abs(Number(item.amount || 0) - Number(voucher.grossAmount || 0)) > 0.01) {
        throw Object.assign(new Error('El importe de una venta no coincide con su voucher del lote'), { status: 409, code: 'CARD_VOUCHER_AMOUNT' });
      }
    }
    const posted = await CardSettlement.find({ clinic: clinicId, batch: batch._id, status: 'CONTABILIZADO' })
      .select('totalDeposit sourceSales').session(session);
    const already = round(posted.reduce((sum, item) => sum + Number(item.totalDeposit || 0), 0));
    if (!sources.length) {
      const manualGross = round((batch.vouchers || []).filter((v) => !v.sale)
        .reduce((sum, v) => sum + Number(v.grossAmount || 0), 0));
      const manualPosted = round(posted.filter((item) => !(item.sourceSales || []).length)
        .reduce((sum, item) => sum + Number(item.totalDeposit || 0), 0));
      if (settlement.totalDeposit > manualGross - manualPosted + 0.01) {
        throw Object.assign(new Error('La liquidación sin ventas identificadas supera los vouchers manuales pendientes del lote'), { status: 409, code: 'CARD_MANUAL_OVERPAID' });
      }
    }
    if (already + settlement.totalDeposit > Number(batch.grossAmount || 0) + 0.01) {
      throw Object.assign(new Error('La liquidación supera el bruto pendiente del lote'), { status: 409, code: 'CARD_BATCH_OVERPAID' });
    }
  }
  if (!sources.length) return;
  const owningBatches = await CreditCardBatch.find({
    clinic: clinicId, status: { $ne: 'ANULADO' }, 'vouchers.sale': { $in: ids },
  }).select('code vouchers').session(session);
  const owningBatch = owningBatches.find((batch) => batch.vouchers.some((voucher) =>
    sources.some((source) => voucherIdentity.conflicts(source, voucher)) &&
    String(batch._id) !== String(settlement.batch || '')));
  if (owningBatch && String(owningBatch._id) !== String(settlement.batch || '')) {
    throw Object.assign(new Error(`Una venta pertenece al lote ${owningBatch.code}; liquídala desde ese lote`), { status: 409, code: 'CARD_BATCH_REQUIRED' });
  }
  const sales = await Sale.find({ _id: { $in: ids }, clinic: clinicId, status: 'completada' })
    .select('paymentMethod payments total').session(session);
  if (sales.length !== ids.length) {
    throw Object.assign(new Error('Una venta de origen no existe o no está completada en esta clínica'), { status: 409, code: 'CARD_SOURCE_INVALID' });
  }
  const saleById = new Map(sales.map((sale) => [String(sale._id), sale]));
  for (const item of sources) {
    const sale = saleById.get(String(item.sale));
    const cards = (sale.payments || []).map((p, index) => ({ method: p.method, amount: p.amount, index }))
      .filter((p) => p.method === 'tarjeta');
    const index = voucherIdentity.paymentIndex(item.paymentIndex);
    if (cards.length > 1 && index === null) {
      throw Object.assign(new Error('Indica el renglón de pago de tarjeta de esta venta'), { status: 409, code: 'CARD_MULTI_VOUCHER_REVIEW' });
    }
    const card = index !== null ? cards.find((p) => p.index === index) : cards[0];
    const cardAmount = card ? Number(card.amount || 0)
      : !cards.length && index === null && sale.paymentMethod === 'tarjeta' ? Number(sale.total || 0) : 0;
    if (cardAmount <= 0 || Math.abs(Number(item.amount || 0) - cardAmount) > 0.01) {
      throw Object.assign(new Error('Una venta no tiene un cobro con tarjeta por el importe indicado'), { status: 409, code: 'CARD_SOURCE_AMOUNT' });
    }
  }
  const others = await CardSettlement.find({
    clinic: clinicId, _id: { $ne: settlement._id }, status: 'CONTABILIZADO',
    'sourceSales.sale': { $in: ids },
  }).select('code sourceSales').session(session);
  const other = others.find((s) => s.sourceSales.some((used) => sources.some((item) => voucherIdentity.conflicts(item, used))));
  if (other) throw Object.assign(new Error(`Una venta ya figura en la liquidación ${other.code}`), { status: 409, code: 'CARD_SOURCE_ALREADY_SETTLED' });
}

/**
 * Expresión con la que se busca un N° de lote del POS.
 *
 * El voucher imprime el lote con ceros a la izquierda ("0457") y el cajero lo digita como
 * puede ("457"): una coincidencia exacta anclada dejaba la búsqueda VACÍA por un cero. Por eso:
 *   · si el lote es numérico se ignoran los ceros de la izquierda en AMBOS lados;
 *   · si no lo es (lotes con letras) se busca por contenido, sin distinguir mayúsculas.
 */
function loteRegex(lote) {
  const raw = String(lote).trim();
  if (/^\d+$/.test(raw)) {
    const sinCeros = raw.replace(/^0+/, '') || '0';
    return new RegExp(`^0*${escapeRegex(sinCeros)}$`);
  }
  return new RegExp(escapeRegex(raw), 'i');
}

/**
 * Busca ventas pagadas con tarjeta para cargarlas en una liquidación.
 * Filtra por N° de lote y/o rango de fechas (y opcionalmente POS / tarjeta).
 * Por defecto excluye las ventas ya incluidas en otra liquidación no anulada
 * para evitar liquidar dos veces la misma factura.
 *
 * El lote se busca TANTO en la cabecera de la venta como en cada renglón de pago: con pago
 * dividido (dos tarjetas en una misma venta) solo el lote del PRIMER renglón sube a la
 * cabecera, y buscar únicamente ahí escondía la venta del segundo lote.
 */
exports.searchCardSales = async (req, res) => {
  try {
    const { lote, from, to, cardPos, creditCard, includeSettled, forBatch } = req.query;
    // Incluye ventas pagadas con tarjeta, sea pago único (paymentMethod) o dividido
    // (un renglón de `payments` con method 'tarjeta').
    const and = [{ $or: [{ paymentMethod: 'tarjeta' }, { 'payments.method': 'tarjeta' }] }];
    const filter = { clinic: req.clinicId, status: 'completada' };
    if (lote && lote.trim()) {
      const rx = loteRegex(lote);
      and.push({ $or: [{ cardLote: rx }, { 'payments.cardLote': rx }] });
    }
    if (cardPos) and.push({ $or: [{ cardPos }, { 'payments.cardPos': cardPos }] });
    if (creditCard) and.push({ $or: [{ creditCard }, { 'payments.creditCard': creditCard }] });
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(`${from}T00:00:00.000`);
      if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999`);
    }
    let usedVouchers = [];
    if (!includeSettled || includeSettled === 'false') {
      const settled = await CardSettlement.find({ clinic: req.clinicId, status: 'CONTABILIZADO' })
        .select('sourceSales').lean();
      usedVouchers = settled.flatMap((s) => s.sourceSales || []);
      if (forBatch === 'true' || forBatch === true) {
        const batches = await CreditCardBatch.find({ clinic: req.clinicId, status: { $ne: 'ANULADO' } })
          .select('vouchers').lean();
        usedVouchers.push(...batches.flatMap((b) => b.vouchers || []));
      }
    }
    filter.$and = and;
    const sales = await Sale.find(filter)
      // Se devuelve el desglose de impuestos para poder proponer las bases (gravada / 0%) de
      // la transacción sin que la contadora las vuelva a sumar a mano.
      .select('saleNumber clientName total createdAt cardLote cardVoucher cardPos creditCard invoice payments taxableSubtotal subtotal0 subtotalExento subtotalNoObjeto taxAmount')
      .populate('creditCard', 'name brand')
      .populate('payments.creditCard', 'name brand')
      .sort({ createdAt: 1 })
      .limit(500);
    const rows = [];
    for (const sale of sales) {
      const parts = (sale.payments || []).map((p, index) => ({ payment: p, index }))
        .filter(({ payment }) => payment.method === 'tarjeta');
      // La cabecera conserva los datos de la primera tarjeta. Solo sirve de respaldo
      // cuando hay un unico pago con tarjeta y el renglon historico esta incompleto.
      const matches = (payment, field, expected, match) => !expected ||
        match(payment?.[field] || (parts.length === 1 ? sale[field] : null), expected);
      const selected = parts.filter(({ payment }) =>
        matches(payment, 'cardLote', lote?.trim(), (value, search) => loteRegex(search).test(value || '')) &&
        matches(payment, 'cardPos', cardPos, (value, search) => value === search) &&
        matches(payment, 'creditCard', creditCard, (value, search) => String(value?._id || value || '') === String(search)));
      const candidates = parts.length ? selected
        : sale.paymentMethod === 'tarjeta' &&
          (!lote?.trim() || loteRegex(lote).test(sale.cardLote || '')) &&
          (!cardPos || sale.cardPos === cardPos) &&
          (!creditCard || String(sale.creditCard?._id || sale.creditCard || '') === String(creditCard))
          ? [{ payment: null, index: null }] : [];
      for (const { payment, index } of candidates) {
        const item = { sale: sale._id, paymentIndex: index };
        if (usedVouchers.some((used) => voucherIdentity.conflicts(item, used))) continue;
        const cardAmount = payment ? round(payment.amount) : round(sale.total);
        if (cardAmount <= 0) continue;
        rows.push({ ...sale.toObject(), cardAmount, cardPaymentCount: parts.length || 1,
          paymentIndex: index, paymentKey: voucherIdentity.key(item),
          cardLote: payment?.cardLote || (parts.length <= 1 ? sale.cardLote : ''),
          cardVoucher: payment?.cardVoucher || (parts.length <= 1 ? sale.cardVoucher : ''),
          cardBrand: payment?.cardBrandSnapshot || '',
          cardPos: payment?.cardPos || (parts.length <= 1 ? sale.cardPos : ''),
          creditCard: payment?.creditCard || (parts.length <= 1 ? sale.creditCard : null) });
      }
    }
    res.json(rows);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Código secuencial ATÓMICO de la liquidación. Antes se usaba `countDocuments() + 1`, que con
 * dos peticiones a la vez daba el MISMO código a las dos (y tras eliminar un borrador volvía a
 * emitir un código ya usado). El contador se siembra desde la última liquidación del año para
 * no reiniciar la numeración en las clínicas que ya tienen liquidaciones.
 */
async function nextSettlementCode(clinicId, session) {
  const year = new Date().getFullYear();
  const key = `card-settlement-${year}`;
  const prefix = `LIQ-${year}-`;
  const existing = await Counter.findOne({ clinic: clinicId, key }).session(session || null);
  if (!existing) {
    const last = await CardSettlement.findOne({ clinic: clinicId, code: new RegExp(`^${prefix}`) })
      .sort({ code: -1 }).select('code').session(session || null);
    const start = last ? (parseInt(String(last.code).match(/(\d+)$/)?.[1] || '0', 10) || 0) : 0;
    try { await Counter.create([{ clinic: clinicId, key, seq: start }], { session: session || undefined }); }
    catch (e) { if (e.code !== 11000) throw e; }
  }
  const updated = await Counter.findOneAndUpdate(
    { clinic: clinicId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session: session || undefined }
  );
  return `${prefix}${String(updated.seq).padStart(5, '0')}`;
}

/** Catálogo de reglas ACTIVAS de la clínica, indexado por `TIPO|codigo` (la más reciente gana). */
async function loadRetentionRules(clinicId, session) {
  const rules = await RetentionRule.find({ clinic: clinicId, active: true })
    .sort({ createdAt: 1 }).session(session || null).lean();
  const map = new Map();
  for (const r of rules) map.set(`${r.type}|${r.code}`, r); // el último (más reciente) prevalece
  return map;
}

/**
 * Deriva las filas de retención SOLAS a partir de las bases digitadas en las transacciones y
 * recalcula todos los totales. Elimina la digitación manual: el contador solo pone las bases
 * (baseRetIr / baseRetIva) por transacción y, en cada fila de retención, escoge el código SRI.
 *
 * Reglas (fuente única, se aplican al guardar Y al acreditar):
 *   · base de la fila RENTA = Σ baseRetIr de las transacciones; base de la fila IVA = Σ baseRetIva.
 *   · si una base es 0 su fila NO existe; si es > 0 la fila existe (se crea/actualiza sola).
 *   · el % SIEMPRE proviene de la RetentionRule del código elegido (nunca se digita); el valor
 *     es base × % / 100. El % guardado es el SNAPSHOT con el que se calculó: si la regla ya no
 *     existe (se borró/versionó) se conserva el % previo en vez de perderlo.
 *   · a pagar por transacción = deposito - comisión - iva (las retenciones se aplican al neto).
 */
async function recomputeSettlement(doc, clinicId, session) {
  let totalDeposit = 0, totalCommission = 0, totalIva = 0, totalToPay = 0;
  let totalBaseConIva = 0, totalBaseSinIva = 0;
  const baseByType = { RENTA: 0, IVA: 0 };
  (doc.transactions || []).forEach((t) => {
    const deposit = Number(t.deposit) || 0;
    const commission = Number(t.commission) || 0;
    const iva = Number(t.iva) || 0;
    t.toPay = round(deposit - commission - iva);
    totalDeposit += deposit;
    totalCommission += commission;
    totalIva += iva;
    totalToPay += t.toPay;
    totalBaseConIva += Number(t.baseConIva) || 0;
    totalBaseSinIva += Number(t.baseSinIva) || 0;
    baseByType.RENTA += Number(t.baseRetIr) || 0;
    baseByType.IVA += Number(t.baseRetIva) || 0;
  });
  baseByType.RENTA = round(baseByType.RENTA);
  baseByType.IVA = round(baseByType.IVA);

  const rules = await loadRetentionRules(clinicId, session);
  const prevByType = new Map((doc.retentions || []).map((r) => [r.type, r]));
  const rows = [];
  for (const type of RET_TYPES) {
    const base = baseByType[type];
    if (base <= 0) continue; // base 0 → la fila desaparece
    const prev = prevByType.get(type);
    const sriCode = (prev?.sriCode || '').trim();
    let percentage = Number(prev?.percentage) || 0; // snapshot previo
    if (sriCode) {
      const rule = rules.get(`${type}|${sriCode}`);
      if (rule) percentage = Number(rule.rate) || 0; // el % manda desde la regla
    }
    const row = {
      issueDate: prev?.issueDate || doc.issueDate || null,
      retentionNumber: prev?.retentionNumber || '',
      authorization: prev?.authorization || '',
      type,
      sriCode,
      base,
      percentage: round(percentage),
      value: round(base * percentage / 100),
    };
    if (prev?._id) row._id = prev._id; // conserva el id del subdocumento
    rows.push(row);
  }
  doc.retentions = rows;

  const rentaRow = rows.find((r) => r.type === 'RENTA');
  const ivaRow = rows.find((r) => r.type === 'IVA');
  doc.totalDeposit = round(totalDeposit);
  doc.totalBaseConIva = round(totalBaseConIva);
  doc.totalBaseSinIva = round(totalBaseSinIva);
  doc.totalCommission = round(totalCommission);
  doc.totalIva = round(totalIva);
  doc.totalRetIr = round(rentaRow?.value || 0);
  doc.totalRetIva = round(ivaRow?.value || 0);
  doc.totalToPay = round(totalToPay);
}

/**
 * Verifica que cada fila de retención tenga un código SRI válido con % determinado. Devuelve la
 * lista de problemas (vacía si todo está bien). Se usa al guardar y al acreditar.
 */
function retentionProblems(doc) {
  const problemas = [];
  for (const r of doc.retentions || []) {
    const etiqueta = r.type === 'IVA' ? 'IVA' : 'renta';
    if (!String(r.sriCode || '').trim()) {
      problemas.push(`Falta el código SRI de la retención de ${etiqueta} (base ${round(r.base)}).`);
    } else if (round(r.percentage) <= 0) {
      problemas.push(`El código ${r.sriCode} no corresponde a una regla de retención de ${etiqueta} activa: no se pudo determinar el porcentaje.`);
    }
  }
  return problemas;
}

/**
 * Coherencia del desglose del depósito: la base gravada más la base 0% no pueden superar lo
 * acreditado (la diferencia con el depósito es el IVA que pagó el cliente). Se avisa por
 * transacción para que la contadora sepa cuál cuadrar, y solo cuando ambas están digitadas.
 */
function baseProblems(doc) {
  const problemas = [];
  (doc.transactions || []).forEach((t, i) => {
    const bases = round((Number(t.baseConIva) || 0) + (Number(t.baseSinIva) || 0));
    const deposit = round(Number(t.deposit) || 0);
    if (bases > 0 && bases > deposit + 0.01) {
      const etiqueta = t.recap ? `#${t.recap}` : `${i + 1}`;
      problemas.push(`En la transacción ${etiqueta} la base con IVA + la base sin IVA ($${bases}) supera el depósito ($${deposit}).`);
    }
  });
  return problemas;
}

/** Resuelve una cuenta: usa la seleccionada, o el rol del mapa de cuentas configurable. */
async function resolveAccount(clinicId, selectedId, role, session) {
  if (selectedId) {
    const acc = await ChartOfAccount.findOne({ _id: selectedId, clinic: clinicId }).session(session || null);
    if (acc) return acc;
  }
  return getAccount(clinicId, role, { session });
}

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  const items = await CardSettlement.find(filter)
    .populate('supplier', 'razonSocial nombreComercial')
    .populate('bankAccount', 'name')
    .sort({ issueDate: -1, createdAt: -1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('supplier', 'razonSocial nombreComercial ruc')
    .populate('bankAccount', 'name')
    .populate('transactions.account', 'code name')
    .populate('transactions.costCenter', 'code name');
  if (!s) return res.status(404).json({ message: 'No encontrada' });
  res.json(s);
};

/**
 * Crea la liquidación. IDEMPOTENTE por `Idempotency-Key`: el doble clic (o el reintento de red
 * tras un timeout) devuelve la liquidación ya creada en vez de registrar una segunda con las
 * mismas transacciones. Misma clave con OTRO contenido → 409, nunca se pisan datos.
 */
exports.create = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  const b = req.body || {};
  const idemFingerprint = fingerprint({
    op: 'cardSettlement.create',
    issueDate: N.date(b.issueDate),
    docType: b.docType || null,
    docNumber: b.docNumber || null,
    supplier: N.id(b.supplier),
    bankAccount: N.id(b.bankAccount),
    batch: N.id(b.batch),
    sourceSales: (b.sourceSales || []).map((item) => ({
      sale: N.id(item.sale), paymentIndex: voucherIdentity.paymentIndex(item.paymentIndex), amount: N.num(item.amount),
      lote: item.lote || '', voucher: item.voucher || '',
    })),
    transactions: (b.transactions || []).map((t) => ({
      recap: t.recap || null,
      date: N.date(t.date),
      deposit: N.num(t.deposit),
      commission: N.num(t.commission),
      iva: N.num(t.iva),
      baseConIva: N.num(t.baseConIva),
      baseSinIva: N.num(t.baseSinIva),
      baseRetIr: N.num(t.baseRetIr),
      baseRetIva: N.num(t.baseRetIva),
    })),
  });
  try {
    if (idemKey) {
      const previa = await CardSettlement.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previa) {
        assertSameFingerprint(previa.idempotencyFingerprint, idemFingerprint, 'liquidación de tarjeta');
        return res.json({ ...previa.toObject(), idempotentReplay: true });
      }
    }
    const code = await nextSettlementCode(req.clinicId);
    const s = new CardSettlement({
      ...req.body, clinic: req.clinicId, code, createdBy: req.user._id,
      idempotencyKey: idemKey,
      idempotencyFingerprint: idemKey ? idemFingerprint : null,
    });
    await recomputeSettlement(s, req.clinicId);
    await validateSourceSales(s, req.clinicId);
    const problemas = [...baseProblems(s), ...retentionProblems(s)];
    if (problemas.length) return res.status(400).json({ message: problemas.join(' ') });
    await s.save();
    res.status(201).json(s);
  } catch (e) {
    // Carrera real: dos peticiones simultáneas con la misma clave. La que pierde el índice
    // único devuelve la que ganó, en vez de un error que el usuario leería como "no se guardó".
    if (e.code === 11000 && idemKey) {
      const previa = await CardSettlement.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previa) {
        try { assertSameFingerprint(previa.idempotencyFingerprint, idemFingerprint, 'liquidación de tarjeta'); }
        catch (c) { return res.status(409).json({ message: c.message }); }
        return res.json({ ...previa.toObject(), idempotentReplay: true });
      }
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrada' });
    if (s.status !== 'BORRADOR') return res.status(400).json({ message: 'Solo se editan liquidaciones en BORRADOR' });
    const { code, status, journalEntry, bankTransaction, clinic, idempotencyKey, idempotencyFingerprint, ...rest } = req.body;
    Object.assign(s, rest);
    await recomputeSettlement(s, req.clinicId);
    await validateSourceSales(s, req.clinicId);
    const problemas = [...baseProblems(s), ...retentionProblems(s)];
    if (problemas.length) return res.status(400).json({ message: problemas.join(' ') });
    await s.save();
    res.json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Acredita / contabiliza la liquidación: registra el depósito neto en el banco,
 * la comisión (con centro de costo por transacción), el IVA de la comisión, las
 * retenciones por cobrar y cancela las tarjetas por cobrar.
 */
exports.accredit = async (req, res) => {
  try {
    {
      const settlementId = await runInTransaction(async (session) => {
        const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!s) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (s.status !== 'BORRADOR') throw Object.assign(new Error('No esta en BORRADOR'), { status: 400 });
        if (!s.bankAccount) throw Object.assign(new Error('Selecciona el banco donde se acredita'), { status: 400 });

        await recomputeSettlement(s, req.clinicId, session);
        await validateSourceSales(s, req.clinicId, session);
        const problemas = retentionProblems(s);
        if (problemas.length) throw Object.assign(new Error(problemas.join(' ')), { status: 400 });
        const accreditedAt = req.body.accreditedAt ? new Date(req.body.accreditedAt) : (s.issueDate || new Date());
        await assertPeriodOpen(req.clinicId, accreditedAt, { session });
        const bank = await BankAccount.findOne({ _id: s.bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        const bankAcc = await ChartOfAccount.findOne({ _id: bank.chartAccount, clinic: req.clinicId }).session(session);
        if (!bankAcc) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });

        const receivable = await resolveAccount(req.clinicId, s.receivableAccount, 'tarjetasPorLiquidar', session);
        const commissionAcc = await resolveAccount(req.clinicId, s.commissionAccount, 'comisionTarjeta', session);
        const ivaAcc = s.totalIva > 0 ? await resolveAccount(req.clinicId, s.ivaAccount, 'ivaCompras', session) : null;
        const retIvaAcc = s.totalRetIva > 0 ? await resolveAccount(req.clinicId, s.retIvaAccount, 'retIvaPorCobrar', session) : null;
        const retIrAcc = s.totalRetIr > 0 ? await resolveAccount(req.clinicId, s.retIrAccount, 'retRentaPorCobrar', session) : null;

        // El neto a banco resta AMBAS retenciones: el "a pagar" por transacción ya no incluye la
        // retención de IVA (que ahora se calcula a nivel de la fila de retención, no por línea).
        const netToBank = round(s.totalToPay - s.totalRetIr - s.totalRetIva);
        const lines = [];
        if (netToBank > 0) lines.push({ account: bankAcc._id, debit: netToBank, credit: 0, description: `Acreditacion liquidacion ${s.code}` });
        (s.transactions || []).forEach((t) => {
          if ((Number(t.commission) || 0) > 0) {
            lines.push({
              account: commissionAcc._id,
              costCenter: t.costCenter || null,
              debit: round(t.commission),
              credit: 0,
              description: `Comision tarjeta ${t.recap ? '#' + t.recap : ''}`.trim(),
            });
          }
        });
        if (s.totalIva > 0 && ivaAcc) lines.push({ account: ivaAcc._id, debit: s.totalIva, credit: 0, description: 'IVA comision' });
        if (s.totalRetIva > 0 && retIvaAcc) lines.push({ account: retIvaAcc._id, debit: s.totalRetIva, credit: 0, description: 'Retencion IVA por cobrar' });
        if (s.totalRetIr > 0 && retIrAcc) lines.push({ account: retIrAcc._id, debit: s.totalRetIr, credit: 0, description: 'Retencion IR por cobrar' });
        if (s.totalDeposit > 0) lines.push({ account: receivable._id, debit: 0, credit: s.totalDeposit, description: 'Cancelacion tarjetas por cobrar' });

        const [bt] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: accreditedAt,
          type: 'DEPOSITO',
          amount: netToBank,
          direction: 1,
          description: `Liquidacion tarjetas ${s.code}`,
          reference: s.docNumber || s.code,
          sourceModel: 'CardSettlement',
          sourceRef: s._id,
          createdBy: req.user._id,
        }], { session });
        const entry = await createEntry({
          clinicId: req.clinicId,
          date: accreditedAt,
          description: `Liquidacion tarjetas ${s.code}`,
          source: 'TARJETA',
          sourceRef: s._id,
          sourceModel: 'CardSettlement',
          sourceAction: 'ACCREDIT',
          lines,
          userId: req.user._id,
          session,
        });
        bt.journalEntry = entry._id;
        await bt.save({ session });
        s.status = 'CONTABILIZADO';
        s.accreditedAt = accreditedAt;
        s.journalEntry = entry._id;
        s.bankTransaction = bt._id;
        await s.save({ session });
        await syncBatchStatus(s.batch, req.clinicId, session);
        const saleIds = (s.sourceSales || []).map((x) => x.sale).filter(Boolean);
        if (saleIds.length) {
          await Sale.updateMany(
            { _id: { $in: saleIds }, clinic: req.clinicId },
            { cardSettlement: s._id },
            { session }
          );
        }
        return s._id;
      });
      const settlement = await CardSettlement.findById(settlementId);
      return res.json(settlement);
    }
  } catch (e) {
    if (e.code === 11000 && e.keyPattern?.['sourceSales.sale']) {
      return res.status(409).json({ code: 'CARD_SOURCE_ALREADY_SETTLED', message: 'Este voucher ya se acreditó en otra liquidación' });
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.cancel = async (req, res) => {
  try {
    {
      const settlementId = await runInTransaction(async (session) => {
        const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!s) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (s.status === 'ANULADO') throw Object.assign(new Error('Ya esta anulada'), { status: 400 });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });
        if (s.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: s.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion liquidacion tarjeta',
            date: reversalDate,
            session,
          });
        }
        if (s.bankTransaction) {
          const tx = await BankTransaction.findById(s.bankTransaction).session(session);
          if (tx && !tx.voided) {
            if (tx.reconciled) throw Object.assign(new Error('El depósito de la liquidación está conciliado: reabre la conciliación antes de anularla'), { status: 409, code: 'BANK_RECONCILED' });
            tx.voided = true;
            tx.voidedAt = reversalDate;
            tx.voidedBy = req.user._id;
            tx.voidReason = req.body?.reason || 'Anulacion liquidacion tarjeta';
            await tx.save({ session });
            await BankAccount.updateOne(
              { _id: tx.bankAccount },
              { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
              { session }
            );
          }
        }
        s.status = 'ANULADO';
        await s.save({ session });
        await syncBatchStatus(s.batch, req.clinicId, session);
        const saleIds = (s.sourceSales || []).map((x) => x.sale).filter(Boolean);
        if (saleIds.length) {
          for (const saleId of new Set(saleIds.map(String))) {
            const other = await CardSettlement.findOne({ clinic: req.clinicId, status: 'CONTABILIZADO',
              'sourceSales.sale': saleId }).sort({ accreditedAt: -1 }).select('_id').session(session);
            await Sale.updateOne({ _id: saleId, clinic: req.clinicId, cardSettlement: s._id },
              { cardSettlement: other?._id || null }, { session });
          }
        }
        return s._id;
      });
      const settlement = await CardSettlement.findById(settlementId);
      return res.json(settlement);
    }
  } catch (e) { res.status(e.status || 400).json({ code: e.code, message: e.message }); }
};

exports.remove = async (req, res) => {
  try {
    const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrada' });
    if (s.status === 'CONTABILIZADO') return res.status(400).json({ message: 'Anula la liquidación antes de eliminarla' });
    await s.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
