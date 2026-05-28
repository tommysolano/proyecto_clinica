const Warehouse = require('../models/Warehouse');
const InventoryCategory = require('../models/InventoryCategory');
const PhysicalCount = require('../models/PhysicalCount');
const FixedAsset = require('../models/FixedAsset');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const { createEntry, findAccount } = require('../utils/accounting');
const ExcelJS = require('exceljs');
const multer = require('multer');

exports.uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

// Columnas de la plantilla de productos
const PRODUCT_TEMPLATE_COLUMNS = [
  { header: 'codigo', key: 'code', width: 16 },
  { header: 'nombre', key: 'name', width: 32 },
  { header: 'categoria', key: 'category', width: 16 },
  { header: 'unidad', key: 'unit', width: 12 },
  { header: 'precio_compra', key: 'purchasePrice', width: 14 },
  { header: 'precio_venta', key: 'salePrice', width: 14 },
  { header: 'stock', key: 'stock', width: 10 },
  { header: 'stock_minimo', key: 'minStock', width: 12 },
  { header: 'iva', key: 'taxRate', width: 8 },
  { header: 'ilimitado', key: 'unlimited', width: 10 },
];

/** Descarga la plantilla Excel para carga masiva de productos. */
exports.downloadProductTemplate = async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = PRODUCT_TEMPLATE_COLUMNS;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    // Fila de ejemplo
    ws.addRow({ code: 'P001', name: 'Producto ejemplo', category: 'insumo', unit: 'unidad', purchasePrice: 5, salePrice: 10, stock: 100, minStock: 10, taxRate: 15, unlimited: 'NO' });
    // Hoja de ayuda
    const help = wb.addWorksheet('Instrucciones');
    help.addRow(['categoria: medicamento, insumo, servicio, programa, otro']);
    help.addRow(['ilimitado: SI (servicios sin stock) o NO']);
    help.addRow(['iva: 0, 12 o 15']);
    help.addRow(['No borre la fila de encabezados. Puede borrar la fila de ejemplo.']);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_productos.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Importa productos desde un archivo Excel subido (multipart, campo `file`). */
exports.importProductsExcel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ message: 'El archivo no tiene hojas' });

    // Mapear encabezados (fila 1) a claves
    const headerMap = {};
    ws.getRow(1).eachCell((cell, col) => {
      const h = String(cell.value || '').trim().toLowerCase();
      const def = PRODUCT_TEMPLATE_COLUMNS.find((c) => c.header === h);
      if (def) headerMap[col] = def.key;
    });
    if (!Object.values(headerMap).includes('code') || !Object.values(headerMap).includes('name')) {
      return res.status(400).json({ message: 'La plantilla debe tener al menos las columnas codigo y nombre' });
    }

    const validCats = ['medicamento', 'insumo', 'servicio', 'programa', 'otro'];
    let created = 0, updated = 0;
    const errors = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const data = {};
      Object.entries(headerMap).forEach(([col, key]) => {
        let v = row.getCell(parseInt(col)).value;
        if (v && typeof v === 'object' && 'result' in v) v = v.result; // fórmula
        if (v && typeof v === 'object' && 'text' in v) v = v.text; // rich text
        data[key] = v;
      });
      if (!data.code || !data.name) continue;
      const product = {
        code: String(data.code).trim(),
        name: String(data.name).trim(),
        category: validCats.includes(String(data.category || '').toLowerCase()) ? String(data.category).toLowerCase() : 'otro',
        unit: data.unit ? String(data.unit).trim() : 'unidad',
        purchasePrice: Number(data.purchasePrice) || 0,
        salePrice: Number(data.salePrice) || 0,
        stock: Number(data.stock) || 0,
        minStock: Number(data.minStock) || 0,
        taxRate: data.taxRate !== undefined && data.taxRate !== null && data.taxRate !== '' ? Number(data.taxRate) : 15,
        unlimited: ['SI', 'SÍ', 'TRUE', '1', 'X'].includes(String(data.unlimited || '').trim().toUpperCase()),
      };
      try {
        const exists = await Product.findOne({ clinic: req.clinicId, code: product.code });
        if (exists) { Object.assign(exists, product); await exists.save(); updated++; }
        else { await Product.create({ ...product, clinic: req.clinicId }); created++; }
      } catch (e) { errors.push(`Fila ${r}: ${e.message}`); }
    }
    res.json({ created, updated, errors });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ----- Bodegas -----
