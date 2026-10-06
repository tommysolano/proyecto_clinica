'use strict';

// Sincroniza el inventario con Contífico, igual que ventas y compras:
//   - Movimientos (kardex): los del mes actual y el anterior en cada ciclo; todo
//     el año en el ciclo largo. Mismas claves que la importación inicial, así
//     que un movimiento ya importado se actualiza, no se duplica.
//   - Productos nuevos: lo creado en Contífico entra aquí (servicios incluidos).
//   - Stock: el de Contífico (`cantidad_stock`). La clínica decidió que el stock
//     sea el de Contífico aunque enfermería descuente ampollas aquí (06-10-2026).
//
// Lo que aquí está marcado como servicio o programa (o ilimitado) NO se toca,
// aunque en Contífico sea un producto: esa clasificación es de la clínica.
const os = require('os');
const { randomUUID } = require('crypto');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const InventoryMovement = require('../models/InventoryMovement');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const mongoose = require('mongoose');
const ServerLease = require('../models/ServerLease');
const Notification = require('../models/Notification');
const SyncState = require('../models/ContificoSyncState');
const { ContificoApi } = require('./contificoApi');
const { Extractor, checksum, fmt, parseDate } = require('../scripts/migrateContifico');
const { monthRange, ecToday } = require('./contificoFinancialSync');
const { tax } = require('../scripts/migrateContificoProject');
const { decodeCompressedJson } = require('../utils/compressedJson');

let running = false;
const LEASE_NAME = 'contifico-inventory-sync';
const STATE_ID = 'inventory-Central';
const LEASE_MS = 10 * 60 * 1000;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const r2 = (value) => +Number(value || 0).toFixed(2);
const linkOf = (record, model) => (record?.projection?.links || []).find((link) => link.model === model && link.ref)?.ref || null;

async function recordSyncState(patch) {
  try {
    await SyncState.updateOne({ _id: STATE_ID }, { $set: patch }, { upsert: true });
  } catch (error) {
    console.error('[contifico-inventory-sync] No pudo guardar estado:', error.message);
  }
}

async function fetchAll(api, path, params) {
  const rows = new Map();
  const stats = {};
  for await (const page of api.pages(path, params, 100, stats)) {
    for (const row of page.rows) rows.set(String(row.id), row);
  }
  if (!stats.complete || stats.expected !== rows.size) {
    throw new Error(`${path} incompleto: ${rows.size}/${stats.expected}`);
  }
  return [...rows.values()];
}

/** Bodegas y productos de Contífico → _id local (por código de bodega y por enlace del producto). */
async function referenceMaps(clinicId) {
  const [warehouseRecords, warehouses, productRecords] = await Promise.all([
    Record.find({ clinic: clinicId, entity: 'warehouse' }).select('externalId payloadCompressed').lean(),
    Warehouse.find({ clinic: clinicId }).select('code').lean(),
    Record.find({ clinic: clinicId, entity: 'product' }).select('externalId projection.links').lean(),
  ]);
  const warehouseByCode = new Map(warehouses.map((warehouse) => [String(warehouse.code), warehouse._id]));
  return {
    warehouses: new Map(warehouseRecords.map((record) => {
      const payload = decodeCompressedJson(record.payloadCompressed);
      return [record.externalId, warehouseByCode.get(String(payload.codigo || `CTF-${record.externalId}`)) || null];
    })),
    products: new Map(productRecords.map((record) => [record.externalId, linkOf(record, 'Product')])),
  };
}

/** Filas de kardex de un movimiento de Contífico (un traslado son dos: salida y entrada). */
function movementRows(clinicId, record, row, maps) {
  const date = parseDate(row.fecha);
  const warehouse = maps.warehouses.get(String(row.bodega_id || '')) || null;
  const toWarehouse = maps.warehouses.get(String(row.bodega_destino_id || '')) || null;
  const kind = String(row.tipo || '').toUpperCase();
  const out = [], missing = [];
  for (const [index, detail] of (row.detalles || []).entries()) {
    const product = maps.products.get(String(detail.producto_id || '')) || null;
    const quantity = Math.abs(num(detail.cantidad));
    if (!product || quantity <= 0) { missing.push(String(detail.producto_id || '')); continue; }
    const unitCost = Math.max(0, num(detail.costo_promedio || detail.precio));
    const base = { clinic: clinicId, product, movementDate: date, dateSource: 'MOVIMIENTO', costCenter: null,
      quantity, unitCost, totalCost: r2(quantity * unitCost), balanceAfter: 0, reason: String(row.descripcion || ''),
      sourceModel: 'ContificoRecord', sourceRef: record._id };
    if (kind === 'TRA') {
      out.push({ ...base, type: 'salida', warehouse, toWarehouse, transferGroup: record._id, reference: `${row.codigo}:${index}:OUT` });
      out.push({ ...base, type: 'entrada', warehouse: toWarehouse, toWarehouse: warehouse, transferGroup: record._id, reference: `${row.codigo}:${index}:IN` });
    } else {
      out.push({ ...base, type: kind === 'ING' ? 'entrada' : (kind === 'EGR' ? 'salida' : 'ajuste'), warehouse, reference: `${row.codigo}:${index}` });
    }
  }
  return { rows: out, missing };
}

