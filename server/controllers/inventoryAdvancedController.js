const Warehouse = require('../models/Warehouse');
const InventoryCategory = require('../models/InventoryCategory');
const PhysicalCount = require('../models/PhysicalCount');
const FixedAsset = require('../models/FixedAsset');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const BankAccount = require('../models/BankAccount');
const { createEntry, findAccount, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const kardex = require('../utils/kardex');
const ChartOfAccount = require('../models/ChartOfAccount');
const { PRODUCT_TYPES, PRODUCT_CATEGORIES, normalizeCategoria } = require('../utils/productCategories');
const { isPhysicalProduct, buildInventoryCategoryIndex, resolveInventoryCategoryForRow, normName } = require('../utils/productCategoryResolver');
const { normalizeAssetConfig, assetCategoryIssues } = require('../utils/fixedAssetConfig');
const ExcelJS = require('exceljs');
const multer = require('multer');

exports.uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

// Columnas de la plantilla de productos
const PRODUCT_TEMPLATE_COLUMNS = [
  { header: 'codigo', key: 'code', width: 16 },
  { header: 'nombre', key: 'name', width: 32 },
  { header: 'tipo', key: 'category', width: 14 },
  { header: 'categoria_contable', key: 'categoriaContable', width: 26 },
  { header: 'categoria', key: 'categoria', width: 24 },
  { header: 'unidad', key: 'unit', width: 12 },
  { header: 'precio_compra', key: 'purchasePrice', width: 14 },
  { header: 'precio_venta', key: 'salePrice', width: 14 },
  { header: 'stock', key: 'stock', width: 10 },
  { header: 'stock_minimo', key: 'minStock', width: 12 },
  { header: 'iva', key: 'taxRate', width: 8 },
  { header: 'ilimitado', key: 'unlimited', width: 10 },
];

// Encabezados aceptados por columna (además del oficial). Se comparan normalizados
// (mayúsculas, sin tildes, guiones bajos → espacios) para tolerar variantes.
const HEADER_ALIASES = {
  code: ['codigo', 'code'],
  name: ['nombre', 'name'],
  category: ['tipo', 'category'],
  // Categoría contable (InventoryCategory INVENTARIO): fuente principal de físicos.
  categoriaContable: ['categoria contable', 'categoriacontable'],
  inventoryCategory: ['inventorycategory', 'inventory category'],
  inventoryCategoryId: ['inventorycategoryid', 'inventory category id'],
  // Categoría comercial legacy (texto).
  categoria: ['categoria'],
  unit: ['unidad', 'unit'],
  purchasePrice: ['precio compra', 'preciocompra', 'purchaseprice'],
  salePrice: ['precio venta', 'precioventa', 'saleprice'],
  stock: ['stock'],
  minStock: ['stock minimo', 'stockminimo', 'minstock'],
  taxRate: ['iva', 'taxrate'],
  unlimited: ['ilimitado', 'unlimited'],
};

// Normaliza un encabezado para el matching por alias (guiones bajos = espacios).
const normHeader = (s) => normName(String(s || '').replace(/_/g, ' '));
// Índice alias-normalizado → key.
const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) m.set(normHeader(a), key);
  }
  return m;
})();