exports.listWarehouses = async (req, res) => {
  const items = await Warehouse.find({ clinic: req.clinicId }).populate('chartAccount', 'code name').sort({ code: 1 });
  res.json(items);
};
exports.createWarehouse = async (req, res) => {
  try { const w = await Warehouse.create({ ...req.body, clinic: req.clinicId }); res.status(201).json(w); }
  catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateWarehouse = async (req, res) => {
  try {
    const w = await Warehouse.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!w) return res.status(404).json({ message: 'No encontrada' });
    Object.assign(w, req.body); await w.save(); res.json(w);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.deleteWarehouse = async (req, res) => {
  const w = await Warehouse.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!w) return res.status(404).json({ message: 'No encontrada' });
  await w.deleteOne(); res.json({ message: 'Eliminada' });
};

// ----- Categorías -----
exports.listCategories = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.kind) filter.kind = req.query.kind;
  const items = await InventoryCategory.find(filter)
    .populate('assetAccount depreciationAccount accumDepreciationAccount expenseAccount incomeAccount', 'code name')
    .sort({ code: 1 });
  res.json(items);
};
exports.createCategory = async (req, res) => {
  try { const c = await InventoryCategory.create({ ...req.body, clinic: req.clinicId }); res.status(201).json(c); }
  catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateCategory = async (req, res) => {
  try {
    const c = await InventoryCategory.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'No encontrada' });
    Object.assign(c, req.body); await c.save(); res.json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.deleteCategory = async (req, res) => {
  const c = await InventoryCategory.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!c) return res.status(404).json({ message: 'No encontrada' });
  await c.deleteOne(); res.json({ message: 'Eliminada' });
};

// ----- Kardex -----
/**
 * Kardex de un producto: movimientos con saldo acumulado, filtrable por bodega/fecha/tipo.
 * query: { product (req), warehouse, type, startDate, endDate }
 */
exports.getKardex = async (req, res) => {
  try {
    const { product, warehouse, type, startDate, endDate } = req.query;
    if (!product) return res.status(400).json({ message: 'product requerido' });
    const filter = { clinic: req.clinicId, product };
    if (warehouse) filter.$or = [{ warehouse }, { toWarehouse: warehouse }];
    if (type) filter.type = type;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate + 'T23:59:59.999');
    }
    const movements = await InventoryMovement.find(filter)
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name')
      .sort({ createdAt: 1 });
    const prod = await Product.findOne({ _id: product, clinic: req.clinicId }).select('code name unit stock averageCost');
    // Saldo acumulado
    let balance = 0;
    const rows = movements.map((m) => {
      const sign = m.type === 'salida' ? -1 : (m.type === 'entrada' ? 1 : (m.type === 'ajuste' ? 1 : 0));
      // traslado no cambia stock total (sale de una bodega y entra a otra)
      const qty = m.quantity * sign;
      balance += qty;
      return {
        _id: m._id, date: m.createdAt, type: m.type,
        warehouse: m.warehouse, toWarehouse: m.toWarehouse,
        quantity: m.quantity, signedQuantity: qty,
        unitCost: m.unitCost, balance,
        reason: m.reason, reference: m.reference,
        sourceModel: m.sourceModel, createdBy: m.createdBy,
      };
    });
    res.json({ product: prod, movements: rows, currentBalance: prod?.stock ?? balance });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Traslado de stock entre bodegas. body: { product, fromWarehouse, toWarehouse, quantity, reason } */