async function syncMovementMonth({ clinic, api, year, month, commit = true, assertLease = () => {} }) {
  const { from, through } = monthRange(year, month);
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const rows = await fetchAll(api, '/api/v2/movimiento-inventario/', { fecha_inicial: fmt(from), fecha_final: fmt(through) });
  const archived = await Record.find({ clinic: clinic._id, entity: 'inventory_movement', externalId: { $in: rows.map((row) => String(row.id)) } })
    .select('externalId checksum projection.links').lean();
  const archivedById = new Map(archived.map((record) => [record.externalId, record]));
  const changed = rows.filter((row) => {
    const record = archivedById.get(String(row.id));
    return !record || record.checksum !== checksum(row) || !linkOf(record, 'InventoryMovement');
  });
  // El listado de Contífico a veces omite filas vivas: lo ausente se informa, no se borra.
  const start = new Date(Date.UTC(year, month - 1, 1)), end = new Date(Date.UTC(year, month, 1));
  const liveIds = new Set(rows.map((row) => String(row.id)));
  const absent = (await Record.find({ clinic: clinic._id, entity: 'inventory_movement', 'search.date': { $gte: start, $lt: end } })
    .select('externalId').lean()).filter((record) => !liveIds.has(record.externalId)).length;
  if (!commit || !changed.length) return { month: key, state: changed.length ? 'DIFFERENT' : 'CURRENT', source: rows.length, changed: changed.length, absent };

  assertLease();
  const extractor = new Extractor({ api, clinic, commit: true, from, through, cutoff: through });
  await extractor.begin();
  const stage = extractor.stage('inventory_movements_window');
  stage.expected = rows.length;
  await extractor.archive('inventory_movement', changed, stage);
  await extractor.saveStage(stage);
  extractor.run.status = 'COMPLETED'; extractor.run.completedAt = new Date();
  await extractor.run.save();

  const records = await Record.find({ clinic: clinic._id, entity: 'inventory_movement', externalId: { $in: changed.map((row) => String(row.id)) } })
    .select('_id externalId').lean();
  const recordById = new Map(records.map((record) => [record.externalId, record]));
  const maps = await referenceMaps(clinic._id);
  const ops = [], projected = [];
  const missingProducts = new Set();
  for (const row of changed) {
    const record = recordById.get(String(row.id));
    const { rows: lines, missing } = movementRows(clinic._id, record, row, maps);
    missing.forEach((id) => missingProducts.add(id));
    projected.push({ record, references: lines.map((line) => line.reference), missing });
    for (const fields of lines) ops.push({ updateOne: {
      filter: { clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id, reference: fields.reference },
      update: { $set: fields }, upsert: true } });
  }
  assertLease();
  for (let offset = 0; offset < ops.length; offset += 500) await InventoryMovement.bulkWrite(ops.slice(offset, offset + 500), { ordered: false });
  const targets = await InventoryMovement.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: records.map((record) => record._id) } }).select('_id sourceRef').lean();
  const targetsByRecord = new Map();
  for (const target of targets) {
    const id = String(target.sourceRef);
    if (!targetsByRecord.has(id)) targetsByRecord.set(id, []);
    targetsByRecord.get(id).push(target._id);
  }
  await Record.bulkWrite(projected.map(({ record, missing }) => {
    const refs = targetsByRecord.get(String(record._id)) || [];
    return { updateOne: { filter: { _id: record._id }, update: { $set: { projection: {
      status: refs.length ? 'PROJECTED' : 'REVIEW',
      links: refs.map((ref) => ({ model: 'InventoryMovement', ref, action: 'LINK' })),
      warnings: missing.length ? [`Producto sin ficha local: ${[...new Set(missing)].join(', ')}`] : [],
      projectedAt: new Date() } } } } };
  }), { ordered: false });
  return { month: key, state: 'SYNCED', source: rows.length, updated: changed.length, lines: ops.length,
    absent, productsWithoutCard: missingProducts.size, snapshot: String(extractor.run._id) };
}