/** Descarga la plantilla Excel para carga masiva de productos. */
exports.downloadProductTemplate = async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = PRODUCT_TEMPLATE_COLUMNS;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    // Fila de ejemplo
    ws.addRow({ code: 'P001', name: 'Producto ejemplo', category: 'insumo', categoriaContable: 'Ampollas', categoria: 'AMPOLLAS', unit: 'unidad', purchasePrice: 5, salePrice: 10, stock: 100, minStock: 10, taxRate: 15, unlimited: 'NO' });
    // Hoja de ayuda
    const help = wb.addWorksheet('Instrucciones');
    help.addRow([`tipo: ${PRODUCT_TYPES.join(', ')}`]);
    help.addRow(['categoria_contable: nombre EXACTO de una Categoría de Inventario (Contabilidad → Categorías de Inventario). OBLIGATORIA para insumos (productos físicos). También se acepta la columna "inventoryCategory" con el ID de la categoría.']);
    help.addRow([`categoria (comercial, opcional/legacy): ${PRODUCT_CATEGORIES.join(' | ')}`]);
    help.addRow(['ilimitado: SI (servicios sin stock) o NO']);
    help.addRow(['iva: 0, 12 o 15']);
    help.addRow(['Servicios y programas NO requieren categoria_contable.']);
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
    try {
      await wb.xlsx.load(req.file.buffer);
    } catch (loadErr) {
      // Algunos generadores (no Excel) escriben .xlsx con namespaces con prefijo
      // que ExcelJS no puede leer (falla con "...reading 'sheets'"). Mensaje claro.
      return res.status(400).json({
        message:
          'No se pudo leer el archivo Excel. Ábrelo en Excel, Google Sheets o LibreOffice y vuelve a guardarlo como .xlsx (esto normaliza el formato); luego súbelo de nuevo.',
      });
    }
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ message: 'El archivo no tiene hojas' });

    // Mapear encabezados (fila 1) a claves, tolerando alias y variantes.
    const headerMap = {};
    ws.getRow(1).eachCell((cell, col) => {
      const key = HEADER_LOOKUP.get(normHeader(cell.value));
      if (key) headerMap[col] = key;
    });
    if (!Object.values(headerMap).includes('code') || !Object.values(headerMap).includes('name')) {
      return res.status(400).json({ message: 'La plantilla debe tener al menos las columnas codigo y nombre' });
    }

    // 'medicamento'/'otro' (valores antiguos) se mapean a 'insumo'.
    const normalizeTipo = (raw) => {
      const v = String(raw || '').toLowerCase().trim();
      if (PRODUCT_TYPES.includes(v)) return v;
      return 'insumo';
    };
    // 1) Parsear TODAS las filas primero. Si un código se repite en el archivo,
    //    la última fila gana (igual que el comportamiento anterior fila-por-fila).
    //    `_cat*` guardan los valores crudos de categoría para resolver luego.
    const byCode = new Map();
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
      const code = String(data.code).trim();
      byCode.set(code, {
        code,
        name: String(data.name).trim(),
        category: normalizeTipo(data.category),
        unit: data.unit ? String(data.unit).trim() : 'unidad',
        purchasePrice: Number(data.purchasePrice) || 0,
        salePrice: Number(data.salePrice) || 0,
        stock: Number(data.stock) || 0,
        minStock: Number(data.minStock) || 0,
        taxRate: data.taxRate !== undefined && data.taxRate !== null && data.taxRate !== '' ? Number(data.taxRate) : 15,
        unlimited: ['SI', 'SÍ', 'TRUE', '1', 'X'].includes(String(data.unlimited || '').trim().toUpperCase()),
        // Crudos para resolver categoría contable (no se persisten con estos nombres).
        _catId: data.inventoryCategory || data.inventoryCategoryId || '',
        _catText: data.categoriaContable || data.categoria || '',
        _rawCategoria: data.categoria || '',
      });
    }

    // Resolver la categoría contable de inventario por fila (sin crear categorías).
    // Físico sin categoría válida → error de fila (no se crea legacy silencioso).
    const catIndex = await buildInventoryCategoryIndex(req.clinicId);
    const products = [];
    const rowErrors = [];
    for (const p of byCode.values()) {
      const physical = isPhysicalProduct(p.category, p.unlimited);
      const { category, error } = resolveInventoryCategoryForRow({ index: catIndex, physical, idValue: p._catId, textValue: p._catText });
      if (error) { rowErrors.push(`${p.code}: ${error}`); continue; }
      if (category) {
        p.inventoryCategory = category._id;
        p.categoria = category.name; // sincroniza legacy con el nombre de la categoría
      } else {
        // No físico o sin categoría: conserva la categoría comercial legacy (normalizada).
        p.categoria = normalizeCategoria(p._rawCategoria);
      }
      delete p._catId; delete p._catText; delete p._rawCategoria;
      products.push(p);
    }

    // 2) Insertar/actualizar en bloque. Antes se hacían 2 consultas por fila
    //    (findOne + save), o sea ~2·N viajes secuenciales a Mongo, lo que con
    //    cientos de filas superaba el timeout del proxy (504). Ahora son 3
    //    operaciones en total: 1 consulta de existencias + 1 insertMany + 1 bulkWrite.
    let created = 0, updated = 0;
    const errors = [...rowErrors];
    if (products.length) {
      // Una sola consulta (usa el índice único { clinic, code }) para saber cuáles ya existen.
      const existing = await Product.find({ clinic: req.clinicId, code: { $in: products.map((p) => p.code) } })
        .select('code').lean();
      const existingCodes = new Set(existing.map((d) => d.code));

      const toInsert = [];
      const updateOps = [];
      for (const p of products) {
        if (existingCodes.has(p.code)) {
          // $set SOLO de los campos editables: preserva stock por clínica, cuentas contables, etc.
          updateOps.push({ updateOne: { filter: { clinic: req.clinicId, code: p.code }, update: { $set: p } } });
        } else {
          toInsert.push({ ...p, clinic: req.clinicId });
        }
      }

      // Nuevos: insertMany aplica los defaults y validadores del esquema en un solo viaje.
      if (toInsert.length) {
        try {
          const inserted = await Product.insertMany(toInsert, { ordered: false });
          created = inserted.length;
        } catch (e) {
          created = Array.isArray(e.insertedDocs) ? e.insertedDocs.length : 0;
          const writeErrors = e.writeErrors || (e.result && e.result.writeErrors) || [];
          writeErrors.forEach((we) => {
            const idx = typeof we.index === 'number' ? we.index : undefined;
            const code = idx != null && toInsert[idx] ? toInsert[idx].code : '';
            errors.push(`${code}: ${we.errmsg || (we.err && we.err.errmsg) || 'no se pudo crear'}`);
          });
          if (!writeErrors.length) errors.push(e.message);
        }
      }

      // Existentes: un solo bulkWrite para todas las actualizaciones.
      if (updateOps.length) {
        const res2 = await Product.bulkWrite(updateOps, { ordered: false });
        updated = typeof res2.matchedCount === 'number' ? res2.matchedCount : updateOps.length;
      }
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
// Verifica que una cuenta exista, sea de la clínica y permita movimiento.
async function assertMovementAccount(clinicId, accountId, label) {
  if (!accountId) throw Object.assign(new Error(`Falta la ${label}`), { status: 400 });
  const acc = await ChartOfAccount.findOne({ _id: accountId, clinic: clinicId });
  if (!acc) throw Object.assign(new Error(`La ${label} no existe o no pertenece a la clínica`), { status: 400 });
  if (acc.allowsMovement === false) throw Object.assign(new Error(`La ${label} no permite movimiento`), { status: 400 });
}

/**
 * Valida una categoría de ACTIVO_FIJO antes de guardarla: cuenta de activo obligatoria
 * y de movimiento; si es depreciable, exige cuentas de depreciación, vida útil, %
 * residual y tipo de gasto. Evita guardar categorías que luego rompan compras/depreciación.
 */
async function validateAssetCategory(clinicId, cat) {
  await assertMovementAccount(clinicId, cat.assetAccount, 'cuenta de activo');
  const cfg = normalizeAssetConfig(cat);
  if (!cfg.noDepreciate) {
    await assertMovementAccount(clinicId, cat.depreciationAccount, 'cuenta de gasto de depreciación');
    await assertMovementAccount(clinicId, cat.accumDepreciationAccount, 'cuenta de depreciación acumulada');
    if (!(cfg.usefulLifeMonths > 0)) throw Object.assign(new Error('La vida útil (meses) debe ser mayor a 0'), { status: 400 });
    if (!(cfg.residualPercent >= 0 && cfg.residualPercent <= 100)) throw Object.assign(new Error('El % residual debe estar entre 0 y 100'), { status: 400 });
    if (!cat.expenseType) throw Object.assign(new Error('El tipo de gasto es obligatorio (Administrativo/Ventas/Costos/Otro)'), { status: 400 });
  }
}

exports.createCategory = async (req, res) => {
  try {
    if (req.body.kind === 'ACTIVO_FIJO') await validateAssetCategory(req.clinicId, req.body);
    const c = await InventoryCategory.create({ ...req.body, clinic: req.clinicId });
    res.status(201).json(c);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
exports.updateCategory = async (req, res) => {
  try {
    const c = await InventoryCategory.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'No encontrada' });
    const merged = { ...c.toObject(), ...req.body };
    if (merged.kind === 'ACTIVO_FIJO') await validateAssetCategory(req.clinicId, merged);
    Object.assign(c, req.body); await c.save(); res.json(c);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
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

/**
 * Traslado de stock entre bodegas. body: { product, fromWarehouse, toWarehouse, quantity, reason }
 * Mueve realmente las capas de inventario (kardex): consume FIFO de la bodega de
 * origen y recrea capas equivalentes (mismo costo, lote y vencimiento) en la de
 * destino, de modo que el valor del inventario y la trazabilidad se conservan.
 * El stock global del producto no cambia (solo se reubica). Atómico en transacción.
 */
exports.transferStock = async (req, res) => {
  try {
    const { product, fromWarehouse, toWarehouse, quantity, reason } = req.body;
    if (!product || !fromWarehouse || !toWarehouse || !quantity) return res.status(400).json({ message: 'product, fromWarehouse, toWarehouse y quantity requeridos' });
    if (String(fromWarehouse) === String(toWarehouse)) return res.status(400).json({ message: 'Las bodegas deben ser distintas' });
    const qty = kardex.round4(quantity);
    if (qty <= 0) return res.status(400).json({ message: 'Cantidad inválida' });

    const movId = await runInTransaction(async (session) => {
      const prod = await Product.findOne({ _id: product, clinic: req.clinicId }).session(session);
      if (!prod) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });

      // Capas vivas en la bodega de origen, en orden FIFO.
      const layers = await InventoryLayer.find({
        clinic: req.clinicId, product, warehouse: fromWarehouse, qtyRemaining: { $gt: 0 },
      }).sort({ date: 1, createdAt: 1 }).session(session);

      const { plan, totalCost, shortfall } = kardex.planConsumption(layers, qty);
      if (shortfall > 0.00001) throw Object.assign(new Error('Stock insuficiente en la bodega de origen'), { status: 400 });

      const byId = new Map(layers.map((l) => [String(l._id), l]));
      for (const p of plan) {
        const layer = byId.get(String(p.layerId));
        if (!layer) continue;
        // Descuenta de la capa de origen.
        layer.qtyRemaining = kardex.round4(layer.qtyRemaining - p.qty);
        if (layer.qtyRemaining <= 0.00001) { layer.qtyRemaining = 0; layer.exhausted = true; }
        await layer.save({ session });
        // Recrea una capa equivalente en la bodega de destino, preservando costo,
        // lote, vencimiento y fecha (para mantener el orden/edad FIFO).
        await kardex.receiveStock({
          clinicId: req.clinicId, product, warehouse: toWarehouse,
          lot: layer.lot || '', expiryDate: layer.expiryDate || null,
          quantity: p.qty, unitCost: layer.unitCost, date: layer.date,
          sourceModel: 'Transfer', sourceRef: layer._id, userId: req.user._id,
        }, session);
      }

      const [mov] = await InventoryMovement.create([{
        clinic: req.clinicId, product, type: 'traslado',
        warehouse: fromWarehouse, toWarehouse, quantity: qty,
        totalCost: kardex.round2(totalCost),
        reason: reason || 'Traslado entre bodegas', balanceAfter: prod.stock,
        createdBy: req.user._id,
      }], { session });
      return mov._id;
    });

    const mov = await InventoryMovement.findById(movId).populate('warehouse toWarehouse', 'code name').populate('product', 'code name');
    res.status(201).json(mov);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Existencias por bodega: para cada producto con capas vivas, el stock y valor en
 * cada bodega (incluida la pseudo-bodega "Sin bodega" para capas sin asignar).
 * query opcional: { warehouse } para filtrar a una sola bodega.
 */
exports.warehouseStock = async (req, res) => {
  try {
    const match = { clinic: new (require('mongoose').Types.ObjectId)(req.clinicId), qtyRemaining: { $gt: 0 } };
    if (req.query.warehouse) match.warehouse = new (require('mongoose').Types.ObjectId)(req.query.warehouse);
    const rows = await InventoryLayer.aggregate([
      { $match: match },
      { $group: {
        _id: { product: '$product', warehouse: '$warehouse' },
        qty: { $sum: '$qtyRemaining' },
        value: { $sum: { $multiply: ['$qtyRemaining', '$unitCost'] } },
      } },
      { $group: {
        _id: '$_id.product',
        warehouses: { $push: { warehouse: '$_id.warehouse', qty: '$qty', value: '$value' } },
        totalQty: { $sum: '$qty' },
        totalValue: { $sum: '$value' },
      } },
    ]);
    const productIds = rows.map((r) => r._id);
    const products = await Product.find({ _id: { $in: productIds } }).select('code name unit category').lean();
    const prodMap = new Map(products.map((p) => [String(p._id), p]));
    const warehouses = await Warehouse.find({ clinic: req.clinicId }).select('code name').lean();
    const whMap = new Map(warehouses.map((w) => [String(w._id), w]));
    const out = rows.map((r) => ({
      product: prodMap.get(String(r._id)) || { _id: r._id },
      totalQty: kardex.round4(r.totalQty),
      totalValue: kardex.round2(r.totalValue),
      warehouses: r.warehouses
        .map((w) => ({
          warehouse: w.warehouse ? (whMap.get(String(w.warehouse)) || { _id: w.warehouse }) : null,
          qty: kardex.round4(w.qty),
          value: kardex.round2(w.value),
        }))
        .sort((a, b) => (a.warehouse?.code || '~').localeCompare(b.warehouse?.code || '~')),
    })).sort((a, b) => (a.product.name || '').localeCompare(b.product.name || ''));
    res.json(out);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Historial de traslados entre bodegas (más recientes primero). */
exports.listTransfers = async (req, res) => {
  try {
    const items = await InventoryMovement.find({ clinic: req.clinicId, type: 'traslado' })
      .populate('product', 'code name')
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
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
    {
      const countId = await runInTransaction(async (session) => {
        const pc = await PhysicalCount.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!pc) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (pc.status !== 'BORRADOR') throw Object.assign(new Error('No editable'), { status: 400 });
        const date = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, date, { session });

        let positive = 0;
        let negative = 0;
        for (const it of pc.items) {
          const diff = (it.countedQty || 0) - (it.systemQty || 0);
          if (diff === 0) continue;
          let layerConsumption = [];
          if (diff > 0) {
            // Sobrante: nueva capa al costo informado en el conteo.
            await kardex.receiveStock({
              clinicId: req.clinicId, product: it.product, quantity: diff,
              unitCost: it.unitCost || 0, date, sourceModel: 'PhysicalCount', sourceRef: pc._id, userId: req.user._id,
            }, session);
          } else {
            // Faltante/merma: consume capas FIFO.
            const issue = await kardex.issueStock({
              clinicId: req.clinicId, product: it.product, quantity: Math.abs(diff), allowNegative: true,
            }, session);
            layerConsumption = issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost }));
          }
          await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $inc: { stock: diff } }, { session });
          const cur = await kardex.currentStock({ clinicId: req.clinicId, product: it.product }, session);
          await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $set: { averageCost: cur.averageCost } }, { session });
          await InventoryMovement.create([{
            clinic: req.clinicId,
            product: it.product,
            type: diff > 0 ? 'entrada' : 'salida',
            quantity: Math.abs(diff),
            unitCost: it.unitCost || 0,
            totalCost: +(Math.abs(diff) * (it.unitCost || 0)).toFixed(2),
            balanceAfter: cur.qty,
            layerConsumption,
            reason: 'Ajuste por toma fisica',
            reference: pc.code,
            sourceModel: 'PhysicalCount',
            sourceRef: pc._id,
            createdBy: req.user._id,
          }], { session });
          const val = Math.abs(diff) * (it.unitCost || 0);
          if (diff > 0) positive += val;
          else negative += val;
        }

        if (positive > 0 || negative > 0) {
          const inv = await getAccount(req.clinicId, 'inventario', { session });
          const gasto = await getAccount(req.clinicId, 'mermaInventario', { session });
          const lines = [];
          const net = +(positive - negative).toFixed(2);
          if (net > 0) {
            lines.push({ account: inv._id, debit: net, credit: 0, description: 'Sobrante inventario' });
            lines.push({ account: gasto._id, debit: 0, credit: net, description: 'Ajuste sobrante' });
          } else if (net < 0) {
            lines.push({ account: gasto._id, debit: -net, credit: 0, description: 'Faltante inventario' });
            lines.push({ account: inv._id, debit: 0, credit: -net, description: 'Ajuste faltante' });
          }
          if (lines.length) {
            const entry = await createEntry({
              clinicId: req.clinicId,
              date,
              description: `Ajuste toma fisica ${pc.code}`,
              source: 'AJUSTE',
              sourceRef: pc._id,
              sourceModel: 'PhysicalCount',
              sourceAction: 'CONFIRM',
              lines,
              userId: req.user._id,
              session,
            });
            pc.adjustmentEntry = entry._id;
          }
        }
        pc.status = 'CONFIRMADO';
        pc.confirmedAt = date;
        pc.confirmedBy = req.user._id;
        await pc.save({ session });
        return pc._id;
      });
      const pc = await PhysicalCount.findById(countId);
      return res.json(pc);
    }

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

