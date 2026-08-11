const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const Sale = require('../models/Sale');
const ServiceCategory = require('../models/ServiceCategory');
const SalesReportPreset = require('../models/SalesReportPreset');
const salesReport = require('../services/salesReportService');
const { addSalesSheet, findSalesForSheet } = require('../services/salesWorkbook');

const oid = (v) => new mongoose.Types.ObjectId(v);
const fail = (res, e) => res.status(e.status || 400).json({ message: e.message });

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

/* ============================== REPORTE DETALLADO (motor único) ============================== */

/**
 * Reporte de ventas conciliable: documentos, detalle, pagos y resumen, del MISMO servicio que
 * alimenta el Excel. Los métodos de pago salen de `Sale.payments[]` (una venta mixta suma en
 * cada columna), no del campo resumen `paymentMethod`.
 */
exports.report = async (req, res) => {
  try {
    const data = await salesReport.buildSalesReport(req.clinicId, req.query);
    res.json(data);
  } catch (e) { fail(res, e); }
};

/* ============================== EXCEL CONCILIABLE (4 hojas) ============================== */
const MONEY = '"$"#,##0.00';
const head = (ws, argb = 'FF047857') => {
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
};

/**
 * Excel del reporte de ventas: cuatro hojas que concilian entre sí y con la API.
 * Los valores los calcula el BACKEND (no hay fórmulas que puedan cambiar al abrir el archivo).
 */
