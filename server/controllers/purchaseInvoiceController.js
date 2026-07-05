const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const RecurringAccount = require('../models/RecurringAccount');
const FixedAsset = require('../models/FixedAsset');
const InventoryCategory = require('../models/InventoryCategory');
const RetentionRule = require('../models/RetentionRule');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, voidPayable } = require('../utils/subledger');
const kardex = require('../utils/kardex');
const { parsePurchaseInvoiceXml } = require('../utils/sriXmlParser');
const { computeRetention, groupLineRetentions } = require('../utils/retentionCalculator');

/**
 * Memoriza las cuentas de gasto usadas en una compra como "cuentas recurrentes"
 * (a nivel clínica y por proveedor) e incrementa su contador de uso. También deja
 * la última cuenta como `defaultExpenseAccount` del proveedor.
 */
async function rememberRecurringAccounts(inv, session) {
  const accountIds = new Set();
  // Solo se memorizan cuentas de líneas GASTO: las cuentas de INVENTARIO/ACTIVO_FIJO
  // provienen de la categoría (no son "cuentas de gasto recurrentes" del proveedor).
  for (const it of inv.items || []) {
    if (it.lineType && it.lineType !== 'GASTO') continue;
    if (it.account) accountIds.add(String(it.account));
    for (const sp of it.accountSplits || []) if (sp.account) accountIds.add(String(sp.account));
  }
  if (!accountIds.size) return;
  for (const accId of accountIds) {
    for (const supplier of [null, inv.supplier]) {
      await RecurringAccount.updateOne(
        { clinic: inv.clinic, supplier: supplier || null, account: accId },
        { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
        { upsert: true, session }
      );
    }
  }
  // Recuerda la última cuenta como predeterminada del proveedor para la próxima compra.
  const last = [...accountIds][accountIds.size - 1];
  await Supplier.updateOne({ _id: inv.supplier, clinic: inv.clinic }, { defaultExpenseAccount: last }, { session });
}

/**
 * Cuentas recurrentes para sugerir en el formulario de compra: la predeterminada del
 * proveedor + las más usadas (por proveedor y a nivel clínica). GET ?supplier=
 */
exports.recurringAccounts = async (req, res) => {
  try {
    const { supplier } = req.query;
    const orFilter = [{ clinic: req.clinicId, supplier: null }];
    if (supplier) orFilter.push({ clinic: req.clinicId, supplier });
    const recs = await RecurringAccount.find({ $or: orFilter })
      .populate('account', 'code name allowsMovement')
      .sort({ useCount: -1, lastUsedAt: -1 })
      .limit(40);
    // Deduplica por cuenta priorizando las del proveedor / más usadas.
    const seen = new Set();
    const out = [];
    for (const r of recs) {
      if (!r.account || !r.account.allowsMovement) continue;
      const key = String(r.account._id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ _id: r.account._id, code: r.account.code, name: r.account.name, useCount: r.useCount, forSupplier: !!r.supplier });
    }
    let defaultAccount = null;
    if (supplier) {
      const sup = await Supplier.findOne({ _id: supplier, clinic: req.clinicId }).populate('defaultExpenseAccount', 'code name');
      if (sup?.defaultExpenseAccount) defaultAccount = { _id: sup.defaultExpenseAccount._id, code: sup.defaultExpenseAccount.code, name: sup.defaultExpenseAccount.name };
    }
    res.json({ defaultAccount, accounts: out.slice(0, 12) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Abre el documento de cuentas por pagar (CxP) de una compra: el saldo a pagar
 * al proveedor es el total menos las retenciones. Idempotente por la factura.
 */
async function openPayableForInvoice(inv, sup, req, session) {
  const payable = +(Number(inv.total || 0) - Number(inv.retentionTotal || 0)).toFixed(2);
  if (payable <= 0) return;
  const provAcc = sup?.defaultPayableAccount
    ? sup.defaultPayableAccount
    : (await getAccount(req.clinicId, 'proveedores', { session }))._id;
  await openPayable({
    clinic: req.clinicId,
    party: { model: 'Supplier', ref: inv.supplier, name: sup?.razonSocial || sup?.name || '' },
    sourceModel: 'PurchaseInvoice',
    sourceRef: inv._id,
    docType: 'COMPRA',
    number: inv.serie || '',
    issueDate: inv.fechaEmision || new Date(),
    total: payable,
    account: provAcc,
  }, { session });
}

function calcTotals(invoice) {
  let s0 = 0, s12 = 0, s15 = 0, sNo = 0, sEx = 0, iva = 0;
  for (const it of invoice.items || []) {
    const base = (it.quantity || 1) * (it.unitPrice || 0) - (it.discount || 0);
    it.subtotal = base;
    if (it.ivaRate === 0) s0 += base;
    else if (it.ivaRate === 12) { s12 += base; it.ivaAmount = base * 0.12; iva += it.ivaAmount; }
    else if (it.ivaRate === 15) { s15 += base; it.ivaAmount = base * 0.15; iva += it.ivaAmount; }
    else if (it.ivaRate === -1) sNo += base;
    else if (it.ivaRate === -2) sEx += base;
    else { it.ivaAmount = base * (it.ivaRate / 100); iva += it.ivaAmount; }
  }
  invoice.subtotal0 = s0;
  invoice.subtotal12 = s12;
  invoice.subtotal15 = s15;
  invoice.subtotalNoObjeto = sNo;
  invoice.subtotalExento = sEx;
  invoice.subtotal = s0 + s12 + s15 + sNo + sEx;
  invoice.iva = +iva.toFixed(2);
  const retTotal = (invoice.retentions || []).reduce((s, r) => s + (r.amount || 0), 0);
  invoice.retentionTotal = +retTotal.toFixed(2);
  invoice.total = +(invoice.subtotal + invoice.iva + (invoice.ice || 0) + (invoice.propina || 0)).toFixed(2);
  invoice.balance = +(invoice.total - invoice.retentionTotal).toFixed(2);
}

/**
 * Determina el tipo de línea.
 *   - Si `lineType` viene EXPLÍCITO (GASTO/INVENTARIO/ACTIVO_FIJO) se respeta tal cual;
 *     no se reclasifica por la presencia de producto/activo (evita convertir un GASTO
 *     legítimo en INVENTARIO solo porque arrastre un `product`).
 *   - Solo cuando `lineType` viene vacío/ausente (dato legacy: el esquema aplica el
 *     default 'GASTO' al leer de Mongo, así que la inferencia debe hacerse sobre el
 *     ITEM CRUDO del request, antes del casteo) se infiere por producto/activo.
 */
function inferLineType(it) {
  if (it.lineType === 'GASTO' || it.lineType === 'INVENTARIO' || it.lineType === 'ACTIVO_FIJO') return it.lineType;
  const fa = it.fixedAsset;
  if (fa && (fa.category || fa.name || fa.code || fa.assetAccount)) return 'ACTIVO_FIJO';
  if (it.product) return 'INVENTARIO';
  return 'GASTO';
}

/**
 * Resuelve la cuenta de INVENTARIO (activo) de una línea.
 *   - `strict` (compras NUEVAS / autorización): la cuenta SALE de
 *     `InventoryCategory.assetAccount`. Si el producto no tiene categoría, o la
 *     categoría no tiene cuenta de inventario, se BLOQUEA con mensaje claro. Nunca
 *     cae a `it.account` manual, ni a `product.inventoryAccount`, ni al genérico.
 *   - no estricto (documentos ANTIGUOS que se editan): intenta la categoría; si no
 *     hay, usa la cuenta legacy ya booked (`it.account`) → `product.inventoryAccount`
 *     → genérico `inventario`. Este fallback SOLO existe para no romper compras que ya
 *     estaban contabilizadas antes de esta regla.
 */
async function resolveInventoryAccount(it, { clinicId, session, strict }) {
  let cat = null;
  if (it.inventoryCategory) {
    cat = await InventoryCategory.findOne({ _id: it.inventoryCategory, clinic: clinicId }).select('assetAccount').session(session || null);
  }
  let prod = null;
  if (!cat && it.product) {
    prod = await Product.findOne({ _id: it.product, clinic: clinicId }).select('inventoryCategory inventoryAccount').session(session || null);
    if (prod?.inventoryCategory) {
      cat = await InventoryCategory.findOne({ _id: prod.inventoryCategory, clinic: clinicId }).select('assetAccount').session(session || null);
      if (cat) it.inventoryCategory = cat._id;
    }
  }
  if (cat) {
    if (cat.assetAccount) return cat.assetAccount;
    if (strict) throw Object.assign(new Error('La categoría de inventario del producto no tiene cuenta de inventario configurada.'), { status: 400 });
  } else if (strict) {
    throw Object.assign(new Error('El producto no tiene una categoría de inventario configurada.'), { status: 400 });
  }
  // Fallback legacy (solo documentos existentes / no estricto).
  if (it.account) return it.account;
  if (!prod && it.product) prod = await Product.findOne({ _id: it.product, clinic: clinicId }).select('inventoryAccount').session(session || null);
  if (prod?.inventoryAccount) return prod.inventoryAccount;
  const def = await getAccount(clinicId, 'inventario', { session });
  return def?._id || null;
}

/**
 * Resuelve la cuenta de ACTIVO_FIJO de una línea.
 *   - `strict` (compras NUEVAS / autorización): requiere categoría de activo fijo y
 *     que ésta tenga `assetAccount`. Si falta, BLOQUEA con mensaje claro. No usa cuenta
 *     manual (`fa.assetAccount`/`it.account`).
 *   - no estricto (documentos ANTIGUOS): usa `fa.assetAccount` → categoría → `it.account`;
 *     si no hay nada, bloquea.
 */
async function resolveFixedAssetAccount(it, { clinicId, session, strict }) {
  const fa = it.fixedAsset || {};
  let cat = null;
  if (fa.category) cat = await InventoryCategory.findOne({ _id: fa.category, clinic: clinicId }).select('assetAccount').session(session || null);
  if (strict) {
    if (!cat) throw Object.assign(new Error('La línea de activo fijo requiere una categoría de activo fijo.'), { status: 400 });
    if (!cat.assetAccount) throw Object.assign(new Error('La categoría de activo fijo no tiene cuenta de activo configurada.'), { status: 400 });
    return cat.assetAccount;
  }
  if (fa.assetAccount) return fa.assetAccount;
  if (cat?.assetAccount) return cat.assetAccount;
  if (it.account) return it.account;
  throw Object.assign(new Error('La categoría de activo fijo no tiene cuenta de activo configurada.'), { status: 400 });
}

/**
 * Clasifica cada línea (infiere `lineType`), valida según su tipo y RESUELVE la cuenta
 * contable de cada línea (la deja en `it.account`) para que la contabilización sea
 * directa. Separa responsabilidades:
 *   - GASTO: requiere cuenta o distribución; la cuenta por defecto/recurrente del
 *     proveedor SOLO se aplica aquí. Admite distribución (accountSplits). Se limpian
 *     `product`/`fixedAsset`/`inventoryCategory` colgados (no se reclasifica en silencio).
 *   - INVENTARIO: requiere producto y cantidad; NO admite distribución ni cuenta manual;
 *     la cuenta sale de la categoría contable (ver `resolveInventoryAccount`).
 *   - ACTIVO_FIJO: requiere valor y categoría de activo fijo; NO admite distribución ni
 *     cuenta manual; la cuenta sale de la categoría (ver `resolveFixedAssetAccount`).
 *
 * @param {boolean} strict  true en compras NUEVAS y en autorización: bloquea inventario/
 *   activo sin cuenta de categoría y no acepta cuenta manual. false al editar documentos
 *   existentes (compatibilidad legacy).
 * @param {boolean} requireGastoAccount  exige cuenta/split en GASTO (contabilización).
 */
async function classifyAndValidateItems(items, { clinicId, supplier, session, strict = false, requireGastoAccount = true }) {
  for (const it of items || []) {
    it.lineType = inferLineType(it);
    const label = it.description || '(sin descripción)';
    const value = Number(it.subtotal) || ((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0));

    if (it.lineType === 'INVENTARIO') {
      if (Array.isArray(it.accountSplits) && it.accountSplits.length) {
        throw Object.assign(new Error(`La línea de inventario "${label}" no admite distribución de cuentas`), { status: 400 });
      }
      if (!it.product) throw Object.assign(new Error(`La línea de inventario "${label}" requiere un producto`), { status: 400 });
      if (!(Number(it.quantity) > 0)) throw Object.assign(new Error(`La línea de inventario "${label}" requiere una cantidad`), { status: 400 });
      // Inventario NO acepta cuenta manual en compras nuevas: la cuenta la manda la categoría.
      if (strict) { it.account = null; it.accountSplits = []; }
      const acc = await resolveInventoryAccount(it, { clinicId, session, strict });
      it.account = acc || null;
    } else if (it.lineType === 'ACTIVO_FIJO') {
      if (Array.isArray(it.accountSplits) && it.accountSplits.length) {
        throw Object.assign(new Error(`La línea de activo fijo "${label}" no admite distribución de cuentas`), { status: 400 });
      }
      if (!(value > 0)) throw Object.assign(new Error(`El activo fijo "${label}" requiere un valor`), { status: 400 });
      // Activo fijo NO acepta cuenta manual en compras nuevas: la manda la categoría.
      if (strict) { it.account = null; it.accountSplits = []; if (it.fixedAsset) it.fixedAsset.assetAccount = null; }
      const acc = await resolveFixedAssetAccount(it, { clinicId, session, strict });
      it.account = acc || null;
    } else { // GASTO
      // No reclasificar en silencio: si el usuario marcó GASTO, se ignora cualquier
      // producto/activo colgado (no sube stock ni crea activo).
      it.product = null;
      it.fixedAsset = null;
      it.inventoryCategory = null;
      const hasSplits = Array.isArray(it.accountSplits) && it.accountSplits.length > 0;
      // Cuenta por defecto del proveedor: SOLO para gasto sin cuenta ni distribución.
      if (!it.account && !hasSplits && supplier?.defaultExpenseAccount) it.account = supplier.defaultExpenseAccount;
      if (requireGastoAccount && !it.account && !hasSplits) {
        throw Object.assign(new Error(`La línea de gasto "${label}" requiere una cuenta contable o una distribución de cuentas`), { status: 400 });
      }
    }
  }
}

/**
 * Busca la regla de retención (catálogo) por id o por código+tipo, validando que sea de
 * la clínica, esté activa y esté vigente a la fecha de la factura. Bloquea con mensaje
 * claro si no cumple.
 */
async function resolveRetentionRule({ clinicId, ruleId, code, type, date, session }) {
  const q = { clinic: clinicId };
  if (ruleId) q._id = ruleId;
  else { q.code = String(code).trim(); if (type) q.type = type; }
  const rule = await RetentionRule.findOne(q).session(session || null);
  if (!rule) throw Object.assign(new Error(`La regla de retención (${ruleId || code}) no existe o no pertenece a la clínica`), { status: 400 });
  if (!rule.active) throw Object.assign(new Error(`La regla de retención ${rule.code} está inactiva`), { status: 400 });
  const d = date ? new Date(date) : new Date();
  if (rule.validFrom && d < new Date(rule.validFrom)) throw Object.assign(new Error(`La regla de retención ${rule.code} aún no está vigente`), { status: 400 });
  if (rule.validTo && d > new Date(rule.validTo)) throw Object.assign(new Error(`La regla de retención ${rule.code} ya no está vigente`), { status: 400 });
  return rule;
}

/**
 * Resuelve la cuenta de retención por pagar de una regla: `rule.payableAccount` (validada
 * de la clínica) o, como fallback controlado, la cuenta de accountMap por tipo
 * (retIvaPorPagar / retRentaPorPagar). Bloquea si la cuenta configurada no existe/es de
 * otra clínica o si no se puede resolver ninguna.
 */
async function resolveRetentionPayableAccount(rule, { clinicId, session }) {
  if (rule.payableAccount) {
    const acc = await ChartOfAccount.findOne({ _id: rule.payableAccount, clinic: clinicId }).session(session || null);
    if (!acc) throw Object.assign(new Error(`La cuenta de retención por pagar de la regla ${rule.code} no existe o no pertenece a la clínica`), { status: 400 });
    return acc;
  }
  const role = rule.type === 'IVA' ? 'retIvaPorPagar' : 'retRentaPorPagar';
  const acc = await getAccount(clinicId, role, { session });
  if (!acc) throw Object.assign(new Error(`No hay cuenta de retención (${role}) configurada para contabilizar la retención ${rule.code}`), { status: 400 });
  return acc;
}

/**
 * Resuelve las retenciones por LÍNEA (recalcula base/monto/cuenta desde el catálogo,
 * ignorando lo que envíe el frontend) y DERIVA la cabecera `inv.retentions` agrupada.
 * La cabecera es la única fuente que se contabiliza/reporta (evita doble conteo).
 *
 * Reglas de compatibilidad:
 *   - Compras del flujo nuevo (`strictAccounts === true`): las retenciones son SIEMPRE
 *     por línea; la cabecera se re-deriva (aunque quede vacía) para no arrastrar
 *     retenciones manuales obsoletas.
 *   - Compras legacy: si hay retenciones por línea, se derivan; si no, se conserva la
 *     captura manual de cabecera (`inv.retentions`).
 */
async function applyLineRetentions(inv, { clinicId, session }) {
  let hasLine = false;
  for (const it of inv.items || []) {
    const sel = it.retention;
    if (!sel || (!sel.rule && !sel.code)) { it.retention = null; continue; }
    const rule = await resolveRetentionRule({ clinicId, ruleId: sel.rule, code: sel.code, type: sel.type, date: inv.fechaEmision, session });
    const account = await resolveRetentionPayableAccount(rule, { clinicId, session });
    const { base, amount } = computeRetention(it, rule);
    it.retention = {
      rule: rule._id, type: rule.type, code: rule.code, description: rule.description || '',
      rate: rule.rate, base, amount, account: account._id,
      baseAmount: base, percentage: rule.rate, // alias legacy
    };
    if (amount > 0) hasLine = true;
  }
  if (inv.strictAccounts === true || hasLine) {
    inv.retentions = groupLineRetentions(inv.items);
  }
  inv.retentionTotal = +((inv.retentions || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)).toFixed(2);
  inv.balance = +((Number(inv.total) || 0) - inv.retentionTotal).toFixed(2);
}

exports.list = async (req, res) => {
  const { startDate, endDate, supplier, status, docType, q, sort = 'fecha_desc', page = 1, limit = 20 } = req.query;
  const filter = { clinic: req.clinicId };
  if (supplier) filter.supplier = supplier;
  if (status) filter.status = status;
  if (docType) filter.docType = docType;
  if (startDate || endDate) {
    filter.fechaEmision = {};
    if (startDate) filter.fechaEmision.$gte = new Date(startDate);
    if (endDate) filter.fechaEmision.$lte = new Date(endDate);
  }
  if (q) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Buscar también por proveedor (razón social / RUC / nombre comercial)
    const sups = await Supplier.find({ clinic: req.clinicId, $or: [{ razonSocial: rx }, { ruc: rx }, { nombreComercial: rx }] }).select('_id');
    filter.$or = [
      { serie: rx }, { autorizacion: rx }, { claveAcceso: rx }, { secuencial: rx }, { retentionNumber: rx },
      ...(sups.length ? [{ supplier: { $in: sups.map((s) => s._id) } }] : []),
    ];
  }
  // Reordenamiento: por fecha (recientes/antiguas) o por monto (mayor/menor).
  const sortMap = {
    fecha_desc: { fechaEmision: -1 },
    fecha_asc: { fechaEmision: 1 },
    total_desc: { total: -1 },
    total_asc: { total: 1 },
  };
  const sortBy = sortMap[sort] || sortMap.fecha_desc;
  const total = await PurchaseInvoice.countDocuments(filter);
  const items = await PurchaseInvoice.find(filter)
    .populate('supplier', 'ruc razonSocial')
    .sort(sortBy).skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.get = async (req, res) => {
  const p = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('supplier').populate('items.account', 'code name').populate('items.product', 'name code');
  if (!p) return res.status(404).json({ message: 'No encontrada' });
  res.json(p);
};

exports.create = async (req, res) => {
  try {
    {
      const invoiceId = await runInTransaction(async (session) => {
        // `strictAccounts` lo fija el servidor (no el cliente): marca que esta compra
        // nace bajo el flujo estricto, para que futuras ediciones NO caigan al genérico.
        const data = { ...req.body, clinic: req.clinicId, createdBy: req.user._id, strictAccounts: true };
        if (data.fechaEmision) data.fechaEmision = new Date(data.fechaEmision);
        calcTotals(data);
        await assertPeriodOpen(req.clinicId, data.fechaEmision || new Date(), { session });
        const sup = await Supplier.findOne({ _id: data.supplier, clinic: req.clinicId }).session(session);
        if (!sup) throw Object.assign(new Error('Proveedor no encontrado'), { status: 400 });
        // Clasifica/valida por tipo de línea (la cuenta por defecto del proveedor
        // se aplica SOLO a líneas GASTO, dentro del helper). Compra NUEVA => strict:
        // inventario/activo deben resolver su cuenta desde la categoría contable.
        await classifyAndValidateItems(data.items, { clinicId: req.clinicId, supplier: sup, session, strict: true });
        const [inv] = await PurchaseInvoice.create([data], { session });
        // Retenciones por línea desde catálogo (recalcula base/monto y deriva la cabecera).
        await applyLineRetentions(inv, { clinicId: req.clinicId, session });
        await postPurchaseJournal(inv, req, session);
        await postInventoryEntries(inv, req, session);
        await syncFixedAssetsForInvoice(inv, req, session);
        await openPayableForInvoice(inv, sup, req, session);
        await rememberRecurringAccounts(inv, session);
        return inv._id;
      });
      const inv = await PurchaseInvoice.findById(invoiceId);
      return res.status(201).json(inv);
    }
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

async function postPurchaseJournal(inv, req, session, sourceAction = 'POST') {
  const lines = [];
  // La cuenta de cada línea ya fue resuelta y validada por `classifyAndValidateItems`
  // (GASTO: cuenta/distribución; INVENTARIO/ACTIVO_FIJO: cuenta de la categoría contable).
  // Aquí solo se arma el asiento; no hay fallback genérico silencioso.
  for (const it of inv.items || []) {
    // Distribución en varias cuentas: una línea por cada split (la suma debe igualar el subtotal)
    if (Array.isArray(it.accountSplits) && it.accountSplits.length) {
      const splitSum = it.accountSplits.reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
      if (Math.abs(splitSum - it.subtotal) > 0.01) {
        throw Object.assign(new Error(`La distribución de cuentas del ítem "${it.description}" (${splitSum.toFixed(2)}) no cuadra con su subtotal (${it.subtotal.toFixed(2)})`), { status: 400 });
      }
      for (const sp of it.accountSplits) {
        if (!sp.account || !(Number(sp.amount) > 0)) continue;
        lines.push({ account: sp.account, debit: +(Number(sp.amount)).toFixed(2), credit: 0, description: sp.description || it.description, costCenter: it.costCenter || inv.costCenter || null });
      }
      continue;
    }
    const accountId = it.account;
    if (!accountId) continue;
    lines.push({ account: accountId, debit: it.subtotal, credit: 0, description: it.description, costCenter: it.costCenter || inv.costCenter || null });
  }
  if (inv.iva > 0) {
    // IVA con derecho a crédito tributario (deducible) vs IVA no recuperable que se carga al gasto.
    if (inv.deductible === false) {
      inv.vatCreditAmount = 0;
      inv.vatNonCreditAmount = inv.iva;
      const ivaGasto = await getAccount(req.clinicId, 'ivaComprasNoCredito', { session });
      lines.push({ account: ivaGasto._id, debit: inv.iva, credit: 0, description: 'IVA no recuperable (al gasto)' });
    } else {
      inv.vatCreditAmount = inv.iva;
      inv.vatNonCreditAmount = 0;
      const ivaAcc = await getAccount(req.clinicId, 'ivaCompras', { session });
      lines.push({ account: ivaAcc._id, debit: inv.iva, credit: 0, description: 'IVA en compras (crédito tributario)' });
    }
  }
  // ICE y propina forman parte del total (y por tanto del crédito al proveedor),
  // así que deben debitarse a un gasto para que el asiento cuadre.
  if (Number(inv.ice || 0) > 0) {
    const iceAcc = await getAccount(req.clinicId, 'otrosGastos', { session });
    lines.push({ account: iceAcc._id, debit: +Number(inv.ice).toFixed(2), credit: 0, description: 'ICE en compra' });
  }
  if (Number(inv.propina || 0) > 0) {
    const propAcc = await getAccount(req.clinicId, 'otrosGastos', { session });
    lines.push({ account: propAcc._id, debit: +Number(inv.propina).toFixed(2), credit: 0, description: 'Propina en compra' });
  }
  const sup = await Supplier.findById(inv.supplier).session(session || null);
  const provAcc = sup?.defaultPayableAccount
    ? await ChartOfAccount.findById(sup.defaultPayableAccount).session(session || null)
    : await getAccount(req.clinicId, 'proveedores', { session });
  lines.push({ account: provAcc._id, debit: 0, credit: inv.total, description: `Factura ${inv.serie || ''}` });
  // Retenciones: reducen las CxP del proveedor y se acreditan a retenciones por pagar.
  // `inv.retentions` es la fuente ÚNICA (derivada de las líneas en compras nuevas o
  // manual en legacy), así que no hay doble conteo. Cada código usa su propia cuenta
  // (snapshot de la regla) o, como fallback, la cuenta por rol según el tipo.
  if (inv.retentionTotal > 0) {
    lines[lines.length - 1].credit = +(lines[lines.length - 1].credit - inv.retentionTotal).toFixed(2);
    for (const r of inv.retentions) {
      if (!(Number(r.amount) > 0)) continue;
      let accId = r.account;
      if (!accId) {
        const role = r.type === 'IVA' ? 'retIvaPorPagar' : 'retRentaPorPagar';
        accId = (await getAccount(req.clinicId, role, { session }))._id;
      }
      lines.push({ account: accId, debit: 0, credit: +Number(r.amount).toFixed(2), description: `Ret ${r.type} ${r.code || ''}` });
    }
  }
  const entry = await createEntry({
    clinicId: req.clinicId, date: inv.fechaEmision, description: `Compra ${inv.serie || ''}`,
    source: 'COMPRA', sourceRef: inv._id, sourceModel: 'PurchaseInvoice', sourceAction,
    lines, userId: req.user._id, session,
  });
  inv.journalEntry = entry._id;
  await inv.save({ session });
}

/**
 * Procesa la entrada de inventario para cada ítem de la factura que apunte a un
 * producto físico: actualiza stock, recalcula costo promedio ponderado y registra
 * un InventoryMovement de tipo entrada. Idempotente por (sourceModel, sourceRef).
 */
async function postInventoryEntries(inv, req, session) {
  // Evita duplicar entradas si ya fueron registradas (p.ej. en una edición)
  await InventoryMovement.deleteMany({
    clinic: req.clinicId,
    sourceModel: 'PurchaseInvoice',
    sourceRef: inv._id,
  }).session(session || null);
  for (const it of inv.items || []) {
    if (!it.product || !it.quantity || it.quantity <= 0) continue;
    const prod = await Product.findOne({ _id: it.product, clinic: req.clinicId }).session(session || null);
    if (!prod || prod.unlimited || prod.category === 'servicio') continue;
    const qty = Number(it.quantity);
    const unitCost = Number(it.unitPrice) || 0;
    // Kardex: cada compra crea una capa valorada (con lote/vencimiento si aplica).
    await kardex.receiveStock({
      clinicId: req.clinicId,
      product: prod._id,
      warehouse: it.warehouse || null,
      lot: it.lot || '',
      expiryDate: it.expiryDate || null,
      quantity: qty,
      unitCost,
      date: inv.fechaEmision || new Date(),
      sourceModel: 'PurchaseInvoice',
      sourceRef: inv._id,
      userId: req.user._id,
    }, session);
    // El stock y el costo promedio del producto pasan a ser un cache de las capas vivas.
    const cur = await kardex.currentStock({ clinicId: req.clinicId, product: prod._id }, session);
    prod.stock = cur.qty;
    prod.averageCost = cur.averageCost;
    if (unitCost > 0) prod.purchasePrice = unitCost;
    await prod.save({ session });
    await InventoryMovement.create([{
      clinic: req.clinicId,
      product: prod._id,
      type: 'entrada',
      quantity: qty,
      unitCost,
      totalCost: +(qty * unitCost).toFixed(2),
      balanceAfter: cur.qty,
      lot: it.lot || '',
      expiryDate: it.expiryDate || null,
      reason: `Compra ${inv.serie || ''}`.trim(),
      reference: inv.serie || '',
      sourceModel: 'PurchaseInvoice',
      sourceRef: inv._id,
      createdBy: req.user._id,
    }], session ? { session } : {});
  }
}

/**
 * Crea los activos fijos de las líneas marcadas como ACTIVO_FIJO al contabilizar la
 * factura. Es idempotente: borra los activos previos de esta factura que aún no tengan
 * depreciación y los vuelve a crear (para reflejar ediciones). Reusa la misma lógica de
 * derivación de `inventoryAdvancedController.createAsset`.
 */
async function syncFixedAssetsForInvoice(inv, req, session) {
  const assetItems = (inv.items || []).filter((it) => it.lineType === 'ACTIVO_FIJO');
  // Limpia activos previos (sin depreciación) de esta factura para recrearlos.
  await FixedAsset.deleteMany({
    clinic: req.clinicId, purchaseInvoice: inv._id,
    $or: [{ accumulatedDepreciation: { $lte: 0 } }, { accumulatedDepreciation: null }],
  }).session(session || null);
  if (!assetItems.length) return;

  const baseCount = await FixedAsset.countDocuments({ clinic: req.clinicId }).session(session || null);
  let seq = 0;
  for (const it of assetItems) {
    const fa = it.fixedAsset || {};
    let cat = null;
    if (fa.category) cat = await InventoryCategory.findOne({ _id: fa.category, clinic: req.clinicId }).session(session || null);
    const cost = +Number(it.subtotal || 0).toFixed(2);
    const depRate = Number(fa.depreciationRate || cat?.depreciationRate || 0);
    const noDep = !!cat?.noDepreciate;
    const usefulLifeMonths = noDep ? 0 : (Number(fa.usefulLifeMonths) || (depRate > 0 ? Math.round(1200 / depRate) : 0) || 120);
    const residualPercent = Number(fa.residualPercent || cat?.residualPercent || 0);
    const residualValue = +(cost * (residualPercent / 100)).toFixed(2);
    const monthly = (noDep || !usefulLifeMonths) ? 0 : +((cost - residualValue) / usefulLifeMonths).toFixed(2);
    seq += 1;
    const code = (fa.code && String(fa.code).trim()) || `AF-${String(baseCount + seq).padStart(4, '0')}`;
    const acqDate = fa.acquisitionDate || inv.fechaEmision || new Date();
    const [asset] = await FixedAsset.create([{
      clinic: req.clinicId,
      code,
      name: (fa.name && String(fa.name).trim()) || it.description,
      category: fa.category || null,
      assetType: fa.assetType || null,
      serial: fa.serial || '',
      location: fa.location || '',
      locationClinic: fa.locationClinic || null,
      responsible: fa.responsible || null,
      assetAccount: fa.assetAccount || it.account || cat?.assetAccount || null,
      depreciationAccount: fa.depreciationAccount || cat?.depreciationAccount || null,
      accumDepreciationAccount: fa.accumDepreciationAccount || cat?.accumDepreciationAccount || null,
      purchaseInvoice: inv._id,
      acquisitionDate: acqDate,
      acquisitionCost: cost,
      residualValue,
      residualPercent,
      depreciationRate: depRate,
      usefulLifeMonths: usefulLifeMonths || 0,
      startDate: fa.startDate || acqDate,
      monthlyDepreciation: monthly,
      bookValue: cost,
      createdBy: req.user._id,
    }], { session });
    it.fixedAsset = { ...fa, createdAsset: asset._id };
  }
  await inv.save({ session });
}

/**
 * Borra los activos fijos creados por esta factura que aún no tengan depreciación.
 * Se usa al anular: si alguno ya se depreció, se conserva (debe darse de baja a mano).
 */
async function removeFixedAssetsForInvoice(inv, req, session) {
  await FixedAsset.deleteMany({
    clinic: req.clinicId, purchaseInvoice: inv._id,
    $or: [{ accumulatedDepreciation: { $lte: 0 } }, { accumulatedDepreciation: null }],
  }).session(session || null);
}

exports.update = async (req, res) => {
  try {
    {
      const invoiceId = await runInTransaction(async (session) => {
        const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!inv) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (inv.status !== 'REGISTRADA') throw Object.assign(new Error('No editable en su estado'), { status: 400 });
        // ¿Documento LEGACY real? Solo entonces se tolera el fallback de cuentas al editar.
        // El marcador autoritativo es `strictAccounts`: toda compra creada/autorizada bajo
        // el flujo nuevo lo trae en true; las anteriores (asiento ya generado, item.account
        // guardado, etc.) lo tienen falso. Así, una compra del flujo nuevo se valida
        // ESTRICTO también al editar: si pierde la categoría/cuenta, falla con mensaje claro
        // en vez de caer al genérico.
        const isLegacyDoc = inv.strictAccounts !== true;
        const strictUpdate = !isLegacyDoc;
        await assertPeriodOpen(req.clinicId, inv.fechaEmision, { session });
        const nextDate = req.body.fechaEmision ? new Date(req.body.fechaEmision) : inv.fechaEmision;
        await assertPeriodOpen(req.clinicId, nextDate, { session });
        if (inv.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: inv.journalEntry,
            userId: req.user._id,
            reason: 'Edicion de compra',
            date: req.body.reversalDate ? new Date(req.body.reversalDate) : new Date(),
            session,
          });
        }
        await revertInventoryEntries(inv, req, session);
        // Edición: `strictUpdate` según sea documento nuevo (estricto) o legacy real
        // (tolerante). La clasificación se hace sobre los ítems CRUDOS del body (antes del
        // casteo) para conservar la señal de `lineType` explícito vs ausente; si no vienen
        // ítems en el body, se reclasifican los ya almacenados.
        const supForItems = await Supplier.findById(req.body.supplier || inv.supplier).session(session);
        if (Array.isArray(req.body.items)) {
          await classifyAndValidateItems(req.body.items, { clinicId: req.clinicId, supplier: supForItems, session, strict: strictUpdate });
        }
        Object.assign(inv, req.body);
        if (inv.fechaEmision) inv.fechaEmision = new Date(inv.fechaEmision);
        // `strictAccounts` lo controla el servidor: no se deja pisar por el body y se
        // conserva/afianza según la naturaleza del documento (nuevo permanece estricto).
        inv.strictAccounts = strictUpdate;
        calcTotals(inv);
        if (!Array.isArray(req.body.items)) {
          await classifyAndValidateItems(inv.items, { clinicId: req.clinicId, supplier: supForItems, session, strict: strictUpdate });
        }
        await applyLineRetentions(inv, { clinicId: req.clinicId, session });
        await inv.save({ session });
        await postPurchaseJournal(inv, req, session, `UPDATE:${Date.now()}`);
        await postInventoryEntries(inv, req, session);
        await syncFixedAssetsForInvoice(inv, req, session);
        const supForPayable = await Supplier.findById(inv.supplier).session(session);
        await openPayableForInvoice(inv, supForPayable, req, session);
        return inv._id;
      });
      const inv = await PurchaseInvoice.findById(invoiceId);
      return res.json(inv);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.void = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!inv) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (inv.status === 'ANULADA') throw Object.assign(new Error('Ya anulada'), { status: 400 });
        await assertPeriodOpen(req.clinicId, inv.fechaEmision, { session });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });
        if (inv.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: inv.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion compra',
            date: reversalDate,
            session,
          });
        }
        await revertInventoryEntries(inv, req, session);
        await removeFixedAssetsForInvoice(inv, req, session);
        await voidPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id }, { session });
        inv.status = 'ANULADA';
        await inv.save({ session });
        return { message: 'Anulada' };
      });
      return res.json(result);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Revierte las entradas de inventario provocadas por esta factura: descuenta el
 * stock que se había sumado y elimina los movimientos. No restaura el costo
 * promedio histórico (sigue siendo conservador y suficiente para anulación).
 */