// Campos DESCRIPTIVOS que el usuario puede definir/editar en un activo. Las cuentas y
// parámetros contables NO se editan: se copian (snapshot) de la categoría.
const ASSET_DESCRIPTIVE = ['code', 'name', 'description', 'assetType', 'serial', 'location', 'locationClinic', 'responsible', 'purchaseInvoice', 'notes'];

exports.createAsset = async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.category) return res.status(400).json({ message: 'Debe seleccionar la categoría de activo fijo' });
    const cat = await InventoryCategory.findOne({ _id: b.category, clinic: req.clinicId, kind: 'ACTIVO_FIJO' });
    if (!cat) return res.status(400).json({ message: 'La categoría de activo fijo no existe o no pertenece a la clínica' });
    const issues = assetCategoryIssues(cat);
    if (issues.length) return res.status(400).json({ message: `La categoría de activo fijo no tiene configuración contable completa (falta: ${issues.join(', ')})` });

    const cfg = normalizeAssetConfig(cat);
    const cost = +Number(b.acquisitionCost || 0).toFixed(2);
    if (!(cost > 0)) return res.status(400).json({ message: 'El costo de adquisición debe ser mayor a 0' });
    const acquisitionDate = b.acquisitionDate ? new Date(b.acquisitionDate) : new Date();
    const residualValue = +(cost * (cfg.residualPercent / 100)).toFixed(2);
    const monthly = (cfg.noDepreciate || !cfg.usefulLifeMonths) ? 0 : +((cost - residualValue) / cfg.usefulLifeMonths).toFixed(2);

    const data = {
      clinic: req.clinicId, createdBy: req.user._id,
      category: cat._id,
      acquisitionCost: cost,
      acquisitionDate,
      startDate: b.startDate ? new Date(b.startDate) : acquisitionDate,
      // Snapshot desde la categoría (NO desde el body).
      assetAccount: cfg.assetAccount,
      depreciationAccount: cfg.depreciationAccount,
      accumDepreciationAccount: cfg.accumDepreciationAccount,
      usefulLifeMonths: cfg.usefulLifeMonths,
      residualPercent: cfg.residualPercent,
      depreciationRate: cfg.depreciationRate,
      expenseType: cfg.expenseType,
      residualValue,
      monthlyDepreciation: monthly,
      bookValue: cost,
    };
    for (const k of ASSET_DESCRIPTIVE) if (b[k] !== undefined) data[k] = b[k] || null;
    data.code = (b.code && String(b.code).trim()) || `AF-${String((await FixedAsset.countDocuments({ clinic: req.clinicId })) + 1).padStart(4, '0')}`;
    data.name = (b.name && String(b.name).trim()) || cat.name;
    const a = await FixedAsset.create(data);
    res.status(201).json(a);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.updateAsset = async (req, res) => {
  try {
    const a = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!a) return res.status(404).json({ message: 'No encontrado' });
    // Solo se editan campos descriptivos: las cuentas/parámetros contables son snapshot
    // de la categoría y NO se alteran desde aquí (no hay modo avanzado de override).
    for (const k of ASSET_DESCRIPTIVE) if (req.body[k] !== undefined) a[k] = req.body[k] || null;
    await a.save();
    res.json(a);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.deleteAsset = async (req, res) => {
  const a = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!a) return res.status(404).json({ message: 'No encontrado' });
  if (a.accumulatedDepreciation > 0) return res.status(400).json({ message: 'Ya tiene depreciaciones, dé de baja' });
  await a.deleteOne();
  res.json({ message: 'Eliminado' });
};