exports.exportReportExcel = async (req, res) => {
  try {
    const data = await salesReport.buildSalesReport(req.clinicId, req.query);
    const wb = new ExcelJS.Workbook();

    // ── Ventas: una fila por documento ──────────────────────────────────────────────────
    const ws = wb.addWorksheet('Ventas');
    ws.columns = [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Venta', key: 'venta', width: 14 },
      { header: 'Factura', key: 'factura', width: 18 },
      { header: 'Autorización', key: 'aut', width: 22 },
      { header: 'Cliente', key: 'cliente', width: 28 },
      { header: 'Identificación', key: 'ident', width: 16 },
      { header: 'Subtotal 0%', key: 's0', width: 13 },
      { header: 'Subtotal gravado', key: 'sg', width: 16 },
      { header: 'Descuento', key: 'desc', width: 12 },
      { header: 'IVA', key: 'iva', width: 12 },
      { header: 'Total', key: 'total', width: 13 },
      { header: 'Cobrado', key: 'cobrado', width: 13 },
      { header: 'Saldo (CxC)', key: 'saldo', width: 13 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Centro de costo', key: 'cc', width: 18 },
      { header: 'Pagos legacy', key: 'legacy', width: 14 },
    ];
    head(ws);
    for (const d of data.documentos) {
      ws.addRow({
        fecha: new Date(d.date).toLocaleDateString('es-EC'),
        venta: d.numero, factura: d.factura, aut: d.autorizacion,
        cliente: d.cliente, ident: d.identificacion,
        s0: d.subtotal0, sg: d.subtotalGravado, desc: d.descuento, iva: d.iva,
        total: d.total, cobrado: d.cobrado, saldo: d.saldo, estado: d.estado,
        // El centro de costo REAL con el que se registró la venta, por su nombre.
        cc: d.costCenterName || (d.costCenter ? String(d.costCenter) : ''),
        legacy: d.legacy ? 'SÍ (sin desglose)' : '',
      });
    }
    ['s0', 'sg', 'desc', 'iva', 'total', 'cobrado', 'saldo'].forEach((k) => { ws.getColumn(k).numFmt = MONEY; });

    // ── Detalle: una fila por línea (el total del documento NO se repite) ────────────────
    const wd = wb.addWorksheet('Detalle');
    wd.columns = [
      { header: 'Venta', key: 'venta', width: 14 },
      { header: 'Factura', key: 'factura', width: 18 },
      { header: 'Categoría', key: 'cat', width: 20 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Código', key: 'cod', width: 14 },
      { header: 'Producto / servicio', key: 'prod', width: 32 },
      { header: 'Cantidad', key: 'qty', width: 10 },
      { header: 'Precio', key: 'precio', width: 12 },
      { header: 'Descuento', key: 'desc', width: 12 },
      { header: 'Subtotal', key: 'sub', width: 12 },
      { header: 'IVA', key: 'iva', width: 12 },
      { header: 'Total línea', key: 'total', width: 13 },
    ];
    head(wd, 'FF0369A1');
    for (const l of data.detalle) {
      wd.addRow({
        venta: l.venta, factura: l.factura, cat: l.categoria || '(sin categoría)', tipo: l.tipo,
        cod: l.codigo, prod: l.producto, qty: l.cantidad, precio: l.precio,
        desc: l.descuento, sub: l.subtotal, iva: l.iva, total: l.totalLinea,
      });
    }
    ['precio', 'desc', 'sub', 'iva', 'total'].forEach((k) => { wd.getColumn(k).numFmt = MONEY; });

    // ── Pagos: una fila por pago real (la CxC no es un pago) ─────────────────────────────
    const wp = wb.addWorksheet('Pagos');
    wp.columns = [
      { header: 'Venta', key: 'venta', width: 14 },
      { header: 'Factura', key: 'factura', width: 18 },
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Método', key: 'metodo', width: 18 },
      { header: 'Tipo de tarjeta', key: 'tarjeta', width: 14 },
      { header: 'Cuenta', key: 'cuenta', width: 20 },
      { header: 'Referencia', key: 'ref', width: 20 },
      { header: 'Importe', key: 'importe', width: 13 },
      { header: 'Origen', key: 'origen', width: 14 },
      { header: 'Legacy', key: 'legacy', width: 10 },
    ];
    head(wp, 'FF7C3AED');
    for (const p of data.pagos) {
      wp.addRow({
        venta: p.venta, factura: p.factura,
        fecha: p.date ? new Date(p.date).toLocaleDateString('es-EC') : '',
        metodo: p.method, tarjeta: p.cardType || '',
        cuenta: p.bankAccount ? String(p.bankAccount) : '',
        ref: p.referencia, importe: p.importe,
        origen: p.origen === 'COBRO_CXC' ? 'Cobro de CxC' : 'Venta',
        legacy: p.legacy ? 'SÍ' : '',
      });
    }
    wp.getColumn('importe').numFmt = MONEY;

    // ── Resumen: totales por categoría, ítem, método y centro de costo ───────────────────
    const wr = wb.addWorksheet('Resumen');
    wr.columns = [
      { header: 'Concepto', key: 'concepto', width: 36 },
      { header: 'Valor', key: 'valor', width: 16 },
    ];
    head(wr, 'FF1F2937');
    const bloque = (titulo, obj) => {
      const t = wr.addRow({ concepto: titulo });
      t.font = { bold: true };
      for (const [k, v] of Object.entries(obj)) wr.addRow({ concepto: `  ${k}`, valor: v });
    };
    bloque('TOTALES', {
      'Subtotal 0%': data.resumen.subtotal0,
      'Subtotal gravado': data.resumen.subtotalGravado,
      Descuento: data.resumen.descuento,
      IVA: data.resumen.iva,
      Total: data.resumen.total,
      Cobrado: data.resumen.cobrado,
      'Pendiente (CxC)': data.resumen.pendiente,
    });
    bloque('POR MÉTODO DE PAGO', data.resumen.porMetodo);
    bloque('POR CATEGORÍA', data.resumen.porCategoria);
    bloque('POR PRODUCTO / SERVICIO', data.resumen.porProducto);
    bloque('POR CENTRO DE COSTO', data.resumen.porCentroCosto);
    wr.getColumn('valor').numFmt = MONEY;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte-ventas.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { fail(res, e); }
};

/* ============================== EXCEL CONTABLE (formato de la pantalla de Ventas) ============================== */

/**
 * El MISMO Excel que se descarga desde la pantalla de Ventas: una fila por venta con el
 * desglose por forma de pago, la factura y el estado del SRI.
 *
 * Por qué existe: el reporte conciliable de cuatro hojas es útil para auditar, pero la
 * contadora trabaja con la planilla de Ventas y no le servía otro formato. En vez de
 * copiar columnas (que se desincronizan al primer cambio), las dos pantallas arman la
 * hoja con `services/salesWorkbook`. Aquí, además, se respetan los filtros de producto y
 * categoría del reporte: la planilla sale acotada a lo que se está mirando.
 */
exports.exportSalesSheetExcel = async (req, res) => {
  try {
    const range = dateRange(req);
    const productIds = await resolveProductIds(req);
    const sales = await findSalesForSheet(req.clinicId, {
      range,
      status: req.query.status,
      productIds: productIds.map(oid),
    });
    const wb = new ExcelJS.Workbook();
    addSalesSheet(wb, sales);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="ventas.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { fail(res, e); }
};

/* ============================== PRESETS ============================== */

exports.listPresets = async (req, res) => {
  try {
    const q = { clinic: req.clinicId };
    if (req.query.active !== undefined) q.active = req.query.active !== 'false';
    const items = await SalesReportPreset.find(q)
      .populate('includeCategories excludeCategories', 'name')
      .sort({ name: 1 }).lean();
    res.json(items);
  } catch (e) { fail(res, e); }
};

/** Crea un preset. El nombre es único por clínica: se responde 409, nunca un E11000 crudo. */
exports.createPreset = async (req, res) => {
  const b = req.body || {};
  try {
    if (!String(b.name || '').trim()) throw Object.assign(new Error('El preset necesita un nombre.'), { status: 400 });
    const nameKey = SalesReportPreset.normalizeName(b.name);
    const p = await SalesReportPreset.create({
      clinic: req.clinicId,
      name: String(b.name).trim(),
      nameKey,
      description: b.description || '',
      includeCategories: b.includeCategories || [],
      excludeCategories: b.excludeCategories || [],
      includeProducts: b.includeProducts || [],
      excludeProducts: b.excludeProducts || [],
      filters: b.filters || {},
      createdBy: req.user._id,
    });
    res.status(201).json(p);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({
        message: `Ya existe un preset llamado "${String(b.name).trim()}" en esta clínica. `
          + 'Usa otro nombre o edita el que ya existe.',
      });
    }
    fail(res, e);
  }
};

exports.updatePreset = async (req, res) => {
  const b = req.body || {};
  try {
    const p = await SalesReportPreset.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) throw Object.assign(new Error('Preset no encontrado'), { status: 404 });
    if (b.name !== undefined) {
      p.name = String(b.name).trim();
      p.nameKey = SalesReportPreset.normalizeName(b.name);
    }
    for (const k of ['description', 'includeCategories', 'excludeCategories', 'includeProducts', 'excludeProducts', 'filters', 'active']) {
      if (b[k] !== undefined) p[k] = b[k];
    }
    p.updatedBy = req.user._id;
    await p.save();
    res.json(p);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'Ya existe otro preset con ese nombre.' });
    fail(res, e);
  }
};

