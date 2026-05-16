const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, findAccount, reverseEntry } = require('../utils/accounting');

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
  const { startDate, endDate, supplier, status, q, page = 1, limit = 20 } = req.query;
  const filter = { clinic: req.clinicId };
  if (supplier) filter.supplier = supplier;
  if (status) filter.status = status;
  if (startDate || endDate) {
    filter.fechaEmision = {};
    if (startDate) filter.fechaEmision.$gte = new Date(startDate);
    if (endDate) filter.fechaEmision.$lte = new Date(endDate);
  }
  if (q) filter.$or = [{ serie: new RegExp(q, 'i') }, { autorizacion: new RegExp(q, 'i') }];
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
    const data = { ...req.body, clinic: req.clinicId, createdBy: req.user._id };
    if (data.fechaEmision) data.fechaEmision = new Date(data.fechaEmision);
    calcTotals(data);
    // Recordar cuenta por defecto del proveedor: usar la primera del primer ítem si trae account
    const sup = await Supplier.findOne({ _id: data.supplier, clinic: req.clinicId });
    if (!sup) return res.status(400).json({ message: 'Proveedor no encontrado' });
    if ((!data.items?.length || !data.items[0].account) && sup.defaultExpenseAccount) {
      if (data.items?.length) data.items[0].account = sup.defaultExpenseAccount;
    }
    const inv = await PurchaseInvoice.create(data);
    // Memorizar cuenta de gasto del primer item
    if (inv.items?.[0]?.account) {
      sup.defaultExpenseAccount = inv.items[0].account;
      await sup.save();
    }
    // Asiento de compra: DB Gasto/Inventario por cada item + DB IVA en compras / CR Proveedores
    await postPurchaseJournal(inv, req);
    res.status(201).json(inv);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

async function postPurchaseJournal(inv, req) {
  const lines = [];
  for (const it of inv.items || []) {
    if (!it.account) continue;
    lines.push({ account: it.account, debit: it.subtotal, credit: 0, description: it.description });
  }
  if (inv.iva > 0) {
    const ivaAcc = await findAccount(req.clinicId, { taxCode: 'IVA_COMPRAS' });
    lines.push({ account: ivaAcc._id, debit: inv.iva, credit: 0, description: 'IVA en compras' });
  }
  const sup = await Supplier.findById(inv.supplier);
  const provAcc = sup?.defaultPayableAccount
    ? await ChartOfAccount.findById(sup.defaultPayableAccount)
    : await findAccount(req.clinicId, { code: '2.1.01.01' });
  lines.push({ account: provAcc._id, debit: 0, credit: inv.total, description: `Factura ${inv.serie || ''}` });
  // Retenciones (si se ingresan al mismo tiempo): se reducen las CxP del proveedor y se acreditan retenciones por pagar
  if (inv.retentionTotal > 0) {
    // Quitamos del crédito al proveedor y subimos retención por pagar
    lines[lines.length - 1].credit = +(lines[lines.length - 1].credit - inv.retentionTotal).toFixed(2);
    for (const r of inv.retentions) {
      const code = r.type === 'IVA' ? '2.1.02.03' : '2.1.02.04';
      const acc = await findAccount(req.clinicId, { code });
      lines.push({ account: acc._id, debit: 0, credit: r.amount, description: `Ret ${r.type} ${r.code || ''}` });
    }
  }
  const entry = await createEntry({
    clinicId: req.clinicId, date: inv.fechaEmision, description: `Compra ${inv.serie || ''}`,
    source: 'COMPRA', sourceRef: inv._id, sourceModel: 'PurchaseInvoice',
    lines, userId: req.user._id,
  });
  inv.journalEntry = entry._id;
  await inv.save();
}

exports.update = async (req, res) => {
  try {
    const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!inv) return res.status(404).json({ message: 'No encontrada' });
    if (inv.status !== 'REGISTRADA') return res.status(400).json({ message: 'No editable en su estado' });
    if (inv.journalEntry) await reverseEntry({ clinicId: req.clinicId, entryId: inv.journalEntry, userId: req.user._id, reason: 'Edición de compra' });
    Object.assign(inv, req.body);
    calcTotals(inv);
    await inv.save();
    await postPurchaseJournal(inv, req);
    res.json(inv);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.void = async (req, res) => {
  try {
    const inv = await PurchaseInvoice.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!inv) return res.status(404).json({ message: 'No encontrada' });
    if (inv.status === 'ANULADA') return res.status(400).json({ message: 'Ya anulada' });
    if (inv.journalEntry) await reverseEntry({ clinicId: req.clinicId, entryId: inv.journalEntry, userId: req.user._id, reason: 'Anulación' });
    inv.status = 'ANULADA';
    await inv.save();
    res.json({ message: 'Anulada' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Importa archivo TXT del SRI (consulta de comprobantes recibidos).
 * Espera líneas con: RUC|RazonSocial|Tipo|Serie|Autorizacion|Fecha|Subtotal|IVA|Total
 * El formato real del SRI varía (TSV con cabecera); este parser es flexible.
 */
exports.importTxt = async (req, res) => {
  try {
    const raw = req.body?.content;
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