async function revertInventoryEntries(inv, req, session) {
  // Anula las capas de kardex creadas por esta compra (retira lo no consumido).
  await kardex.reverseReceiptBySource(
    { clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: inv._id },
    session
  );
  const movs = await InventoryMovement.find({
    clinic: req.clinicId,
    sourceModel: 'PurchaseInvoice',
    sourceRef: inv._id,
    type: 'entrada',
  }).session(session || null);
  const touched = new Set();
  for (const m of movs) touched.add(String(m.product));
  await InventoryMovement.deleteMany({
    clinic: req.clinicId,
    sourceModel: 'PurchaseInvoice',
    sourceRef: inv._id,
  }).session(session || null);
  // Recalcula stock/costo de los productos afectados desde las capas vivas.
  for (const productId of touched) {
    const prod = await Product.findOne({ _id: productId, clinic: req.clinicId }).session(session || null);
    if (!prod) continue;
    const cur = await kardex.currentStock({ clinicId: req.clinicId, product: prod._id }, session);
    prod.stock = cur.qty;
    prod.averageCost = cur.averageCost;
    await prod.save({ session });
  }
}

// Convierte un número con posibles separadores de miles y coma/punto decimal a Number.
// Acepta decimales con punto inicial (".42"), comas decimales ("1,50") y miles.
function parseSriNumber(s) {
  let t = String(s == null ? '' : s).trim();
  if (!t) return 0;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  return parseFloat(t.replace(/[^0-9.\-]/g, '')) || 0;
}

