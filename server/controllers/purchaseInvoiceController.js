const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const RecurringAccount = require('../models/RecurringAccount');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, voidPayable } = require('../utils/subledger');
const kardex = require('../utils/kardex');
const { parsePurchaseInvoiceXml } = require('../utils/sriXmlParser');

/**
 * Memoriza las cuentas de gasto usadas en una compra como "cuentas recurrentes"
 * (a nivel clínica y por proveedor) e incrementa su contador de uso. También deja
 * la última cuenta como `defaultExpenseAccount` del proveedor.
 */
async function rememberRecurringAccounts(inv, session) {
  const accountIds = new Set();
  for (const it of inv.items || []) {
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

exports.list = async (req, res) => {
  const { startDate, endDate, supplier, status, docType, q, page = 1, limit = 20 } = req.query;
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
  const total = await PurchaseInvoice.countDocuments(filter);
  const items = await PurchaseInvoice.find(filter)
    .populate('supplier', 'ruc razonSocial')
    .sort({ fechaEmision: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
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
        const data = { ...req.body, clinic: req.clinicId, createdBy: req.user._id };
        if (data.fechaEmision) data.fechaEmision = new Date(data.fechaEmision);
        calcTotals(data);
        await assertPeriodOpen(req.clinicId, data.fechaEmision || new Date(), { session });
        const sup = await Supplier.findOne({ _id: data.supplier, clinic: req.clinicId }).session(session);
        if (!sup) throw Object.assign(new Error('Proveedor no encontrado'), { status: 400 });
        if ((!data.items?.length || !data.items[0].account) && sup.defaultExpenseAccount) {
          if (data.items?.length) data.items[0].account = sup.defaultExpenseAccount;
        }
        const [inv] = await PurchaseInvoice.create([data], { session });
        await postPurchaseJournal(inv, req, session);
        await postInventoryEntries(inv, req, session);
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
  // Resolver cuenta de inventario por defecto (1.1.04.01) una sola vez
  let inventoryDefault = null;
  for (const it of inv.items || []) {
    // Distribución en varias cuentas: una línea por cada split (la suma debe igualar el subtotal)
    if (Array.isArray(it.accountSplits) && it.accountSplits.length) {
      const splitSum = it.accountSplits.reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
      if (Math.abs(splitSum - it.subtotal) > 0.01) {
        throw Object.assign(new Error(`La distribución de cuentas del ítem "${it.description}" (${splitSum.toFixed(2)}) no cuadra con su subtotal (${it.subtotal.toFixed(2)})`), { status: 400 });
      }
      for (const sp of it.accountSplits) {
        if (!sp.account || !(Number(sp.amount) > 0)) continue;
        lines.push({ account: sp.account, debit: +(Number(sp.amount)).toFixed(2), credit: 0, description: sp.description || it.description });
      }
      continue;
    }
    let accountId = it.account;
    // Si el ítem está ligado a un producto físico (no servicio/ilimitado) y NO se eligió
    // una cuenta manualmente, debitar la cuenta de inventario (activo).
    if (it.product && !it.account) {
      const prod = await Product.findOne({ _id: it.product, clinic: req.clinicId }).session(session || null);
      if (prod && !prod.unlimited && prod.category !== 'servicio') {
        if (prod.inventoryAccount) {
          accountId = prod.inventoryAccount;
        } else {
          if (!inventoryDefault) inventoryDefault = await getAccount(req.clinicId, 'inventario', { session });
          if (inventoryDefault) accountId = inventoryDefault._id;
        }
        // Persistir el account decidido para que el ítem refleje la cuenta usada
        it.account = accountId;
      }
    }
    if (!accountId) continue;
    lines.push({ account: accountId, debit: it.subtotal, credit: 0, description: it.description });
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
  // Retenciones (si se ingresan al mismo tiempo): se reducen las CxP del proveedor y se acreditan retenciones por pagar
  if (inv.retentionTotal > 0) {
    // Quitamos del crédito al proveedor y subimos retención por pagar
    lines[lines.length - 1].credit = +(lines[lines.length - 1].credit - inv.retentionTotal).toFixed(2);
    for (const r of inv.retentions) {
      const role = r.type === 'IVA' ? 'retIvaPorPagar' : 'retRentaPorPagar';
      const acc = await getAccount(req.clinicId, role, { session });
      lines.push({ account: acc._id, debit: 0, credit: r.amount, description: `Ret ${r.type} ${r.code || ''}` });
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

exports.update = async (req, res) => {
  try {
    {
      const invoiceId = await runInTransaction(async (session) => {
        const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!inv) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (inv.status !== 'REGISTRADA') throw Object.assign(new Error('No editable en su estado'), { status: 400 });
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
        Object.assign(inv, req.body);
        if (inv.fechaEmision) inv.fechaEmision = new Date(inv.fechaEmision);
        calcTotals(inv);
        await inv.save({ session });
        await postPurchaseJournal(inv, req, session, `UPDATE:${Date.now()}`);
        await postInventoryEntries(inv, req, session);
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
 */
exports.importTxt = async (req, res) => {
  try {
    const raw = req.body?.content || req.body?.text;
    if (!raw) return res.status(400).json({ message: 'content vacío' });
    const { rows, errors } = parseSriReport(raw);
    if (!rows.length && !errors.length) return res.status(400).json({ message: 'archivo vacío' });

    let created = 0;
    let skipped = 0;
    for (const r of rows) {
      try {
        let sup = await Supplier.findOne({ clinic: req.clinicId, ruc: r.ruc });
        if (!sup) sup = await Supplier.create({ clinic: req.clinicId, ruc: r.ruc, razonSocial: r.razonSocial || r.ruc });
        else if (r.razonSocial && (!sup.razonSocial || sup.razonSocial === sup.ruc)) { sup.razonSocial = r.razonSocial; await sup.save(); }

        // Evita duplicados por clave de acceso o por serie del mismo proveedor.
        if (r.serie || r.claveAcceso) {
          const dupFilter = r.claveAcceso
            ? { clinic: req.clinicId, $or: [{ claveAcceso: r.claveAcceso }, ...(r.serie ? [{ supplier: sup._id, serie: r.serie }] : [])] }
            : { clinic: req.clinicId, supplier: sup._id, serie: r.serie };
          const dup = await PurchaseInvoice.findOne(dupFilter);
          if (dup) { skipped++; continue; }
        }

        await PurchaseInvoice.create({
          clinic: req.clinicId, supplier: sup._id,
          docType: r.docType,
          estab: r.estab, ptoEmi: r.ptoEmi, secuencial: r.secuencial,
          serie: r.serie, claveAcceso: r.claveAcceso, autorizacion: r.claveAcceso,
          fechaEmision: r.fechaEmision,
          items: [{
            description: `Compra a ${sup.razonSocial || r.razonSocial || r.ruc} (importado SRI)`,
            quantity: 1, unitPrice: r.subtotal, discount: 0,
            subtotal: r.subtotal, ivaRate: r.ivaRate, ivaAmount: r.iva,
            account: sup.defaultExpenseAccount || null,
          }],
          // Conserva los montos EXACTOS del SRI (no se recalculan al importar).
          subtotal0: r.ivaRate === 0 ? r.subtotal : 0,
          subtotal12: r.ivaRate === 12 ? r.subtotal : 0,
          subtotal15: r.ivaRate === 15 ? r.subtotal : 0,
          subtotal: r.subtotal, iva: r.iva, total: r.total, balance: r.total,
          status: 'POR_AUTORIZAR', importedFromTxt: true, createdBy: req.user._id,
        });
        created++;
      } catch (err) { errors.push({ line: r.line, error: err.message }); }
    }
    res.json({ created, skipped, errors });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Exporta el parser puro para pruebas unitarias.
exports._parseSriReport = parseSriReport;

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
          items: p.items.map((it) => ({ ...it, account: sup.defaultExpenseAccount || null })),
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
        if (req.body && Object.keys(req.body).length) {
          const { status, clinic, journalEntry, ...rest } = req.body;
          Object.assign(inv, rest);
          if (inv.fechaEmision) inv.fechaEmision = new Date(inv.fechaEmision);
          calcTotals(inv);
        }
        await assertPeriodOpen(req.clinicId, inv.fechaEmision, { session });
        const sinCuenta = (inv.items || []).some((it) => !it.account && !(it.accountSplits || []).length && !it.product);
        if (sinCuenta) throw Object.assign(new Error('Asigna una cuenta contable a cada item antes de autorizar'), { status: 400 });
        inv.status = 'REGISTRADA';
        inv.authorizedBy = req.user._id;
        inv.authorizedAt = new Date();
        await inv.save({ session });
        await postPurchaseJournal(inv, req, session, 'AUTHORIZE');
        await postInventoryEntries(inv, req, session);
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
