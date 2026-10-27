'use strict';

// Centro de costo de los documentos de Contífico, para filtrar por sucursal.
//
// Se conserva el centro que Contífico puso en cada documento. Un documento sin
// centro sigue sin centro, aunque su asiento tenga una atribución distinta.
//   - Compras: el centro de cada línea es el del documento.
//   - CxP / CxC: el centro de su compra / venta.
//   - Facturas: el centro de su venta.
//   - Cobros y pagos: el centro del primer documento aplicado.
// Es idempotente: se recalcula siempre desde el origen, nunca acumula.
const Record = require('../models/ContificoRecord');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const Payment = require('../models/Payment');
const CostCenter = require('../models/CostCenter');
const { catalogClinics } = require('./contificoCatalogScope');
const { decodeCompressedJson } = require('../utils/compressedJson');

const same = (left, right) => String(left || '') === String(right || '');

/** externalId de Contífico → _id local del centro, por código. */
async function centerMap(clinicId) {
  const catalog = await catalogClinics(clinicId);
  const [records, centers] = await Promise.all([
    Record.find({ clinic: clinicId, entity: 'cost_center' }).select('externalId payloadCompressed').lean(),
    CostCenter.find({ clinic: { $in: catalog.ids } }).select('code').lean(),
  ]);
  const byCode = new Map(centers.map((center) => [String(center.code), center._id]));
  return new Map(records.map((record) => [record.externalId,
    byCode.get(String(decodeCompressedJson(record.payloadCompressed).codigo)) || null]));
}

/** Centro de cada línea tal como está en el documento de Contífico. */
function itemCenters(items, details, centers) {
  return items.map((item, index) => centers.get(String(details[index]?.centro_costo_id || '')) || null);
}

/**
 * Recalcula los centros de las compras, la cartera y los cobros/pagos de un rango
 * de fechas de emisión. Devuelve cuántos cambió de cada tipo.
 */