// Quita tildes y normaliza un encabezado a MAYÚSCULA_CON_GUIONES (RAZÓN Social → RAZON_SOCIAL).
function normHeaderKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Parsea una fecha del SRI (DD/MM/AAAA[ hh:mm:ss] o AAAA-MM-DD) a Date local, ignorando la hora.
function parseSriDate(s) {
  const f = String(s || '').trim().split(/\s+/)[0]; // descarta la hora si viene "01/06/2026 10:03:32"
  if (!f) return null;
  const dmy = f.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) { const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]; const d = new Date(`${y}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}T00:00:00`); return isNaN(d) ? null : d; }
  const ymd = f.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (ymd) { const d = new Date(`${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}T00:00:00`); return isNaN(d) ? null : d; }
  const d = new Date(f);
  return isNaN(d) ? null : d;
}

// Aproxima la tarifa de IVA a la más cercana del catálogo (0/12/15) a partir de iva/base.
function snapIvaRate(iva, base) {
  if (!(iva > 0) || !(base > 0)) return 0;
  const pct = (iva / base) * 100;
  return [12, 15].reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));
}

// Mapea el tipo de comprobante del SRI a nuestro docType.
function mapDocType(tipo) {
  const t = normHeaderKey(tipo);
  if (t.includes('NOTA_DE_CREDITO') || t === 'NC' || t.includes('NOTA_CREDITO')) return 'NOTA_CREDITO_REC';
  if (t.includes('NOTA_DE_DEBITO') || t === 'ND' || t.includes('NOTA_DEBITO')) return 'NOTA_DEBITO_REC';
  if (t.includes('LIQUIDACION')) return 'LIQUIDACION';
  if (t.includes('NOTA_DE_VENTA')) return 'NOTA_VENTA';
  return 'FACTURA';
}

