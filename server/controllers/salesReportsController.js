const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const Sale = require('../models/Sale');
const ServiceCategory = require('../models/ServiceCategory');

const oid = (v) => new mongoose.Types.ObjectId(v);

/** Construye el rango de fechas a partir del query. */
function dateRange(req) {
  const { startDate, endDate } = req.query;
  const r = {};
  if (startDate) r.$gte = new Date(startDate);
  if (endDate) r.$lte = new Date(endDate + 'T23:59:59.999');
  return Object.keys(r).length ? r : null;
}

/** Resuelve la lista de productos seleccionados (servicios + categorías). */
async function resolveProductIds(req) {
  const ids = new Set();
  const prods = req.query.products ? String(req.query.products).split(',').filter(Boolean) : [];
  prods.forEach((p) => ids.add(String(p)));
  const cats = req.query.categories ? String(req.query.categories).split(',').filter(Boolean) : [];
  if (cats.length) {
    const found = await ServiceCategory.find({ _id: { $in: cats }, clinic: req.clinicId }).select('products');
    found.forEach((c) => (c.products || []).forEach((p) => ids.add(String(p))));
  }
  return [...ids];
}

/* ============================== CATEGORÍAS ============================== */
exports.listCategories = async (req, res) => {
  const items = await ServiceCategory.find({ clinic: req.clinicId }).populate('products', 'name code').sort({ name: 1 });
  res.json(items);
};

exports.createCategory = async (req, res) => {
  try {
    const c = await ServiceCategory.create({ ...req.body, clinic: req.clinicId, createdBy: req.user._id });
    res.status(201).json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateCategory = async (req, res) => {
  try {
    const c = await ServiceCategory.findOneAndUpdate({ _id: req.params.id, clinic: req.clinicId }, req.body, { new: true });
    if (!c) return res.status(404).json({ message: 'No encontrada' });
    res.json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.removeCategory = async (req, res) => {
  const c = await ServiceCategory.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
  if (!c) return res.status(404).json({ message: 'No encontrada' });
  res.json({ ok: true });
};

/* ============================== RESUMEN ============================== */
exports.summary = async (req, res) => {
  try {
    const range = dateRange(req);
    const productIds = await resolveProductIds(req);
    const baseMatch = { clinic: oid(req.clinicId) };
    if (range) baseMatch.createdAt = range;
    if (productIds.length) baseMatch['items.product'] = { $in: productIds.map(oid) };

    const completedMatch = { ...baseMatch, status: 'completada' };

    // Resumen general (documentos completados)
    const [general] = await Sale.aggregate([
      { $match: completedMatch },
      { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, discount: { $sum: '$discountTotal' }, tax: { $sum: '$taxAmount' }, total: { $sum: '$total' } } },
    ]);

    // Documentos anulados
    const [voided] = await Sale.aggregate([
      { $match: { ...baseMatch, status: 'anulada' } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
    ]);

    // Resumen de cobros (cómo se cobró) por método de pago
    const collections = await Sale.aggregate([
      { $match: completedMatch },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$total' } } },
      { $sort: { total: -1 } },
    ]);

    // Ventas por servicio (a nivel de ítem)
    const byService = await Sale.aggregate([
      { $match: completedMatch },
      { $unwind: '$items' },
      ...(productIds.length ? [{ $match: { 'items.product': { $in: productIds.map(oid) } } }] : []),
      { $group: { _id: '$items.product', name: { $first: '$items.productName' }, code: { $first: '$items.productCode' }, quantity: { $sum: '$items.quantity' }, total: { $sum: '$items.subtotal' }, discount: { $sum: '$items.discount' } } },
      { $sort: { total: -1 } },
    ]);

    // Serie de tiempo por día
    const timeSeries = await Sale.aggregate([
      { $match: completedMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, total: { $sum: '$total' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      general: general || { count: 0, subtotal: 0, discount: 0, tax: 0, total: 0 },
      voided: voided || { count: 0, total: 0 },
      documentCount: (general?.count || 0) + (voided?.count || 0),
      collections,
      byService,
      timeSeries: timeSeries.map((t) => ({ date: t._id, total: t.total, count: t.count })),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/* ============================== EXCEL DETALLADO ============================== */
exports.exportExcel = async (req, res) => {
  try {
    const range = dateRange(req);
    const productIds = await resolveProductIds(req);
    const match = { clinic: oid(req.clinicId), status: 'completada' };
    if (range) match.createdAt = range;
    if (productIds.length) match['items.product'] = { $in: productIds.map(oid) };

    const sales = await Sale.find(match).sort({ createdAt: 1 }).lean();
    const wb = new ExcelJS.Workbook();

    // Hoja 1: Detalle por ítem
    const ws = wb.addWorksheet('Detalle ventas');
    ws.columns = [
      { header: 'N° Venta', key: 'num', width: 14 },
      { header: 'Fecha', key: 'date', width: 18 },
      { header: 'Cliente', key: 'client', width: 28 },
      { header: 'Servicio', key: 'service', width: 32 },
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Cantidad', key: 'qty', width: 10 },
      { header: 'P. Unitario', key: 'unit', width: 12 },
      { header: 'Descuento', key: 'disc', width: 12 },
      { header: 'Subtotal', key: 'sub', width: 12 },
      { header: 'Método pago', key: 'method', width: 14 },
    ];
    const psel = new Set(productIds.map(String));
    for (const s of sales) {
      for (const it of s.items || []) {
        if (psel.size && !psel.has(String(it.product))) continue;
        ws.addRow({
          num: s.saleNumber, date: new Date(s.createdAt).toLocaleString('es-EC'),
          client: s.clientName, service: it.productName, code: it.productCode,
          qty: it.quantity, unit: it.unitPrice, disc: it.discount || 0, sub: it.subtotal, method: s.paymentMethod,
        });
      }
    }

    // Hoja 2: Resumen por servicio
    const ws2 = wb.addWorksheet('Resumen por servicio');
    ws2.columns = [
      { header: 'Servicio', key: 'name', width: 32 },
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Cantidad', key: 'qty', width: 12 },
      { header: 'Total', key: 'total', width: 14 },
    ];
    const agg = {};
    for (const s of sales) for (const it of s.items || []) {
      if (psel.size && !psel.has(String(it.product))) continue;
      const k = String(it.product);
      if (!agg[k]) agg[k] = { name: it.productName, code: it.productCode, qty: 0, total: 0 };
      agg[k].qty += it.quantity; agg[k].total += it.subtotal;
    }
    Object.values(agg).sort((a, b) => b.total - a.total).forEach((r) => ws2.addRow(r));

    [ws, ws2].forEach((w) => {
      w.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      w.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-ventas.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ message: e.message }); }
};