/** externalId de Contífico → _id local, para cuentas (por código) y categorías (CTF-<id>). */
async function catalogMaps(clinicId) {
  const [accountRecords, accounts, categoryRecords, categories, unitRecords] = await Promise.all([
    Record.find({ clinic: clinicId, entity: 'chart_account' }).select('externalId payloadCompressed').lean(),
    ChartOfAccount.find({ clinic: clinicId }).select('code').lean(),
    Record.find({ clinic: clinicId, entity: 'category' }).select('externalId payloadCompressed').lean(),
    InventoryCategory.find({ clinic: clinicId, code: /^CTF-/ }).select('code').lean(),
    Record.find({ clinic: clinicId, entity: 'unit' }).select('externalId payloadCompressed').lean(),
  ]);
  const accountByCode = new Map(accounts.map((row) => [String(row.code), row._id]));
  const categoryByCode = new Map(categories.map((row) => [String(row.code), row._id]));
  const payload = (record) => decodeCompressedJson(record.payloadCompressed);
  return {
    accounts: new Map(accountRecords.map((record) => [record.externalId, accountByCode.get(String(payload(record).codigo)) || null])),
    categories: new Map(categoryRecords.map((record) => [record.externalId, {
      _id: categoryByCode.get(`CTF-${record.externalId}`) || null, payload: payload(record) }])),
    units: new Map(unitRecords.map((record) => [record.externalId, String(payload(record).nombre || '')])),
  };
}

/**
 * PRODUCTOS NUEVOS DE CONTÍFICO (oct-2026). Antes solo entraba un producto nuevo
 * cuando aparecía en una venta o compra: un servicio recién creado allá (p. ej. la
 * colposcopia) no se podía agendar aquí. Ahora, en cada ciclo, lo que existe en
 * Contífico y aquí no, se crea con los mismos campos que la importación inicial.
 *
 * Lo que YA existe aquí no se toca nunca (el usuario reclasifica productos y eso es
 * suyo): si hay un producto con el mismo código en el catálogo de la empresa, solo se
 * enlaza para que la sincronización lo reconozca.
 */
async function importNewProducts({ clinic, api, rows, maps, commit = true }) {
  const nuevos = rows.filter((row) => !maps.products.get(String(row.id)) && String(row.codigo || '').trim());
  if (!nuevos.length) return { created: 0, linked: 0, names: [] };
  const { sisterClinicsSync, ensureCompanyCache } = require('../utils/companies');
  await ensureCompanyCache();
  const empresa = sisterClinicsSync(clinic._id, { includeInactive: true });
  const existentes = new Map((await Product.find({ clinic: { $in: empresa.length ? empresa : [clinic._id] },
    code: { $in: nuevos.map((row) => String(row.codigo).trim()) } }).select('code').lean())
    .map((product) => [String(product.code), product._id]));
  const catalog = await catalogMaps(clinic._id);

  const docs = [], links = new Map();
  for (const row of nuevos) {
    const code = String(row.codigo).trim();
    if (existentes.has(code)) { links.set(String(row.id), existentes.get(code)); continue; }
    const physical = String(row.tipo).toUpperCase() === 'PRO';
    const category = catalog.categories.get(String(row.categoria_id || '')) || {};
    const stock = physical ? num(row.cantidad_stock) : 0;
    const salePrice = Math.max(0, num(row.pvp1));
    const _id = new mongoose.Types.ObjectId();
    links.set(String(row.id), _id);
    docs.push({
      _id, clinic: clinic._id, code, barcode: String(row.codigo_barra || row.codigo_auxiliar || ''),
      name: String(row.nombre || code), description: String(row.descripcion || ''),
      category: physical ? 'insumo' : 'servicio', categoria: String(category.payload?.nombre || ''),
      isComposite: String(row.tipo_producto).toUpperCase() === 'COP',
      stock, stockByClinic: physical ? [{ clinic: clinic._id, stock }] : [], availableInClinics: [],
      purchasePrice: Math.max(0, num(row.costo_maximo)), averageCost: Math.max(0, num(row.costo_maximo)),
      salePrice, salePrices: [{ name: 'General', price: salePrice, active: true }], minStock: Math.max(0, num(row.minimo)),
      inventoryAccount: catalog.accounts.get(String(category.payload?.cuenta_inventario_id || category.payload?.cuenta_inventario || '')) || null,
      expenseAccount: catalog.accounts.get(String(row.cuenta_costo_id || category.payload?.cuenta_compra_id || category.payload?.cuenta_compra || '')) || null,
      incomeAccount: catalog.accounts.get(String(row.cuenta_venta_id || category.payload?.cuenta_venta_id || category.payload?.cuenta_venta || '')) || null,
      inventoryCategory: category._id || null, unlimited: !physical,
      unit: catalog.units.get(String(row.unidad || '')) || String(row.unidad?.nombre || 'Unidad'),
      ...tax(row.porcentaje_iva), active: String(row.estado || 'A') === 'A',
    });
  }
  if (commit) {
    // Archivados como el resto del catálogo, para que la sincronización los reconozca.
    const extractor = new Extractor({ api, clinic, commit: true, from: new Date(), through: new Date(), cutoff: new Date() });
    await extractor.begin();
    const stage = extractor.stage('products_new');
    await extractor.archive('product', nuevos, stage);
    await extractor.saveStage(stage);
    extractor.run.status = 'COMPLETED'; extractor.run.completedAt = new Date();
    await extractor.run.save();
    if (docs.length) await Product.insertMany(docs, { ordered: false });
    await Record.bulkWrite(nuevos.map((row) => ({ updateOne: {
      filter: { clinic: clinic._id, entity: 'product', externalId: String(row.id) },
      update: { $set: { projection: { status: existentes.has(String(row.codigo).trim()) ? 'LINKED_EXISTING' : 'PROJECTED',
        links: [{ model: 'Product', ref: links.get(String(row.id)), action: existentes.has(String(row.codigo).trim()) ? 'LINK' : 'CREATE' }],
        warnings: [], projectedAt: new Date() } } } } })), { ordered: false });
    for (const [id, ref] of links) maps.products.set(id, ref);
    // Un servicio nuevo se ofrece al agendar en cuanto existe (utils/serviciosInventario).
    if (docs.some((doc) => doc.category === 'servicio')) {
      const { sincronizarServiciosInventario } = require('../utils/serviciosInventario');
      await sincronizarServiciosInventario({ force: true });
    }
  }
  return { created: docs.length, linked: nuevos.length - docs.length, names: docs.map((doc) => doc.name) };
}