// Sinónimos de encabezado → posición oficial del reporte "Comprobantes recibidos" del SRI.
const SRI_COLUMNS = {
  ruc:      { keys: ['RUC_EMISOR', 'RUC', 'IDENTIFICACION_EMISOR', 'RUC_O_CEDULA_EMISOR'], pos: 0 },
  razon:    { keys: ['RAZON_SOCIAL_EMISOR', 'RAZON_SOCIAL', 'NOMBRE_EMISOR'], pos: 1 },
  tipo:     { keys: ['TIPO_COMPROBANTE', 'COMPROBANTE', 'TIPO'], pos: 2 },
  serie:    { keys: ['SERIE_COMPROBANTE', 'SERIE', 'NUMERO_COMPROBANTE', 'NUMERO'], pos: 3 },
  clave:    { keys: ['CLAVE_ACCESO', 'CLAVE_DE_ACCESO', 'NUMERO_AUTORIZACION', 'AUTORIZACION'], pos: 4 },
  fechaAut: { keys: ['FECHA_AUTORIZACION'], pos: 5 },
  fechaEmi: { keys: ['FECHA_EMISION', 'FECHA'], pos: 6 },
  receptor: { keys: ['IDENTIFICACION_RECEPTOR', 'RUC_RECEPTOR'], pos: 7 },
  subtotal: { keys: ['VALOR_SIN_IMPUESTOS', 'SUBTOTAL', 'BASE_IMPONIBLE', 'VALOR_SIN_IMPUESTO'], pos: 8 },
  iva:      { keys: ['IVA', 'VALOR_IVA', 'IMPUESTO_IVA'], pos: 9 },
  total:    { keys: ['IMPORTE_TOTAL', 'TOTAL', 'VALOR_TOTAL'], pos: 10 },
  docMod:   { keys: ['NUMERO_DOCUMENTO_MODIFICADO', 'DOCUMENTO_MODIFICADO'], pos: 11 },
};

