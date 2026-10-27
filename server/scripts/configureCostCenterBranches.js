#!/usr/bin/env node
'use strict';

// Asigna centros y bodegas inequívocos a su sucursal. No cambia documentos
// ni asientos de Contífico; conserva incluso sus centros nulos.
// Uso: node scripts/configureCostCenterBranches.js [--commit]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;
const Clinic = require('../models/Clinic');
const Company = require('../models/Company');
const CostCenter = require('../models/CostCenter');
const Warehouse = require('../models/Warehouse');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');

async function backupAffectedRows() {
  const company = await Company.findOne({ isDefault: true }).select('_id').lean();
  if (!company) throw new Error('No se encontró la empresa principal');
  const clinics = await Clinic.find({ company: company._id }).lean();
  const ids = clinics.map((clinic) => clinic._id);
  const [centers, warehouses] = await Promise.all([
    CostCenter.find({ clinic: { $in: ids } }).lean(),
    Warehouse.find({ clinic: { $in: ids } }).lean(),
  ]);
  const movedWarehouses = warehouses.filter((warehouse) => ['BOD004', 'BOD005'].includes(warehouse.code));
  const layers = await InventoryLayer.find({ warehouse: { $in: movedWarehouses.map((warehouse) => warehouse._id) } }).lean();
  const products = await Product.find({ _id: { $in: [...new Set(layers.map((layer) => String(layer.product)))] } }).lean();
  const folder = path.resolve(__dirname, '..', 'storage', 'branch-centers');
  fs.mkdirSync(folder, { recursive: true });
  const filename = path.join(folder, `before-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
  fs.writeFileSync(filename, zlib.gzipSync(Buffer.from(EJSON.stringify({
    capturedAt: new Date(), company: company._id, clinics, centers, warehouses, layers, products,
  }, { relaxed: false }))), { flag: 'wx' });
  return filename;
}

const OWNERS = [
  { center: '1', warehouse: 'BOD001', clinic: 'Central' },
  { center: '2', warehouse: 'BOD004', clinic: 'Extensión' },
  { center: '5', warehouse: 'BOD005', clinic: 'Laboratorio' },
];

async function configure({ commit = false } = {}) {
  const company = await Company.findOne({ isDefault: true }).select('_id').lean();
  if (!company) throw new Error('No se encontró la empresa principal');
  const clinics = await Clinic.find({ company: company._id, active: true,
    name: { $in: ['Central', 'Extensión', 'Laboratorio', 'Odontología', 'Dermazen'] } }).lean();
  const byName = new Map(clinics.map((clinic) => [clinic.name, clinic]));
  if (byName.size !== 5) throw new Error('Falta alguna sucursal de la empresa principal');
  const central = byName.get('Central');
  const desired = OWNERS.map((item) => ({ ...item, owner: byName.get(item.clinic) }));
  const ownerIds = desired.map((item) => item.owner._id);
  const centers = await CostCenter.find({ code: { $in: ['1', '2', '3', '4', '5', '6'] },
    clinic: { $in: ownerIds } }).lean();
  const warehouses = await Warehouse.find({ code: { $in: OWNERS.map((item) => item.warehouse) },
    clinic: { $in: ownerIds } }).lean();
  const resolve = (rows, code, owner, kind) => {
    const found = rows.filter((row) => row.code === code);
    if (found.length !== 1 || ![String(central._id), String(owner._id)].includes(String(found[0].clinic))) {
      throw new Error(`${kind} ${code}: falta el registro único o tiene otro propietario`);
    }
    return found[0];
  };
  for (const item of desired) {
    item.centerRow = resolve(centers, item.center, item.owner, 'Centro');
    item.warehouseRow = resolve(warehouses, item.warehouse, item.owner, 'Bodega');
    if (String(item.warehouseRow.costCenter) !== String(item.centerRow._id)) {
      throw new Error(`La bodega ${item.warehouse} no apunta al centro ${item.center}`);
    }
  }
  const cc3 = resolve(centers, '3', byName.get('Extensión'), 'Centro');
  const cc4 = resolve(centers, '4', central, 'Centro');
  const cc6 = resolve(centers, '6', central, 'Centro');
  const dermazen = byName.get('Dermazen');
  const existingDermazen = await CostCenter.findOne({ clinic: dermazen._id,
    code: { $in: ['7', 'DERMAZEN'] } }).lean();
  if (existingDermazen && existingDermazen.name !== 'CC DERMAZEN') throw new Error('El centro de Dermazen está ocupado');
  const summary = { mode: commit ? 'commit' : 'dry-run', centers: desired.map((item) => ({
    code: item.center, owner: item.clinic, move: String(item.centerRow.clinic) !== String(item.owner._id),
    warehouse: item.warehouse, moveWarehouse: String(item.warehouseRow.clinic) !== String(item.owner._id),
  })), odontologia: 'CC EXTENSIÓN (2) con histórico CC ODONTOLOGÍA (3)',
    dermazen: 'CC DERMAZEN (DERMAZEN)',
    sourceDocumentsUnchanged: true,
    stockLayers: await Promise.all(desired.filter((item) => item.center !== '1').map(async (item) => ({
      warehouse: item.warehouse, count: await InventoryLayer.countDocuments({ clinic: central._id,
        warehouse: item.warehouseRow._id }),
    }))) };
  if (!commit) return summary;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of desired) {
        await CostCenter.updateOne({ _id: item.centerRow._id }, { $set: { clinic: item.owner._id } }, { session });
        await Warehouse.updateOne({ _id: item.warehouseRow._id }, { $set: { clinic: item.owner._id } }, { session });
        await Clinic.updateOne({ _id: item.owner._id }, { $set: {
          accountingCostCenter: item.centerRow._id, accountingDataClinic: central._id,
          accountingImportCostCenters: item.center === '1' ? [item.centerRow._id, cc4._id, cc6._id]
            : item.center === '2' ? [item.centerRow._id, cc3._id] : [item.centerRow._id],
        } }, { session });
      }
      await CostCenter.updateOne({ _id: cc3._id }, { $set: { clinic: byName.get('Extensión')._id } }, { session });
      const stockOwners = desired.filter((item) => item.center !== '1');
      const clinicIds = desired.map((item) => item.owner._id);
      const warehouseOwner = new Map(desired.map((item) => [String(item.warehouseRow._id), item.owner._id]));
      const stockRows = await InventoryLayer.aggregate([
        { $match: { warehouse: { $in: desired.map((item) => item.warehouseRow._id) } } },
        { $group: { _id: { product: '$product', warehouse: '$warehouse' }, qty: { $sum: '$qtyRemaining' } } },
      ]).session(session);
      const quantities = new Map();
      for (const row of stockRows) {
        const productId = String(row._id.product);
        const owner = warehouseOwner.get(String(row._id.warehouse));
        if (!owner) continue;
        if (!quantities.has(productId)) quantities.set(productId, new Map());
        const byClinic = quantities.get(productId);
        byClinic.set(String(owner), (byClinic.get(String(owner)) || 0) + row.qty);
      }
      const products = await Product.find({ _id: { $in: [...quantities.keys()] } })
        .select('stock stockByClinic').lean().session(session);
      for (const item of stockOwners) {
        await InventoryLayer.updateMany({ clinic: central._id, warehouse: item.warehouseRow._id },
          { $set: { clinic: item.owner._id } }, { session });
      }
      // El stock disponible por sucursal debe corresponder a las capas FIFO que
      // ahora posee. El stock global del producto no se modifica.
      const stockOps = products.map((product) => {
        const byClinic = quantities.get(String(product._id));
        const others = (product.stockByClinic || []).filter((row) =>
          !clinicIds.some((id) => String(id) === String(row.clinic)));
        const branchStock = stockOwners.reduce((sum, item) => sum + (byClinic.get(String(item.owner._id)) || 0), 0);
        const otherStock = others.reduce((sum, row) => sum + Number(row.stock || 0), 0);
        const centralStock = Number(product.stock || 0) - branchStock - otherStock;
        return { updateOne: { filter: { _id: product._id }, update: { $set: {
          stockByClinic: [...others, ...clinicIds.map((id) => ({
            clinic: id, stock: String(id) === String(central._id) ? centralStock : (byClinic.get(String(id)) || 0),
          }))],
        } } } };
      });
      if (stockOps.length) await Product.bulkWrite(stockOps, { session, ordered: false });
      const dermazenCenter = existingDermazen
        ? await CostCenter.findByIdAndUpdate(existingDermazen._id, { $set: { code: 'DERMAZEN' } },
          { new: true, session })
        : await CostCenter.findOneAndUpdate({ clinic: dermazen._id, code: 'DERMAZEN' },
          { $setOnInsert: { clinic: dermazen._id, code: 'DERMAZEN', name: 'CC DERMAZEN', active: true,
            description: 'Centro local de Dermazen; no existe en Contífico' } },
          { upsert: true, new: true, session });
      await Clinic.updateOne({ _id: dermazen._id }, { $set: {
        accountingCostCenter: dermazenCenter._id, accountingDataClinic: null,
        accountingImportCostCenters: [dermazenCenter._id],
      } }, { session });
      await Clinic.updateOne({ _id: byName.get('Odontología')._id }, { $set: {
        accountingCostCenter: desired.find((item) => item.center === '2').centerRow._id,
        accountingDataClinic: central._id,
        accountingImportCostCenters: [desired.find((item) => item.center === '2').centerRow._id, cc3._id],
      } }, { session });
    });
  } finally { await session.endSession(); }
  return summary;
}

if (require.main === module) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
      const commit = process.argv.includes('--commit');
      const backup = commit ? await backupAffectedRows() : null;
      return { backup, result: await configure({ commit }) };
    })
    .then(({ backup, result }) => console.log(JSON.stringify({ ...result, backup })))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect().catch(() => {}));
}

module.exports = { configure };
