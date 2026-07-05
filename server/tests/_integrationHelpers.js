/**
 * Harness de integración: arranca un MongoDB en memoria con replica set (las
 * transacciones de los flujos contables lo exigen), conecta mongoose y ofrece
 * helpers para sembrar datos y simular req/res sobre los controllers reales.
 *
 * No es un *.test.js: lo cargan los archivos de flujos.
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { seedChartOfAccounts, getOrCreatePeriod } = require('../utils/accounting');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');

let replset = null;

async function startDb() {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { dbName: 'test' });
}

async function stopDb() {
  await mongoose.disconnect();
  if (replset) await replset.stop();
}

async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/** Crea clínica + usuario (solo ids), plan de cuentas y período abierto. */
async function seedClinic({ date = new Date() } = {}) {
  const clinicId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  await seedChartOfAccounts(clinicId);
  await getOrCreatePeriod(clinicId, date);
  return { clinicId, userId };
}

/**
 * Categoría de inventario por defecto (find-or-create) con cuenta de activo = 1.1.04.01.
 * Refleja la regla nueva: un producto físico de inventario debe tener categoría contable
 * con `assetAccount` (las compras nuevas resuelven la cuenta desde ahí, sin fallback).
 */
async function defaultInventoryCategory(clinicId) {
  const existing = await InventoryCategory.findOne({ clinic: clinicId, code: 'INV-DEF' });
  if (existing) return existing;
  const invAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  return InventoryCategory.create({ clinic: clinicId, code: 'INV-DEF', name: 'Inventario (test)', kind: 'INVENTARIO', assetAccount: invAcc?._id || null });
}

async function makeProduct(clinicId, overrides = {}) {
  const code = overrides.code || `P${Math.random().toString(36).slice(2, 8)}`;
  const category = overrides.category || 'insumo';
  const unlimited = overrides.unlimited ?? false;
  // Productos físicos de inventario reciben una categoría contable por defecto si el
  // test no especificó una (para que las compras nuevas puedan resolver la cuenta).
  let inventoryCategory = overrides.inventoryCategory;
  if (inventoryCategory === undefined && category === 'insumo' && !unlimited) {
    inventoryCategory = (await defaultInventoryCategory(clinicId))._id;
  }
  return Product.create({
    clinic: clinicId,
    code,
    name: overrides.name || 'Producto',
    category,
    salePrice: overrides.salePrice ?? 100,
    purchasePrice: overrides.purchasePrice ?? 0,
    stock: overrides.stock ?? 0,
    averageCost: overrides.averageCost ?? 0,
    taxCategory: overrides.taxCategory || 'IVA_15',
    taxRate: overrides.taxRate ?? 15,
    priceIncludesVat: overrides.priceIncludesVat ?? true,
    unlimited,
    ...overrides,
    inventoryCategory: inventoryCategory ?? null,
  });
}

async function makeSupplier(clinicId, overrides = {}) {
  return Supplier.create({
    clinic: clinicId,
    ruc: overrides.ruc || `0999${Math.floor(Math.random() * 1e9)}`,
    razonSocial: overrides.razonSocial || 'Proveedor SA',
    ...overrides,
  });
}

/** Saldo (debe-haber) de una cuenta por su código, leído desde JournalEntry. */
async function accountBalanceByCode(clinicId, code) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code });
  if (!acc) return 0;
  const JournalEntry = require('../models/JournalEntry');
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: new mongoose.Types.ObjectId(String(clinicId)), status: 'CONTABILIZADO' } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': acc._id } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return +(((agg[0]?.debit || 0) - (agg[0]?.credit || 0)).toFixed(2));
}

/** Verifica que TODOS los asientos contabilizados de la clínica cuadren. */
async function assertLedgerBalanced(clinicId) {
  const JournalEntry = require('../models/JournalEntry');
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: new mongoose.Types.ObjectId(String(clinicId)), status: 'CONTABILIZADO' } },
    { $group: { _id: null, d: { $sum: '$totalDebit' }, c: { $sum: '$totalCredit' } } },
  ]);
  const d = +(agg[0]?.d || 0).toFixed(2);
  const c = +(agg[0]?.c || 0).toFixed(2);
  return { debit: d, credit: c, balanced: Math.abs(d - c) <= 0.01 };
}

/** Simula req con clínica/usuario y body. */
function mockReq(clinicId, userId, body = {}, extra = {}) {
  return {
    clinicId,
    user: { _id: userId },
    role: extra.role || 'admin',
    body,
    params: extra.params || {},
    query: extra.query || {},
  };
}

/** Simula res capturando status + payload. Devuelve { res, result(). } */
function mockRes() {
  const state = { statusCode: 200, payload: undefined, done: false };
  const res = {
    status(code) { state.statusCode = code; return res; },
    json(payload) { state.payload = payload; state.done = true; return res; },
    send(payload) { state.payload = payload; state.done = true; return res; },
  };
  return { res, state };
}

/** Ejecuta un controller (req,res) y devuelve { statusCode, payload }. */
async function runController(handler, req) {
  const { res, state } = mockRes();
  await handler(req, res);
  if (!state.done) throw new Error('El controller no respondió (no llamó a res.json/send)');
  return state;
}

module.exports = {
  startDb, stopDb, resetDb, seedClinic, makeProduct, makeSupplier,
  accountBalanceByCode, assertLedgerBalanced, mockReq, mockRes, runController,
  mongoose,
};