/**
 * Parser PURO (sin DB) del reporte TXT del SRI de "Comprobantes electrónicos recibidos".
 * Formato real: TSV (tab) con cabecera y columnas
 *   RUC_EMISOR | RAZON_SOCIAL_EMISOR | TIPO_COMPROBANTE | SERIE_COMPROBANTE | CLAVE_ACCESO |
 *   FECHA_AUTORIZACION | FECHA_EMISION | IDENTIFICACION_RECEPTOR | VALOR_SIN_IMPUESTOS | IVA |
 *   IMPORTE_TOTAL | NUMERO_DOCUMENTO_MODIFICADO
 * Mapea por NOMBRE de cabecera (tolerante a reordenamientos y archivos de terceros); si no
 * hay cabecera, usa el orden posicional oficial. Devuelve { rows, errors }.
 */
function parseSriReport(raw) {
  const rawLines = String(raw || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (!rawLines.length) return { rows: [], errors: [] };

  // Detecta el separador: tab prioritario; luego ';', '|' y por último ',' (sin romper decimales).
  const sample = rawLines[0];
  const delimiter = sample.includes('\t') ? '\t' : (sample.includes(';') ? ';' : (sample.includes('|') ? '|' : ','));
  const split = (line) => line.split(delimiter).map((c) => c.trim());

  // ¿La primera fila es cabecera? (contiene nombres conocidos del reporte SRI)
  const firstCells = split(rawLines[0]).map(normHeaderKey);
  const headerKeys = new Set(Object.values(SRI_COLUMNS).flatMap((c) => c.keys));
  const hasHeader = firstCells.some((h) => headerKeys.has(h));
  const idx = {};
  if (hasHeader) firstCells.forEach((h, i) => { if (idx[h] === undefined) idx[h] = i; });

  // Resuelve el valor de una columna lógica: por cabecera si existe, si no por posición.
  const pick = (cols, key) => {
    const def = SRI_COLUMNS[key];
    if (hasHeader) { for (const k of def.keys) { if (idx[k] !== undefined) return cols[idx[k]]; } return undefined; }
    return cols[def.pos];
  };

  const rows = [];
  const errors = [];
  const startRow = hasHeader ? 1 : 0;
  for (let i = startRow; i < rawLines.length; i++) {
    const cols = split(rawLines[i]);
    if (cols.length < 4) { errors.push({ line: i + 1, error: `Fila con muy pocas columnas (${cols.length}). Revisa el separador del archivo.` }); continue; }
    const ruc = String(pick(cols, 'ruc') || '').replace(/\D/g, '');
    if (!/^\d{10,13}$/.test(ruc)) { errors.push({ line: i + 1, error: `RUC inválido: "${pick(cols, 'ruc')}"` }); continue; }
    const fecha = parseSriDate(pick(cols, 'fechaEmi')) || parseSriDate(pick(cols, 'fechaAut'));
    if (!fecha) { errors.push({ line: i + 1, error: `Fecha inválida: "${pick(cols, 'fechaEmi') || pick(cols, 'fechaAut')}"` }); continue; }
    const serie = String(pick(cols, 'serie') || '').trim();
    const sm = serie.match(/^(\d{1,3})-(\d{1,3})-(\d+)$/);
    const subtotal = parseSriNumber(pick(cols, 'subtotal'));
    const iva = parseSriNumber(pick(cols, 'iva'));
    const total = parseSriNumber(pick(cols, 'total')) || +(subtotal + iva).toFixed(2);
    rows.push({
      line: i + 1,
      ruc,
      razonSocial: String(pick(cols, 'razon') || '').trim(),
      docType: mapDocType(pick(cols, 'tipo')),
      serie, estab: sm ? sm[1] : '', ptoEmi: sm ? sm[2] : '', secuencial: sm ? sm[3] : '',
      claveAcceso: String(pick(cols, 'clave') || '').trim(),
      fechaEmision: fecha,
      subtotal, iva, total, ivaRate: snapIvaRate(iva, subtotal),
    });
  }
  return { rows, errors };
}

/**
 * Importa el reporte TXT del SRI. Crea/asocia el proveedor por RUC y deja cada factura
 * en estado POR_AUTORIZAR conservando los montos exactos del SRI: el contador asigna
 * cuentas/inventario antes de contabilizar.
 *
 * Trabaja por LOTES (pocas consultas en total) para no colgarse con archivos grandes
 * sobre bases remotas lentas: 1 consulta de proveedores + insert de faltantes,
 * 1 consulta de duplicados, 1 insertMany de las facturas nuevas.
 */
exports.importTxt = async (req, res) => {
  try {
    const raw = req.body?.content || req.body?.text;
    if (!raw) return res.status(400).json({ message: 'content vacío' });
    const { rows, errors } = parseSriReport(raw);
    if (!rows.length) return res.json({ created: 0, skipped: 0, errors });

    // 1) Proveedores: trae los existentes por RUC en una sola consulta; crea los faltantes.
    const rucs = [...new Set(rows.map((r) => r.ruc))];
    const existingSups = await Supplier.find({ clinic: req.clinicId, ruc: { $in: rucs } });
    const supByRuc = new Map(existingSups.map((s) => [s.ruc, s]));
    const newSupplierDocs = [];
    for (const ruc of rucs) {
      if (supByRuc.has(ruc)) continue;
      const row = rows.find((r) => r.ruc === ruc);
      newSupplierDocs.push({ clinic: req.clinicId, ruc, razonSocial: row?.razonSocial || ruc });
    }
    if (newSupplierDocs.length) {
      const created = await Supplier.insertMany(newSupplierDocs, { ordered: false }).catch(async () => {
        // Ante una carrera/duplicado, recarga el set completo.
        return Supplier.find({ clinic: req.clinicId, ruc: { $in: rucs } });
      });
      for (const s of created) supByRuc.set(s.ruc, s);
    }

    // 2) Duplicados: una sola consulta por clave de acceso o (proveedor, serie).
    const claves = [...new Set(rows.map((r) => r.claveAcceso).filter(Boolean))];
    const serieKeys = rows
      .map((r) => ({ supplier: supByRuc.get(r.ruc)?._id, serie: r.serie }))
      .filter((x) => x.supplier && x.serie);
    const dupOr = [];
    if (claves.length) dupOr.push({ claveAcceso: { $in: claves } });
    if (serieKeys.length) dupOr.push({ $or: serieKeys.map((s) => ({ supplier: s.supplier, serie: s.serie })) });
    const existingInv = dupOr.length
      ? await PurchaseInvoice.find({ clinic: req.clinicId, $or: dupOr }).select('claveAcceso supplier serie')
      : [];
    const existingClaves = new Set(existingInv.map((e) => e.claveAcceso).filter(Boolean));
    const existingSerieKeys = new Set(existingInv.map((e) => `${e.supplier}|${e.serie}`));

    // 3) Construye los documentos nuevos (deduplicando también dentro del propio archivo).
    let skipped = 0;
    const seenInFile = new Set();
    const docs = [];
    for (const r of rows) {
      const sup = supByRuc.get(r.ruc);
      if (!sup) { errors.push({ line: r.line, error: `No se pudo crear/encontrar el proveedor ${r.ruc}` }); continue; }
      const serieKey = `${sup._id}|${r.serie}`;
      const fileKey = r.claveAcceso || serieKey;
      if (seenInFile.has(fileKey)) { skipped++; continue; }
      seenInFile.add(fileKey);
      if ((r.claveAcceso && existingClaves.has(r.claveAcceso)) || (r.serie && existingSerieKeys.has(serieKey))) { skipped++; continue; }
      docs.push({
        clinic: req.clinicId, supplier: sup._id,
        docType: r.docType,
        estab: r.estab, ptoEmi: r.ptoEmi, secuencial: r.secuencial,
        serie: r.serie, claveAcceso: r.claveAcceso, autorizacion: r.claveAcceso,
        fechaEmision: r.fechaEmision,
        items: [{
          description: `Compra a ${sup.razonSocial || r.razonSocial || r.ruc} (importado SRI)`,
          quantity: 1, unitPrice: r.subtotal, discount: 0,
          subtotal: r.subtotal, ivaRate: r.ivaRate, ivaAmount: r.iva,
          // Sin cuenta ni clasificación: el contador clasifica al contabilizar.
          account: null, lineType: 'GASTO',
        }],
        // Conserva los montos EXACTOS del SRI (no se recalculan al importar).
        subtotal0: r.ivaRate === 0 ? r.subtotal : 0,
        subtotal12: r.ivaRate === 12 ? r.subtotal : 0,
        subtotal15: r.ivaRate === 15 ? r.subtotal : 0,
        subtotal: r.subtotal, iva: r.iva, total: r.total, balance: r.total,
        status: 'POR_AUTORIZAR', importedFromTxt: true, createdBy: req.user._id,
      });
    }

    let created = 0;
    if (docs.length) {
      const inserted = await PurchaseInvoice.insertMany(docs, { ordered: false }).catch((e) => {
        // Con ordered:false, los duplicados que se colaron se cuentan como omitidos.
        const ok = e?.insertedDocs?.length || 0;
        skipped += docs.length - ok;
        return e?.insertedDocs || [];
      });
      created = inserted.length;
    }

    res.json({ created, skipped, errors });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Exporta el parser puro para pruebas unitarias.
exports._parseSriReport = parseSriReport;

/**
 * Borra TODAS las facturas de compra de la clínica actual y sus artefactos
 * (asientos, CxP, movimientos y capas de inventario), recalculando el stock.
 * Pensado para limpiar importaciones erróneas cuando no hay acceso a consola (Render).
 * Requiere body { confirm: 'BORRAR-COMPRAS' }. Si hay pagos aplicados, exige force:true.
 */
/**
 * Borra de raíz un conjunto de facturas de compra y sus artefactos (asientos, CxP,
 * movimientos y capas de inventario), recalculando el stock de los productos afectados.
 * Lanza 409 si hay pagos vigentes aplicados (salvo force). Compartido por wipeAll y remove.
 */
async function purgePurchaseInvoices(clinicId, invoices, { force = false } = {}) {
  const JournalEntry = require('../models/JournalEntry');
  const Payable = require('../models/Payable');
  const InventoryLayer = require('../models/InventoryLayer');
  const Payment = require('../models/Payment');

  const invoiceIds = invoices.map((i) => i._id);
  if (!invoiceIds.length) return { invoices: 0, journals: 0, payables: 0, movements: 0, layers: 0, productsRecalculated: 0 };

  const paymentsWithPurchase = await Payment.countDocuments({
    clinic: clinicId, status: { $ne: 'ANULADO' },
    'applications.docModel': 'PurchaseInvoice', 'applications.docRef': { $in: invoiceIds },
  });
  if (paymentsWithPurchase && !force) {
    throw Object.assign(new Error(`Hay ${paymentsWithPurchase} pago(s) aplicados. Anúlalos primero, o reintenta con force.`), { status: 409, payments: paymentsWithPurchase });
  }

  const affected = new Set();
  for (const inv of invoices) for (const it of inv.items || []) if (it.product) affected.add(String(it.product));
  const refScope = { clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: { $in: invoiceIds } };
  const layerProducts = await InventoryLayer.find(refScope).select('product');
  for (const l of layerProducts) if (l.product) affected.add(String(l.product));

  const [jr, pr, mr, lr, ir] = await Promise.all([
    JournalEntry.deleteMany(refScope),
    Payable.deleteMany(refScope),
    InventoryMovement.deleteMany(refScope),
    InventoryLayer.deleteMany(refScope),
    PurchaseInvoice.deleteMany({ clinic: clinicId, _id: { $in: invoiceIds } }),
    // Activos fijos creados por estas facturas (sin depreciación; con depreciación se conservan).
    FixedAsset.deleteMany({ clinic: clinicId, purchaseInvoice: { $in: invoiceIds }, $or: [{ accumulatedDepreciation: { $lte: 0 } }, { accumulatedDepreciation: null }] }),
  ]);

  let recalced = 0;
  for (const pid of affected) {
    const prod = await Product.findOne({ _id: pid, clinic: clinicId });
    if (!prod) continue;
    const cur = await kardex.currentStock({ clinicId, product: prod._id });
    prod.stock = cur.qty;
    prod.averageCost = cur.averageCost;
    await prod.save();
    recalced++;
  }
  return {
    invoices: ir.deletedCount, journals: jr.deletedCount, payables: pr.deletedCount,
    movements: mr.deletedCount, layers: lr.deletedCount, productsRecalculated: recalced,
  };
}

exports.wipeAll = async (req, res) => {
  try {
    if (req.body?.confirm !== 'BORRAR-COMPRAS') {
      return res.status(400).json({ message: "Confirmación requerida: envía confirm: 'BORRAR-COMPRAS'" });
    }
    const invoices = await PurchaseInvoice.find({ clinic: req.clinicId }).select('_id items');
    if (!invoices.length) return res.json({ message: 'No hay compras para borrar', invoices: 0 });
    const result = await purgePurchaseInvoices(req.clinicId, invoices, { force: req.body?.force === true });
    res.json({ message: 'Compras borradas', ...result });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message, ...(e.payments ? { payments: e.payments } : {}) });
  }
};

/**
 * Borra UNA factura de compra (y sus artefactos). Útil para eliminar un comprobante
 * individual mal importado sin tener que reiniciar todas las compras.
 */
exports.remove = async (req, res) => {
  try {
    const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).select('_id items serie');
    if (!inv) return res.status(404).json({ message: 'No encontrada' });
    const result = await purgePurchaseInvoices(req.clinicId, [inv], { force: req.body?.force === true || req.query?.force === 'true' });
    res.json({ message: `Factura ${inv.serie || ''} eliminada`, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message, ...(e.payments ? { payments: e.payments } : {}) });
  }
};