/**
 * Stock de cada producto físico = el de Contífico. Servicios, programas e ilimitados no
 * se tocan. Antes, los productos nuevos de Contífico se crean aquí (importNewProducts).
 */
async function syncStock({ clinic, api, commit = true }) {
  const rows = await fetchAll(api, '/api/v2/producto/', {});
  const maps = await referenceMaps(clinic._id);
  const nuevos = await importNewProducts({ clinic, api, rows, maps, commit });
  const ids = rows.map((row) => maps.products.get(String(row.id))).filter(Boolean);
  const products = new Map((await Product.find({ _id: { $in: ids } }).select('category unlimited stock stockByClinic').lean())
    .map((product) => [String(product._id), product]));
  const ops = [];
  let skippedServices = 0;
  for (const row of rows) {
    if (String(row.tipo || '').toUpperCase() !== 'PRO') continue;
    const product = products.get(String(maps.products.get(String(row.id)) || ''));
    if (!product) continue;
    if (product.category !== 'insumo' || product.unlimited) { skippedServices += 1; continue; }
    const stock = num(row.cantidad_stock);
    const others = (product.stockByClinic || []).filter((entry) => String(entry.clinic) !== String(clinic._id));
    const current = (product.stockByClinic || []).find((entry) => String(entry.clinic) === String(clinic._id));
    if (num(product.stock) === stock && current && num(current.stock) === stock) continue;
    // Sin validadores a propósito: Contífico admite stock negativo (déficit) y aquí se refleja tal cual.
    ops.push({ updateOne: { filter: { _id: product._id }, update: { $set: {
      stock, stockByClinic: [...others, { clinic: clinic._id, stock }] } } } });
  }
  if (commit) for (let offset = 0; offset < ops.length; offset += 500) await Product.bulkWrite(ops.slice(offset, offset + 500), { ordered: false });
  return { products: rows.length, updated: ops.length, skippedServices, newProducts: nuevos };
}