exports.transferStock = async (req, res) => {
  try {
    const { product, fromWarehouse, toWarehouse, quantity, reason } = req.body;
    if (!product || !fromWarehouse || !toWarehouse || !quantity) return res.status(400).json({ message: 'product, fromWarehouse, toWarehouse y quantity requeridos' });
    if (fromWarehouse === toWarehouse) return res.status(400).json({ message: 'Las bodegas deben ser distintas' });
    const prod = await Product.findOne({ _id: product, clinic: req.clinicId });
    if (!prod) return res.status(404).json({ message: 'Producto no encontrado' });
    const mov = await InventoryMovement.create({
      clinic: req.clinicId, product, type: 'traslado',
      warehouse: fromWarehouse, toWarehouse, quantity: Number(quantity),
      reason: reason || 'Traslado entre bodegas', balanceAfter: prod.stock,
      createdBy: req.user._id,
    });
    res.status(201).json(mov);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ----- Toma física -----
exports.listCounts = async (req, res) => {
  const items = await PhysicalCount.find({ clinic: req.clinicId }).sort({ date: -1 });
  res.json(items);
};

exports.startCount = async (req, res) => {
  try {
    const { warehouse, description } = req.body;
    const count = await PhysicalCount.countDocuments({ clinic: req.clinicId });
    const code = `TF-${String(count + 1).padStart(5, '0')}`;
    const products = await Product.find({ clinic: req.clinicId, active: true, unlimited: { $ne: true }, category: { $ne: 'servicio' } });
    const items = products.map((p) => ({
      product: p._id, productCode: p.code, productName: p.name,
      systemQty: p.stock, countedQty: p.stock, difference: 0,
      unitCost: p.purchasePrice || 0,
    }));
    const pc = await PhysicalCount.create({
      clinic: req.clinicId, code, warehouse: warehouse || null, description, items, createdBy: req.user._id,
    });
    res.status(201).json(pc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateCount = async (req, res) => {
  const pc = await PhysicalCount.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!pc) return res.status(404).json({ message: 'No encontrada' });
  if (pc.status !== 'BORRADOR') return res.status(400).json({ message: 'No editable' });
  if (req.body.items) pc.items = req.body.items.map((it) => ({
    ...it,
    difference: (it.countedQty || 0) - (it.systemQty || 0),
    adjustmentValue: ((it.countedQty || 0) - (it.systemQty || 0)) * (it.unitCost || 0),
  }));
  if (req.body.description !== undefined) pc.description = req.body.description;
  await pc.save();
  res.json(pc);
};

exports.confirmCount = async (req, res) => {
  try {
    const pc = await PhysicalCount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!pc) return res.status(404).json({ message: 'No encontrada' });
    if (pc.status !== 'BORRADOR') return res.status(400).json({ message: 'No editable' });

    // Ajustar stock y crear movimientos
    let positive = 0, negative = 0;
    for (const it of pc.items) {
      const diff = (it.countedQty || 0) - (it.systemQty || 0);
      if (diff === 0) continue;
      await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $inc: { stock: diff } });
      await InventoryMovement.create({
        clinic: req.clinicId, product: it.product,
        type: diff > 0 ? 'entrada' : 'salida',
        quantity: Math.abs(diff), reason: 'Ajuste por toma física',
        reference: pc.code, createdBy: req.user._id,
      });
      const val = Math.abs(diff) * (it.unitCost || 0);
      if (diff > 0) positive += val; else negative += val;
    }

    // Asiento contable de ajuste
    if (positive > 0 || negative > 0) {
      const inv = await findAccount(req.clinicId, { code: '1.1.04.01' });
      const gasto = await findAccount(req.clinicId, { code: '6.1.99' });
      const lines = [];
      const net = positive - negative;
      if (net > 0) {
        lines.push({ account: inv._id, debit: net, credit: 0, description: 'Sobrante inventario' });
        lines.push({ account: gasto._id, debit: 0, credit: net, description: 'Ajuste sobrante' });
      } else if (net < 0) {
        lines.push({ account: gasto._id, debit: -net, credit: 0, description: 'Faltante inventario' });
        lines.push({ account: inv._id, debit: 0, credit: -net, description: 'Ajuste faltante' });
      }
      if (lines.length) {
        const entry = await createEntry({
          clinicId: req.clinicId, date: new Date(),
          description: `Ajuste toma física ${pc.code}`, source: 'AJUSTE',
          sourceRef: pc._id, sourceModel: 'PhysicalCount',
          lines, userId: req.user._id,
        });
        pc.adjustmentEntry = entry._id;
      }
    }
    pc.status = 'CONFIRMADO';
    pc.confirmedAt = new Date();
    pc.confirmedBy = req.user._id;
    await pc.save();
    res.json(pc);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

// ----- Activos fijos -----
exports.listAssets = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.locationClinic) filter.locationClinic = req.query.locationClinic;
  const items = await FixedAsset.find(filter)
    .populate('category assetType', 'code name')
    .populate('locationClinic', 'name nombreComercial')
    .sort({ code: 1 });
  res.json(items);
};

exports.getAsset = async (req, res) => {
  const a = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('category assetType', 'code name depreciationRate')
    .populate('locationClinic', 'name nombreComercial')
    .populate('assetAccount depreciationAccount accumDepreciationAccount', 'code name')
    .populate('responsible', 'name')
    .populate('purchaseInvoice', 'serie fechaEmision total');
  if (!a) return res.status(404).json({ message: 'No encontrado' });
  res.json(a);
};

exports.createAsset = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId, createdBy: req.user._id };
    if (data.acquisitionDate) data.acquisitionDate = new Date(data.acquisitionDate);
    if (data.startDate) data.startDate = new Date(data.startDate);
    else data.startDate = data.acquisitionDate;
    // Si llega residualPercent, calcular residualValue a partir del costo
    if (data.residualPercent && !data.residualValue) {
      data.residualValue = +(data.acquisitionCost * (data.residualPercent / 100)).toFixed(2);
    }
    const depreciableBase = data.acquisitionCost - (data.residualValue || 0);
    data.usefulLifeMonths = data.usefulLifeMonths || Math.round(12 / ((data.depreciationRate || 1) / 100));
    data.monthlyDepreciation = +(depreciableBase / data.usefulLifeMonths).toFixed(2);
    data.bookValue = data.acquisitionCost;
    const a = await FixedAsset.create(data);
    res.status(201).json(a);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateAsset = async (req, res) => {
  try {
    const a = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!a) return res.status(404).json({ message: 'No encontrado' });
    Object.assign(a, req.body);
    if (a.residualPercent && req.body.residualPercent !== undefined) {
      a.residualValue = +(a.acquisitionCost * (a.residualPercent / 100)).toFixed(2);
    }
    // Recalcular depreciación mensual si cambian parámetros base
    if (['acquisitionCost', 'residualValue', 'residualPercent', 'usefulLifeMonths', 'depreciationRate'].some((k) => req.body[k] !== undefined)) {
      a.usefulLifeMonths = a.usefulLifeMonths || Math.round(1200 / (a.depreciationRate || 10));
      const base = a.acquisitionCost - (a.residualValue || 0);
      a.monthlyDepreciation = +(base / a.usefulLifeMonths).toFixed(2);
    }
    await a.save();
    res.json(a);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.deleteAsset = async (req, res) => {
  const a = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!a) return res.status(404).json({ message: 'No encontrado' });
  if (a.accumulatedDepreciation > 0) return res.status(400).json({ message: 'Ya tiene depreciaciones, dé de baja' });
  await a.deleteOne();
  res.json({ message: 'Eliminado' });
};