async function refreshCostCenters({ clinicId, from, to, commit = true }) {
  const centers = await centerMap(clinicId);
  const range = { $gte: from, $lte: to };
  const result = { purchases: 0, payables: 0, receivables: 0, invoices: 0, payments: 0, withoutCenter: 0 };

  const purchases = await PurchaseInvoice.find({ clinic: clinicId, sourceModel: 'ContificoRecord', fechaEmision: range })
    .select('sourceRef fechaEmision total retentionTotal costCenter items._id items.subtotal items.costCenter').lean();
  const records = await Record.find({ _id: { $in: purchases.map((purchase) => purchase.sourceRef) } })
    .select('payloadCompressed').lean();
  const payloadById = new Map(records.map((record) => [String(record._id), decodeCompressedJson(record.payloadCompressed)]));
  const purchaseOps = [];
  const purchaseCenter = new Map();
  for (const purchase of purchases) {
    const row = payloadById.get(String(purchase.sourceRef));
    if (!row) continue;
    const details = row.detalles || [];
    const lineCenters = itemCenters(purchase.items, details, centers);
    const header = lineCenters.find(Boolean) || null;
    purchaseCenter.set(String(purchase.sourceRef), header);
    if (!header) result.withoutCenter += 1;
    const changed = !same(purchase.costCenter, header)
      || purchase.items.some((item, index) => !same(item.costCenter, lineCenters[index]));
    if (!changed) continue;
    const $set = { costCenter: header };
    purchase.items.forEach((item, index) => { $set[`items.${index}.costCenter`] = lineCenters[index]; });
    purchaseOps.push({ updateOne: { filter: { _id: purchase._id }, update: { $set } } });
  }
  result.purchases = purchaseOps.length;

  // CxP: el centro de su compra. CxC: el de su venta (venta = contifico:<id>).
  const [payables, receivables] = await Promise.all([
    Payable.find({ clinic: clinicId, sourceModel: 'ContificoRecord', issueDate: range }).select('sourceRef costCenter').lean(),
    Receivable.find({ clinic: clinicId, sourceModel: 'ContificoRecord', issueDate: range }).select('sourceRef costCenter').lean(),
  ]);
  const missingPurchases = payables.filter((payable) => !purchaseCenter.has(String(payable.sourceRef))).map((payable) => payable.sourceRef);
  if (missingPurchases.length) {
    for (const purchase of await PurchaseInvoice.find({ clinic: clinicId, sourceModel: 'ContificoRecord',
      sourceRef: { $in: missingPurchases } }).select('sourceRef costCenter').lean()) purchaseCenter.set(String(purchase.sourceRef), purchase.costCenter);
  }
  const payableOps = payables.filter((payable) => purchaseCenter.has(String(payable.sourceRef))
    && !same(payable.costCenter, purchaseCenter.get(String(payable.sourceRef))))
    .map((payable) => ({ updateOne: { filter: { _id: payable._id },
      update: { $set: { costCenter: purchaseCenter.get(String(payable.sourceRef)) || null } } } }));
  const receivableRecords = await Record.find({ _id: { $in: receivables.map((item) => item.sourceRef) } }).select('externalId').lean();
  const keyByRecord = new Map(receivableRecords.map((record) => [String(record._id), `contifico:${record.externalId}`]));
  const salesByKey = new Map((await Sale.find({ clinic: clinicId, idempotencyKey: { $in: [...keyByRecord.values()] } })
    .select('idempotencyKey costCenter').lean()).map((sale) => [sale.idempotencyKey, sale]));
  const receivableOps = receivables.flatMap((receivable) => {
    const sale = salesByKey.get(keyByRecord.get(String(receivable.sourceRef)));
    if (!sale || same(receivable.costCenter, sale.costCenter)) return [];
    return [{ updateOne: { filter: { _id: receivable._id }, update: { $set: { costCenter: sale.costCenter || null } } } }];
  });
  result.payables = payableOps.length;
  result.receivables = receivableOps.length;

  if (commit) {
    if (purchaseOps.length) await PurchaseInvoice.bulkWrite(purchaseOps, { ordered: false });
    if (payableOps.length) await Payable.bulkWrite(payableOps, { ordered: false });
    if (receivableOps.length) await Receivable.bulkWrite(receivableOps, { ordered: false });
  }

  // Facturas: el centro de su venta (la factura importada lleva la fecha de la venta).
  const invoices = await Invoice.find({ clinic: clinicId, createdAt: range, sale: { $ne: null } }).select('sale costCenter').lean();
  const invoiceSales = new Map((await Sale.find({ _id: { $in: invoices.map((invoice) => invoice.sale) } })
    .select('costCenter').lean()).map((sale) => [String(sale._id), sale.costCenter || null]));
  const invoiceOps = invoices.flatMap((invoice) => {
    if (!invoiceSales.has(String(invoice.sale))) return [];
    const center = invoiceSales.get(String(invoice.sale));
    if (same(invoice.costCenter, center)) return [];
    return [{ updateOne: { filter: { _id: invoice._id }, update: { $set: { costCenter: center } } } }];
  });
  result.invoices = invoiceOps.length;
  if (commit) {
    for (let offset = 0; offset < invoiceOps.length; offset += 1000) {
      await Invoice.bulkWrite(invoiceOps.slice(offset, offset + 1000), { ordered: false });
    }
  }

  // Cobros y pagos del rango: el centro del primer documento aplicado que lo tenga.
  const payments = await Payment.find({ clinic: clinicId, date: range, 'applications.0': { $exists: true } })
    .select('applications.docModel applications.docRef costCenter').lean();
  const refs = (model) => payments.flatMap((payment) => payment.applications)
    .filter((application) => application.docModel === model).map((application) => application.docRef);
  const docCenter = new Map();
  const [paidSales, paidPurchases] = await Promise.all([
    Sale.find({ _id: { $in: refs('Sale') } }).select('costCenter').lean(),
    PurchaseInvoice.find({ _id: { $in: refs('PurchaseInvoice') } }).select('costCenter').lean(),
  ]);
  for (const doc of [...paidSales, ...paidPurchases]) docCenter.set(String(doc._id), doc.costCenter || null);
  const paymentOps = payments.flatMap((payment) => {
    const center = payment.applications.map((application) => docCenter.get(String(application.docRef))).find(Boolean) || null;
    if (same(payment.costCenter, center)) return [];
    return [{ updateOne: { filter: { _id: payment._id }, update: { $set: { costCenter: center } } } }];
  });
  result.payments = paymentOps.length;
  if (commit && paymentOps.length) {
    for (let offset = 0; offset < paymentOps.length; offset += 1000) {
      await Payment.bulkWrite(paymentOps.slice(offset, offset + 1000), { ordered: false });
    }
  }
  return result;
}

module.exports = { refreshCostCenters, itemCenters };