/** Duplica un preset (con un nombre libre): la contadora parte de uno y lo ajusta. */
exports.duplicatePreset = async (req, res) => {
  try {
    const base = await SalesReportPreset.findOne({ _id: req.params.id, clinic: req.clinicId }).lean();
    if (!base) throw Object.assign(new Error('Preset no encontrado'), { status: 404 });
    let name = req.body?.name || `${base.name} (copia)`;
    let n = 2;
    // Nombre libre: no se pisa el de nadie ni se responde con un error de índice.
    /* eslint-disable no-await-in-loop */
    while (await SalesReportPreset.findOne({ clinic: req.clinicId, nameKey: SalesReportPreset.normalizeName(name) })) {
      name = `${base.name} (copia ${n})`;
      n += 1;
    }
    /* eslint-enable no-await-in-loop */
    const copia = await SalesReportPreset.create({
      ...base,
      _id: undefined,
      name,
      nameKey: SalesReportPreset.normalizeName(name),
      createdBy: req.user._id,
      updatedBy: null,
      createdAt: undefined,
      updatedAt: undefined,
    });
    res.status(201).json(copia);
  } catch (e) { fail(res, e); }
};

exports.removePreset = async (req, res) => {
  try {
    const p = await SalesReportPreset.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!p) throw Object.assign(new Error('Preset no encontrado'), { status: 404 });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
};

/* ============================== EXCEL LEGACY (compatibilidad) ============================== */
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