async function syncInventory({ includeHistory = false, months: requestedMonths = null, commit = true, trigger = 'MANUAL' } = {}) {
  if (running) return { state: 'ALREADY_RUNNING' };
  if (!process.env.CONTIFICO_API_KEY) return { state: 'NO_API_KEY' };
  running = true;
  const holder = `${process.pid}:${randomUUID()}`;
  let renewal, leaseLost = false, acquired = false;
  try {
    const now = new Date();
    try {
      const claim = await ServerLease.findOneAndUpdate(
        { _id: LEASE_NAME, expiresAt: { $lte: now } },
        { $set: { holder, expiresAt: new Date(now.getTime() + LEASE_MS), renewedAt: now } },
        { upsert: true, new: true }
      );
      acquired = claim?.holder === holder;
    } catch (error) { if (error.code !== 11000) throw error; }
    if (!acquired) return { state: 'ALREADY_RUNNING' };
    renewal = setInterval(async () => {
      try {
        const result = await ServerLease.updateOne({ _id: LEASE_NAME, holder },
          { $set: { expiresAt: new Date(Date.now() + LEASE_MS), renewedAt: new Date() } });
        if (result.matchedCount !== 1) leaseLost = true;
      } catch (error) { leaseLost = true; console.error('[contifico-inventory-sync] Perdió arriendo:', error.message); }
    }, 60 * 1000);
    const assertLease = () => { if (leaseLost) throw new Error('Arriendo de sincronización perdido'); };
    const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
    if (!clinic) throw new Error('Clínica Central no encontrada');
    if (commit) await recordSyncState({ state: 'RUNNING', trigger, host: os.hostname(),
      startedAt: new Date(), completedAt: null, months: [], failures: [], lastError: '' });
    const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY });
    const today = ecToday();
    const windows = [];
    if (requestedMonths) {
      for (const value of requestedMonths) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Mes inválido ${value}`);
        windows.push(value.split('-').map(Number));
      }
    } else {
      windows.push([today.year, today.month], today.month === 1 ? [today.year - 1, 12] : [today.year, today.month - 1]);
      if (includeHistory) for (let month = today.month; month >= 1; month -= 1) windows.push([today.year, month]);
    }
    const seen = new Set();
    const result = [], failures = [];
    const notify = async (alertKey, title, error) => {
      if (!commit) return;
      await Notification.updateOne({ clinic: clinic._id, user: null, type: 'contifico_sync_blocked',
        'meta.month': alertKey, read: false }, { $setOnInsert: {
        clinic: clinic._id, user: null, type: 'contifico_sync_blocked', severity: 'error',
        meta: { month: alertKey }, title, body: String(error.message).slice(0, 500),
      } }, { upsert: true }).catch((notificationError) =>
        console.error('[contifico-inventory-sync] No pudo crear aviso:', notificationError.message));
    };
    const resolve = (alertKey) => (commit ? Notification.updateMany({ clinic: clinic._id, type: 'contifico_sync_blocked',
      'meta.month': alertKey, read: false }, { $set: { read: true, readAt: new Date() } })
      .catch((error) => console.error('[contifico-inventory-sync] Aviso resuelto:', error.message)) : null);
    for (const [year, month] of windows) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        assertLease();
        const outcome = await syncMovementMonth({ clinic, api, year, month, commit, assertLease });
        result.push(outcome);
        console.log(`[contifico-inventory-sync] ${key}: ${outcome.state}, ${outcome.source} movimientos`);
        await resolve(`inv-${key}`);
      } catch (error) {
        failures.push({ month: key, error: error.message });
        console.error(`[contifico-inventory-sync] BLOQUEADO ${key}:`, error.stack || error.message);
        await notify(`inv-${key}`, `Contífico: sincronización de inventario detenida (${key})`, error);
      }
    }
    let stock = null;
    try {
      assertLease();
      stock = await syncStock({ clinic, api, commit });
      await resolve('inv-stock');
    } catch (error) {
      failures.push({ month: 'stock', error: error.message });
      console.error('[contifico-inventory-sync] BLOQUEADO stock:', error.stack || error.message);
      await notify('inv-stock', 'Contífico: actualización de stock detenida', error);
    }
    const outcome = { state: failures.length ? 'PARTIAL' : 'COMPLETED', months: result, stock, failures };
    if (commit) await recordSyncState({ ...outcome, completedAt: new Date(),
      ...(failures.length ? {} : { lastSuccessfulAt: new Date() }) });
    return outcome;
  } catch (error) {
    if (acquired && commit) await recordSyncState({ state: 'FAILED', completedAt: new Date(),
      lastError: String(error.message).slice(0, 500) });
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (acquired) await ServerLease.deleteOne({ _id: LEASE_NAME, holder }).catch((error) =>
      console.error('[contifico-inventory-sync] No pudo soltar arriendo:', error.message));
    running = false;
  }
}

module.exports = { movementRows, syncMovementMonth, syncStock, syncInventory, importNewProducts };