/**
 * Corre depreciación mensual para todos los activos activos (idempotente por período).
 */
exports.runDepreciation = async (req, res) => {
  try {
    const { year, month } = req.body;
    const y = parseInt(year);
    const m = parseInt(month);
    if (!y || !m || m < 1 || m > 12) return res.status(400).json({ message: 'year y month inválidos' });
    const period = `${y}-${String(m).padStart(2, '0')}`;
    const endOfMonth = new Date(y, m, 0, 23, 59, 59);

    const assets = await FixedAsset.find({ clinic: req.clinicId, status: 'ACTIVO' }).populate('category');
    let totalDep = 0;
    const lines = [];
    for (const a of assets) {
      if (a.lastDepreciationPeriod >= period) continue;
      if (new Date(a.startDate) > endOfMonth) continue;
      const remainingBase = (a.acquisitionCost - (a.residualValue || 0)) - a.accumulatedDepreciation;
      if (remainingBase <= 0) continue;
      const dep = Math.min(a.monthlyDepreciation, remainingBase);
      a.accumulatedDepreciation = +(a.accumulatedDepreciation + dep).toFixed(2);
      a.bookValue = +(a.acquisitionCost - a.accumulatedDepreciation).toFixed(2);
      a.lastDepreciationPeriod = period;
      a.history.push({
        period, date: endOfMonth, amount: dep,
        accumulated: a.accumulatedDepreciation, bookValue: a.bookValue,
      });
      await a.save();
      totalDep += dep;
      const depAccount = a.depreciationAccount || a.category?.depreciationAccount;
      const accumAccount = a.accumDepreciationAccount || a.category?.accumDepreciationAccount;
      if (depAccount) {
        lines.push({ account: depAccount, debit: dep, credit: 0, description: `Depreciación ${a.code} ${period}` });
      }
      if (accumAccount) {
        lines.push({ account: accumAccount, debit: 0, credit: dep, description: `Depreciación acumulada ${a.code}` });
      }
    }
    let entry = null;
    if (lines.length) {
      // Consolidar por cuenta
      const map = new Map();
      for (const l of lines) {
        const key = `${l.account}-${l.debit > 0 ? 'D' : 'C'}`;
        const cur = map.get(key) || { account: l.account, debit: 0, credit: 0, description: 'Depreciación mensual' };
        cur.debit += l.debit; cur.credit += l.credit;
        map.set(key, cur);
      }
      entry = await createEntry({
        clinicId: req.clinicId, date: endOfMonth,
        description: `Depreciación ${period}`, source: 'DEPRECIACION',
        lines: Array.from(map.values()), userId: req.user._id,
      });
      await FixedAsset.updateMany(
        { clinic: req.clinicId, lastDepreciationPeriod: period, status: 'ACTIVO' },
        { $set: { 'history.$[h].journalEntry': entry._id } },
        { arrayFilters: [{ 'h.period': period }] }
      );
    }
    res.json({ period, processed: assets.length, totalDepreciation: totalDep, journalEntry: entry });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * Importación masiva de productos (CSV/JSON simple).
 * body: { rows: [{ code, name, category, salePrice, purchasePrice, stock, taxRate, unlimited }] }
 */
exports.importProducts = async (req, res) => {
  try {
    const rows = req.body?.rows || [];
    let created = 0, updated = 0;
    for (const r of rows) {
      if (!r.code || !r.name) continue;
      const exists = await Product.findOne({ clinic: req.clinicId, code: r.code });
      if (exists) {
        Object.assign(exists, r);
        await exists.save(); updated++;
      } else {
        await Product.create({ ...r, clinic: req.clinicId });
        created++;
      }
    }
    res.json({ created, updated });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.importAssets = async (req, res) => {
  try {
    const rows = req.body?.rows || [];
    let created = 0;
    for (const r of rows) {
      if (!r.code || !r.name || !r.acquisitionCost) continue;
      try {
        const data = { ...r, clinic: req.clinicId, createdBy: req.user._id };
        data.acquisitionDate = data.acquisitionDate ? new Date(data.acquisitionDate) : new Date();
        data.startDate = data.startDate ? new Date(data.startDate) : data.acquisitionDate;
        data.depreciationRate = data.depreciationRate || 10;
        data.usefulLifeMonths = data.usefulLifeMonths || Math.round(1200 / data.depreciationRate);
        const base = data.acquisitionCost - (data.residualValue || 0);
        data.monthlyDepreciation = +(base / data.usefulLifeMonths).toFixed(2);
        data.bookValue = data.acquisitionCost;
        await FixedAsset.create(data);
        created++;
      } catch (e) { /* skip */ }
    }
    res.json({ created });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
