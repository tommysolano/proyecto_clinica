const Warehouse = require('../models/Warehouse');
const InventoryCategory = require('../models/InventoryCategory');
const PhysicalCount = require('../models/PhysicalCount');
const FixedAsset = require('../models/FixedAsset');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const { createEntry, findAccount } = require('../utils/accounting');

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
  const items = await FixedAsset.find(filter).populate('category', 'code name').sort({ code: 1 });
  res.json(items);
};

exports.createAsset = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId, createdBy: req.user._id };
    if (data.acquisitionDate) data.acquisitionDate = new Date(data.acquisitionDate);
    if (data.startDate) data.startDate = new Date(data.startDate);
    else data.startDate = data.acquisitionDate;
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
      if (a.category?.depreciationAccount) {
        lines.push({ account: a.category.depreciationAccount, debit: dep, credit: 0, description: `Depreciación ${a.code} ${period}` });
      }
      if (a.category?.accumDepreciationAccount) {
        lines.push({ account: a.category.accumDepreciationAccount, debit: 0, credit: dep, description: `Depreciación acumulada ${a.code}` });
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