exports.disposeAsset = async (req, res) => {
  try {
    const assetId = await runInTransaction(async (session) => {
      const asset = await FixedAsset.findOne({ _id: req.params.id, clinic: req.clinicId })
        .populate('category')
        .session(session);
      if (!asset) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (asset.status !== 'ACTIVO') throw Object.assign(new Error('El activo ya no esta activo'), { status: 400 });

      const disposalDate = req.body.disposalDate ? new Date(req.body.disposalDate) : new Date();
      await assertPeriodOpen(req.clinicId, disposalDate, { session });
      const disposalValue = +Number(req.body.disposalValue || 0).toFixed(2);
      if (disposalValue < 0) throw Object.assign(new Error('Valor de baja invalido'), { status: 400 });

      const assetAccount = asset.assetAccount || asset.category?.assetAccount;
      const accumAccount = asset.accumDepreciationAccount || asset.category?.accumDepreciationAccount;
      if (!assetAccount) throw Object.assign(new Error(`Activo ${asset.code} sin cuenta de activo`), { status: 400 });
      if (asset.accumulatedDepreciation > 0 && !accumAccount) {
        throw Object.assign(new Error(`Activo ${asset.code} sin cuenta de depreciacion acumulada`), { status: 400 });
      }

      let proceedsAccount = null;
      if (disposalValue > 0) {
        if (req.body.bankAccount) {
          const bank = await BankAccount.findOne({ _id: req.body.bankAccount, clinic: req.clinicId }).session(session);
          if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
          proceedsAccount = bank.chartAccount;
        } else {
          proceedsAccount = (await findAccount(req.clinicId, { code: '1.1.01.01' }, { session }))._id;
        }
      }

      const cost = +Number(asset.acquisitionCost || 0).toFixed(2);
      const accumulated = +Number(asset.accumulatedDepreciation || 0).toFixed(2);
      const bookValue = +Math.max(0, cost - accumulated).toFixed(2);
      const gain = disposalValue > bookValue ? +(disposalValue - bookValue).toFixed(2) : 0;
      const loss = disposalValue < bookValue ? +(bookValue - disposalValue).toFixed(2) : 0;
      const lines = [];
      if (accumulated > 0) lines.push({ account: accumAccount, debit: accumulated, credit: 0, description: `Depreciacion acumulada ${asset.code}` });
      if (disposalValue > 0) lines.push({ account: proceedsAccount, debit: disposalValue, credit: 0, description: `Venta/baja activo ${asset.code}` });
      if (loss > 0) {
        const lossAcc = await findAccount(req.clinicId, { code: '6.1.99' }, { session });
        lines.push({ account: lossAcc._id, debit: loss, credit: 0, description: `Perdida baja activo ${asset.code}` });
      }
      lines.push({ account: assetAccount, debit: 0, credit: cost, description: `Baja activo ${asset.code}` });
      if (gain > 0) {
        const gainAcc = await findAccount(req.clinicId, { code: '4.2.02' }, { session });
        lines.push({ account: gainAcc._id, debit: 0, credit: gain, description: `Ganancia baja activo ${asset.code}` });
      }

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: disposalDate,
        description: `Baja activo ${asset.code}`,
        source: 'AJUSTE',
        sourceRef: asset._id,
        sourceModel: 'FixedAsset',
        sourceAction: 'DISPOSE',
        lines,
        userId: req.user._id,
        session,
      });

      asset.status = disposalValue > 0 ? 'VENDIDO' : 'DADO_DE_BAJA';
      asset.disposalDate = disposalDate;
      asset.disposalValue = disposalValue;
      asset.notes = [asset.notes, req.body.reason || req.body.notes].filter(Boolean).join('\n');
      asset.history.push({
        period: `${disposalDate.getFullYear()}-${String(disposalDate.getMonth() + 1).padStart(2, '0')}`,
        date: disposalDate,
        amount: 0,
        accumulated,
        bookValue: 0,
        journalEntry: entry._id,
      });
      asset.bookValue = 0;
      await asset.save({ session });
      return asset._id;
    });
    const asset = await FixedAsset.findById(assetId);
    res.json(asset);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * Corre depreciación mensual para todos los activos activos (idempotente por período).
 */
