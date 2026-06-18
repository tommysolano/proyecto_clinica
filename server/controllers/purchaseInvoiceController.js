const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, voidPayable } = require('../utils/subledger');
const kardex = require('../utils/kardex');
const { parsePurchaseInvoiceXml } = require('../utils/sriXmlParser');

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
        if (inv.items?.[0]?.account) {
          sup.defaultExpenseAccount = inv.items[0].account;
          await sup.save({ session });
        }
        await postPurchaseJournal(inv, req, session);
        await postInventoryEntries(inv, req, session);
        await openPayableForInvoice(inv, sup, req, session);
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

/**
 * Importa archivo TXT del SRI (consulta de comprobantes recibidos).
 * Espera líneas con: RUC|RazonSocial|Tipo|Serie|Autorizacion|Fecha|Subtotal|IVA|Total
 * El formato real del SRI varía (TSV con cabecera); este parser es flexible.
 */
exports.importTxt = async (req, res) => {
  try {
    const raw = req.body?.content || req.body?.text;
    if (!raw) return res.status(400).json({ message: 'content vacío' });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let created = 0;
    let skipped = 0;
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detección heurística: descarta cabecera si contiene "RUC" o "FECHA"
      if (/^(RUC|FECHA|Tipo)/i.test(line)) continue;
      const cols = line.split(/[\t|;]/).map((c) => c.trim());
      if (cols.length < 6) { errors.push({ line: i + 1, error: 'Columnas insuficientes' }); continue; }
      try {
        const [ruc, razon, tipo, serie, autorizacion, fechaStr, subtotalStr, ivaStr, totalStr] = cols;
        let sup = await Supplier.findOne({ clinic: req.clinicId, ruc });
        if (!sup) {
          sup = await Supplier.create({ clinic: req.clinicId, ruc, razonSocial: razon || ruc });
        }
        const fecha = new Date(fechaStr.split('/').reverse().join('-'));
        const dup = await PurchaseInvoice.findOne({ clinic: req.clinicId, supplier: sup._id, serie });
        if (dup) { skipped++; continue; }
        const subtotal = parseFloat(subtotalStr) || 0;
        const iva = parseFloat(ivaStr) || 0;
        const total = parseFloat(totalStr) || (subtotal + iva);
        const ivaRate = subtotal > 0 ? Math.round((iva / subtotal) * 100) : 0;
        const itemDescription = `Compra a ${sup.razonSocial} (importado SRI)`;
        const data = {
          clinic: req.clinicId, supplier: sup._id,
          docType: tipo === 'NC' ? 'NOTA_CREDITO_REC' : 'FACTURA',
          serie, autorizacion, fechaEmision: fecha,
          items: [{
            description: itemDescription, quantity: 1, unitPrice: subtotal,
            subtotal, ivaRate: ivaRate || 0, ivaAmount: iva,
            account: sup.defaultExpenseAccount || null,
          }],
          importedFromTxt: true, createdBy: req.user._id,
        };
        calcTotals(data);
        const inv = await PurchaseInvoice.create(data);
        if (inv.items[0].account) await postPurchaseJournal(inv, req);
        created++;
      } catch (err) { errors.push({ line: i + 1, error: err.message }); }
    }
    res.json({ created, skipped, errors });
  } catch (e) {
    res.status(500).json({ message: e.message });
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
        return inv._id;
      });
      const inv = await PurchaseInvoice.findById(invoiceId);
      return res.json(inv);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
