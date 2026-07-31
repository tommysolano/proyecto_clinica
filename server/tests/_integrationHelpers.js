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

let tempMediaDir = null;

async function startDb() {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { dbName: 'test' });
  tempMediaDir = await useTempMediaDir();
}

async function stopDb() {
  await mongoose.disconnect();
  if (replset) await replset.stop();
  await cleanupTempMediaDir(tempMediaDir);
  tempMediaDir = null;
}

async function resetDb() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/**
 * Fecha de un comprobante en los tests.
 *
 * Los comprobantes ya NO admiten fechas anteriores a hoy (utils/fiscalDocumentDate: la fecha
 * de emisión es automática y el sistema rechaza registrar atrasado), así que un
 * `new Date('2026-06-05')` incrustado en un test deja de funcionar en cuanto pasa esa fecha.
 * Se usa esta fábrica: `docDate()` = hoy y `docDate(n)` = hoy + n días, que sirve para dar
 * ORDEN a varios documentos (p. ej. capas FIFO) sin depender del calendario.
 */
function docDate(offsetDays = 0) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d;
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
 * Categoría de inventario por defecto (find-or-create) COMPLETA: cuenta de activo
 * (1.1.04.01), de costo (5.1.01) y de ingreso (4.1.02). Refleja la regla nueva: al
 * contabilizar una compra de inventario, la categoría contable del producto debe tener
 * las tres cuentas configuradas (sin fallback).
 */
async function defaultInventoryCategory(clinicId) {
  const existing = await InventoryCategory.findOne({ clinic: clinicId, code: 'INV-DEF' });
  if (existing) return existing;
  const [invAcc, costAcc, incAcc] = await Promise.all([
    ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' }),
    ChartOfAccount.findOne({ clinic: clinicId, code: '5.1.01' }),
    ChartOfAccount.findOne({ clinic: clinicId, code: '4.1.02' }),
  ]);
  return InventoryCategory.create({
    clinic: clinicId, code: 'INV-DEF', name: 'Inventario (test)', kind: 'INVENTARIO',
    assetAccount: invAcc?._id || null, expenseAccount: costAcc?._id || null, incomeAccount: incAcc?._id || null,
  });
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
  const headers = extra.headers || {};
  return {
    clinicId,
    user: { _id: userId },
    role: extra.role || 'admin',
    body,
    params: extra.params || {},
    query: extra.query || {},
    // Superficie mínima de Express usada por algunos controladores (p.ej. armar
    // URLs absolutas con el host de la petición en bookingConfig.uploadImage).
    protocol: 'http',
    headers,
    get(name) {
      const key = String(name).toLowerCase();
      return headers[key] ?? (key === 'host' ? 'localhost:5000' : undefined);
    },
  };
}

/** Simula res capturando status + payload. Devuelve { res, result(). } */
function mockRes() {
  const state = { statusCode: 200, payload: undefined, done: false, headers: {} };
  const res = {
    status(code) { state.statusCode = code; return res; },
    json(payload) { state.payload = payload; state.done = true; return res; },
    send(payload) { state.payload = payload; state.done = true; return res; },
    // Endpoints que devuelven archivos (XML/TXT/Excel) fijan headers; no-op que registra.
    setHeader(name, value) { state.headers[name] = value; return res; },
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

/**
 * Almacén de media AISLADO para los tests. Sin esto, cualquier test que suba un
 * adjunto escribiría archivos de verdad en `server/storage/media` del repo y los
 * iría acumulando ahí para siempre. Se activa en `startDb` y se borra en `stopDb`.
 */
async function useTempMediaDir() {
  const fsp = require('fs/promises');
  const os = require('os');
  const path = require('path');
  if (process.env.MEDIA_DIR) return null; // el test ya eligió el suyo
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiluv-media-test-'));
  process.env.MEDIA_DIR = dir;
  return dir;
}

async function cleanupTempMediaDir(dir) {
  if (!dir) return;
  const fsp = require('fs/promises');
  delete process.env.MEDIA_DIR;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Espera a que un mensaje llegue al estado de entrega esperado.
 *
 * Los envíos del chat se entregan EN SEGUNDO PLANO (ver `messaging.send` con
 * `background`): la petición HTTP contesta en cuanto el mensaje está guardado
 * como 'queued', y el resultado real ('sent' o 'failed') lo escribe la entrega
 * poco después. Sin esta espera, un test leería el estado intermedio.
 */
async function waitForStatus(messageId, expected, timeoutMs = 3000) {
  const Message = require('../models/Message');
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    last = await Message.findById(messageId).lean();
    if (last && last.deliveryStatus === expected) return last;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `El mensaje ${messageId} no llegó a '${expected}' en ${timeoutMs}ms (quedó en '${last?.deliveryStatus}')`
  );
}

module.exports = {
  startDb, stopDb, resetDb, seedClinic, makeProduct, makeSupplier, docDate,
  accountBalanceByCode, assertLedgerBalanced, mockReq, mockRes, runController,
  waitForStatus, mongoose,
};