exports.runDepreciation = async (req, res) => {
  try {
    const { year, month } = req.body;
    {
      const result = await runInTransaction(async (session) => {
        const y = parseInt(year);
        const m = parseInt(month);
        if (!y || !m || m < 1 || m > 12) throw Object.assign(new Error('year y month invalidos'), { status: 400 });
        const period = `${y}-${String(m).padStart(2, '0')}`;
        const endOfMonth = new Date(y, m, 0, 23, 59, 59);
        await assertPeriodOpen(req.clinicId, endOfMonth, { session });

        const assets = await FixedAsset.find({ clinic: req.clinicId, status: 'ACTIVO' })
          .populate('category')
          .session(session);
        let totalDep = 0;
        const lines = [];
        const touchedAssets = [];
        for (const asset of assets) {
          if (asset.lastDepreciationPeriod >= period) continue;
          if (new Date(asset.startDate) > endOfMonth) continue;
          const remainingBase = (asset.acquisitionCost - (asset.residualValue || 0)) - asset.accumulatedDepreciation;
          if (remainingBase <= 0) continue;
          const dep = +Math.min(asset.monthlyDepreciation, remainingBase).toFixed(2);
          const depAccount = asset.depreciationAccount || asset.category?.depreciationAccount;
          const accumAccount = asset.accumDepreciationAccount || asset.category?.accumDepreciationAccount;
          if (!depAccount || !accumAccount) {
            throw Object.assign(new Error(`Activo ${asset.code} sin cuentas de depreciacion completas`), { status: 400 });
          }
          asset.accumulatedDepreciation = +(asset.accumulatedDepreciation + dep).toFixed(2);
          asset.bookValue = +(asset.acquisitionCost - asset.accumulatedDepreciation).toFixed(2);
          asset.lastDepreciationPeriod = period;
          asset.history.push({
            period,
            date: endOfMonth,
            amount: dep,
            accumulated: asset.accumulatedDepreciation,
            bookValue: asset.bookValue,
          });
          await asset.save({ session });
          touchedAssets.push(asset._id);
          totalDep += dep;
          lines.push({ account: depAccount, debit: dep, credit: 0, description: `Depreciacion ${asset.code} ${period}` });
          lines.push({ account: accumAccount, debit: 0, credit: dep, description: `Depreciacion acumulada ${asset.code}` });
        }

        let entry = null;
        if (lines.length) {
          const map = new Map();
          for (const l of lines) {
            const key = `${l.account}-${l.debit > 0 ? 'D' : 'C'}`;
            const cur = map.get(key) || { account: l.account, debit: 0, credit: 0, description: 'Depreciacion mensual' };
            cur.debit = +(cur.debit + l.debit).toFixed(2);
            cur.credit = +(cur.credit + l.credit).toFixed(2);
            map.set(key, cur);
          }
          entry = await createEntry({
            clinicId: req.clinicId,
            date: endOfMonth,
            description: `Depreciacion ${period}`,
            source: 'DEPRECIACION',
            sourceModel: 'FixedAsset',
            sourceRef: touchedAssets[0],
            sourceAction: `DEPRECIATION:${period}`,
            lines: Array.from(map.values()),
            userId: req.user._id,
            session,
          });
          await FixedAsset.updateMany(
            { _id: { $in: touchedAssets }, clinic: req.clinicId, lastDepreciationPeriod: period, status: 'ACTIVO' },
            { $set: { 'history.$[h].journalEntry': entry._id } },
            { arrayFilters: [{ 'h.period': period }], session }
          );
        }
        return { period, processed: touchedAssets.length, totalDepreciation: +totalDep.toFixed(2), journalEntry: entry };
      });
      return res.json(result);
    }
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
 * body: { rows: [{ code, name, category, salePrice, purchasePrice, stock, taxRate, unlimited,
 *                  inventoryCategory | inventoryCategoryId | categoriaContable | categoria }] }
 *
 * Para productos físicos (insumo no ilimitado) resuelve la categoría contable de
 * inventario (por id o por nombre normalizado). Si no la encuentra, rechaza la fila
 * con error (no crea productos legacy silenciosamente). Errores parciales: continúa
 * con las demás filas y los reporta en `errors`.
 */
exports.importProducts = async (req, res) => {
  try {
    const rows = req.body?.rows || [];
    const catIndex = await buildInventoryCategoryIndex(req.clinicId);
    let created = 0, updated = 0;
    const errors = [];
    for (const r of rows) {
      if (!r.code || !r.name) continue;
      const physical = isPhysicalProduct(r.category, r.unlimited);
      const idValue = r.inventoryCategory || r.inventoryCategoryId || '';
      const textValue = r.categoriaContable || r['categoría contable'] || r.categoria || r['categoría'] || '';
      const { category, error } = resolveInventoryCategoryForRow({ index: catIndex, physical, idValue, textValue });
      if (error) { errors.push(`${r.code}: ${error}`); continue; }

      // Se descartan los alias crudos y el id de categoría sin resolver (evita
      // castear un ObjectId inválido). inventoryCategory solo se persiste si resolvió.
      const { inventoryCategory, inventoryCategoryId, categoriaContable, ...clean } = r;
      delete clean['categoría contable'];
      delete clean['categoría'];
      if (category) {
        clean.inventoryCategory = category._id;
        clean.categoria = category.name; // sincroniza legacy
      }

      const exists = await Product.findOne({ clinic: req.clinicId, code: r.code });
      if (exists) {
        Object.assign(exists, clean);
        await exists.save(); updated++;
      } else {
        await Product.create({ ...clean, clinic: req.clinicId });
        created++;
      }
    }
    res.json({ created, updated, errors });
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