/**
 * Importa facturas de compra desde XML del SRI (factura electrónica).
 * Body: { xmls: [string] } o { content: string } (un solo XML).
 * Las facturas se crean en estado POR_AUTORIZAR (carga automática): NO se
 * contabilizan hasta que el personal contable las verifique y autorice.
 */
exports.importXml = async (req, res) => {
  try {
    const xmls = Array.isArray(req.body?.xmls) ? req.body.xmls : (req.body?.content ? [req.body.content] : []);
    if (!xmls.length) return res.status(400).json({ message: 'No se recibieron XML' });
    let created = 0, skipped = 0;
    const errors = [];
    for (let i = 0; i < xmls.length; i++) {
      try {
        const p = parsePurchaseInvoiceXml(xmls[i]);
        if (!p.ruc) { errors.push({ index: i + 1, error: 'XML sin RUC' }); continue; }
        let sup = await Supplier.findOne({ clinic: req.clinicId, ruc: p.ruc });
        if (!sup) sup = await Supplier.create({ clinic: req.clinicId, ruc: p.ruc, razonSocial: p.razonSocial || p.ruc });
        // Evitar duplicados por clave de acceso o serie
        const dup = await PurchaseInvoice.findOne({ clinic: req.clinicId, $or: [{ claveAcceso: p.claveAcceso }, { supplier: sup._id, serie: p.serie }] });
        if (dup) { skipped++; continue; }
        const data = {
          clinic: req.clinicId, supplier: sup._id, docType: 'FACTURA',
          estab: p.estab, ptoEmi: p.ptoEmi, secuencial: p.secuencial, serie: p.serie,
          claveAcceso: p.claveAcceso, xmlClaveAcceso: p.claveAcceso, autorizacion: p.autorizacion,
          fechaEmision: p.fechaEmision,
          // Se deja SIN cuenta y SIN clasificar: el contador decide luego si cada línea
          // es gasto/inventario/activo (no se contamina con la cuenta de gasto por defecto).
          items: p.items.map((it) => ({ ...it, account: null, lineType: 'GASTO' })),
          status: 'POR_AUTORIZAR', importedFromXml: true, createdBy: req.user._id,
        };
        calcTotals(data);
        await PurchaseInvoice.create(data);
        created++;
      } catch (err) { errors.push({ index: i + 1, error: err.message }); }
    }
    res.json({ created, skipped, errors });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Autoriza una factura cargada automáticamente (POR_AUTORIZAR): valida que tenga
 * cuentas contables asignadas, la contabiliza y registra el inventario.
 */
exports.authorize = async (req, res) => {
  try {
    {
      const invoiceId = await runInTransaction(async (session) => {
        const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!inv) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (inv.status !== 'POR_AUTORIZAR') throw Object.assign(new Error('La factura no esta pendiente de autorizacion'), { status: 400 });
        // Autorizar = contabilizar por primera vez => strict: inventario/activo deben
        // resolver su cuenta desde la categoría contable (sin cuenta manual ni genérica).
        // Se clasifica sobre los ítems CRUDOS del body si vinieron (conserva `lineType`
        // explícito) antes del casteo; de lo contrario, sobre los ya almacenados.
        const supForItems = await Supplier.findById(req.body?.supplier || inv.supplier).session(session);
        if (req.body && Object.keys(req.body).length) {
          const { status, clinic, journalEntry, ...rest } = req.body;
          if (Array.isArray(rest.items)) {
            await classifyAndValidateItems(rest.items, { clinicId: req.clinicId, supplier: supForItems, session, strict: true });
          }
          Object.assign(inv, rest);
          if (inv.fechaEmision) inv.fechaEmision = new Date(inv.fechaEmision);
          calcTotals(inv);
        }
        await assertPeriodOpen(req.clinicId, inv.fechaEmision, { session });
        if (!(req.body && Array.isArray(req.body.items))) {
          await classifyAndValidateItems(inv.items, { clinicId: req.clinicId, supplier: supForItems, session, strict: true });
        }
        inv.status = 'REGISTRADA';
        inv.authorizedBy = req.user._id;
        inv.authorizedAt = new Date();
        inv.strictAccounts = true; // contabilizada bajo el flujo estricto
        await applyLineRetentions(inv, { clinicId: req.clinicId, session });
        await inv.save({ session });
        await postPurchaseJournal(inv, req, session, 'AUTHORIZE');
        await postInventoryEntries(inv, req, session);
        await syncFixedAssetsForInvoice(inv, req, session);
        const supForPayable = await Supplier.findById(inv.supplier).session(session);
        await openPayableForInvoice(inv, supForPayable, req, session);
        await rememberRecurringAccounts(inv, session);
        return inv._id;
      });
      const inv = await PurchaseInvoice.findById(invoiceId);
      return res.json(inv);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Edición manual del asiento contable (debe/haber) de una compra registrada.
 * El contador puede modificar libremente las líneas; se reversa el asiento actual y se
 * crea uno nuevo cuadrado (partida doble validada en createEntry). Body: { lines:[{account|accountCode, debit, credit, description}], date? }
 */
exports.editJournal = async (req, res) => {
  try {
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ message: 'El asiento debe tener al menos 2 líneas' });
    const invoiceId = await runInTransaction(async (session) => {
      const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!inv) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (inv.status === 'ANULADA') throw Object.assign(new Error('La compra está anulada'), { status: 400 });
      if (inv.status === 'POR_AUTORIZAR') throw Object.assign(new Error('Autoriza la compra antes de editar su asiento'), { status: 400 });
      await assertPeriodOpen(req.clinicId, inv.fechaEmision, { session });
      const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, reversalDate, { session });
      if (inv.journalEntry) {
        await reverseEntry({ clinicId: req.clinicId, entryId: inv.journalEntry, userId: req.user._id, reason: 'Edición manual de asiento de compra', date: reversalDate, session });
      }
      const entry = await createEntry({
        clinicId: req.clinicId, date: inv.fechaEmision, description: `Compra ${inv.serie || ''} (asiento editado)`,
        source: 'COMPRA', sourceRef: inv._id, sourceModel: 'PurchaseInvoice', sourceAction: `EDIT:${Date.now()}`,
        lines, userId: req.user._id, session,
      });
      inv.journalEntry = entry._id;
      await inv.save({ session });
      return inv._id;
    });
    const inv = await PurchaseInvoice.findById(invoiceId).populate('journalEntry');
    return res.json(inv);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
