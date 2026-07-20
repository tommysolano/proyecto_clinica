const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse');
const InventoryCategory = require('../models/InventoryCategory');
const PhysicalCount = require('../models/PhysicalCount');
const FixedAsset = require('../models/FixedAsset');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const BankAccount = require('../models/BankAccount');
const CostCenter = require('../models/CostCenter');
const kardexService = require('../services/kardexService');
const { readIdempotencyKey } = require('../utils/idempotency');
const { canReq } = require('../utils/permissions');
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
  { header: 'cuenta_inventario', key: 'cuentaInventario', width: 18 },
  { header: 'cuenta_costo', key: 'cuentaCosto', width: 16 },
  { header: 'cuenta_venta', key: 'cuentaVenta', width: 16 },
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
  // Cuentas contables específicas del producto (código del plan; opcionales,
  // tienen prioridad sobre las de la categoría contable).
  cuentaInventario: ['cuenta inventario', 'cuenta de inventario'],
  cuentaCosto: ['cuenta costo', 'cuenta de costo', 'cuenta gasto', 'cuenta de gasto'],
  cuentaVenta: ['cuenta venta', 'cuenta de venta', 'cuenta ingreso'],
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
    help.addRow(['cuenta_inventario / cuenta_costo / cuenta_venta (opcionales): CÓDIGO de la cuenta del plan. Tienen prioridad sobre las cuentas de la categoría contable; si se dejan vacías se usan las de la categoría.']);
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
        // Crudos de cuentas contables por producto (código del plan, opcionales).
        _accInv: data.cuentaInventario ? String(data.cuentaInventario).trim() : '',
        _accCost: data.cuentaCosto ? String(data.cuentaCosto).trim() : '',
        _accSale: data.cuentaVenta ? String(data.cuentaVenta).trim() : '',
      });
    }

    // Índice código → cuenta para resolver las columnas cuenta_* (opcionales).
    const accountsList = await ChartOfAccount.find({ clinic: req.clinicId }).select('code allowsMovement').lean();
    const accByCode = new Map(accountsList.map((a) => [String(a.code).trim(), a]));
    const resolveAcc = (raw, label, code, errs) => {
      if (!raw) return undefined;
      const acc = accByCode.get(raw);
      if (!acc) { errs.push(`${code}: ${label} "${raw}" no existe en el plan de cuentas`); return undefined; }
      if (acc.allowsMovement === false) { errs.push(`${code}: ${label} "${raw}" es agrupadora (no permite movimiento)`); return undefined; }
      return acc._id;
    };

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
      // Cuentas contables por producto (prioridad sobre la categoría; error de fila si no existen).
      const accErrs = [];
      const inv = resolveAcc(p._accInv, 'cuenta_inventario', p.code, accErrs);
      const cost = resolveAcc(p._accCost, 'cuenta_costo', p.code, accErrs);
      const sale = resolveAcc(p._accSale, 'cuenta_venta', p.code, accErrs);
      if (accErrs.length) { rowErrors.push(...accErrs); continue; }
      if (inv !== undefined) p.inventoryAccount = inv;
      if (cost !== undefined) p.expenseAccount = cost;
      if (sale !== undefined) p.incomeAccount = sale;
      delete p._catId; delete p._catText; delete p._rawCategoria;
      delete p._accInv; delete p._accCost; delete p._accSale;
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
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active !== 'false';
  if (req.query.costCenter) filter.costCenter = req.query.costCenter;
  const items = await Warehouse.find(filter)
    .populate('chartAccount', 'code name')
    .populate('costCenter', 'code name active')
    .sort({ code: 1 });
  res.json(items);
};

/** El centro de costo de una bodega tiene que ser de la MISMA clínica y estar activo. */
async function validateWarehouseCostCenter(clinicId, costCenterId) {
  if (!costCenterId) return null;
  const cc = await CostCenter.findOne({ _id: costCenterId, clinic: clinicId });
  if (!cc) throw Object.assign(new Error('El centro de costo no existe en esta clínica'), { status: 400 });
  if (cc.active === false) throw Object.assign(new Error(`El centro de costo ${cc.name} está inactivo`), { status: 400 });
  return cc._id;
}

exports.createWarehouse = async (req, res) => {
  try {
    const costCenter = await validateWarehouseCostCenter(req.clinicId, req.body.costCenter);
    const w = await Warehouse.create({ ...req.body, costCenter, clinic: req.clinicId });
    res.status(201).json(w);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
exports.updateWarehouse = async (req, res) => {
  try {
    const w = await Warehouse.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!w) return res.status(404).json({ message: 'No encontrada' });
    if (req.body.costCenter !== undefined) {
      req.body.costCenter = await validateWarehouseCostCenter(req.clinicId, req.body.costCenter);
    }
    Object.assign(w, req.body); await w.save(); res.json(w);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
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

/**
 * Categoría de SERVICIO: su única cuenta es la de INGRESO por venta (obligatoria y de
 * movimiento). No maneja inventario, costo ni depreciación. Se limpian esos campos para que
 * una categoría de servicio nunca arrastre cuentas de inventario/activo por error.
 */
async function validateServiceCategory(clinicId, cat) {
  await assertMovementAccount(clinicId, cat.incomeAccount, 'cuenta de ingreso');
}
// Anula los campos que una categoría de SERVICIO no usa (inventario/activo/depreciación).
const SERVICE_UNUSED_FIELDS = ['assetAccount', 'expenseAccount', 'depreciationAccount', 'accumDepreciationAccount', 'impairmentAssetAccount', 'impairmentExpenseAccount', 'depreciationRate', 'usefulLifeYears', 'usefulLifeMonths', 'residualPercent', 'noDepreciate'];

exports.createCategory = async (req, res) => {
  try {
    if (req.body.kind === 'ACTIVO_FIJO') await validateAssetCategory(req.clinicId, req.body);
    if (req.body.kind === 'SERVICIO') { await validateServiceCategory(req.clinicId, req.body); for (const k of SERVICE_UNUSED_FIELDS) delete req.body[k]; }
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
    if (merged.kind === 'SERVICIO') { await validateServiceCategory(req.clinicId, merged); for (const k of SERVICE_UNUSED_FIELDS) { req.body[k] = undefined; c[k] = undefined; } }
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
 * Kardex VALORIZADO de un producto (motor único: `services/kardexService`).
 * query: { product (req), warehouse, type, from|startDate, to|endDate, sourceModel, lot }
 *
 * Lo calcula el servicio: saldo inicial anterior al rango, filas con unidades Y valor, costo
 * real (grabado / FIFO), fecha funcional y saldo acumulado. La pantalla y el Excel salen de
 * aquí, así que no pueden discrepar.
 */
exports.getKardex = async (req, res) => {
  try {
    const q = req.query;
    const data = await kardexService.buildKardex(req.clinicId, {
      product: q.product,
      warehouse: q.warehouse || null,
      type: q.type || null,
      from: q.from || q.startDate || null,
      to: q.to || q.endDate || null,
      sourceModel: q.sourceModel || null,
      lot: q.lot || null,
    });
    // Sin permiso de costos, los importes NO salen del servidor (no se ocultan en React).
    const final = canReq(req, 'inventory.costs') ? data : kardexService.stripCosts(data);
    // Compatibilidad con la pantalla actual, que lee `product` y `movements`.
    res.json({ ...final, product: final.producto, movements: final.rows });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/** Excel del kardex: saldo inicial, movimientos valorizados, saldo final y totales conciliables. */
exports.kardexExcel = async (req, res) => {
  try {
    const q = req.query;
    const data = await kardexService.buildKardex(req.clinicId, {
      product: q.product,
      warehouse: q.warehouse || null,
      type: q.type || null,
      from: q.from || q.startDate || null,
      to: q.to || q.endDate || null,
      sourceModel: q.sourceModel || null,
      lot: q.lot || null,
    });
    // Sin permiso de costos, las columnas de dinero NO se escriben en el archivo.
    const conCostos = canReq(req, 'inventory.costs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Kardex');
    ws.columns = [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Fecha estimada', key: 'estimada', width: 14 },
      { header: 'Movimiento', key: 'tipo', width: 12 },
      { header: 'Documento', key: 'doc', width: 18 },
      { header: 'Referencia', key: 'ref', width: 18 },
      { header: 'Bodega origen', key: 'origen', width: 16 },
      { header: 'Bodega destino', key: 'destino', width: 16 },
      { header: 'Entrada (u)', key: 'entQty', width: 12 },
      { header: 'Salida (u)', key: 'salQty', width: 12 },
      ...(conCostos ? [
        { header: 'Costo unitario', key: 'costo', width: 14 },
        { header: 'Valor entrada', key: 'entVal', width: 14 },
        { header: 'Valor salida', key: 'salVal', width: 14 },
      ] : []),
      { header: 'Saldo (u)', key: 'saldoQty', width: 12 },
      ...(conCostos ? [
        { header: 'Saldo ($)', key: 'saldoVal', width: 14 },
        { header: 'Costo promedio', key: 'prom', width: 14 },
      ] : []),
      { header: 'Asiento', key: 'asiento', width: 14 },
      { header: 'Usuario', key: 'usuario', width: 18 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } };

    // El kardex NO arranca en cero: la primera fila es el saldo que venía de antes.
    const inicial = ws.addRow({
      fecha: data.rango.from ? new Date(data.rango.from).toLocaleDateString('es-EC') : '',
      tipo: 'SALDO INICIAL',
      saldoQty: data.saldoInicial.qty,
      saldoVal: data.saldoInicial.value,
      prom: data.saldoInicial.unitCost,
    });
    inicial.font = { bold: true };

    for (const r of data.rows) {
      ws.addRow({
        fecha: new Date(r.date).toLocaleDateString('es-EC'),
        estimada: r.fechaEstimada ? 'SÍ (histórico sin fecha)' : '',
        tipo: r.esTraslado ? 'traslado' : r.type,
        doc: r.documento ? `${r.documento.model} ${String(r.documento.ref).slice(-6)}` : '',
        ref: r.referencia || r.motivo || '',
        origen: r.warehouse ? `${r.warehouse.code} ${r.warehouse.name}` : '',
        destino: r.toWarehouse ? `${r.toWarehouse.code} ${r.toWarehouse.name}` : '',
        entQty: r.entradaQty || 0,
        salQty: r.salidaQty || 0,
        costo: r.unitCost,
        entVal: r.entradaValor || 0,
        salVal: r.salidaValor || 0,
        saldoQty: r.saldoQty,
        saldoVal: r.saldoValor,
        prom: r.costoPromedio,
        asiento: r.journalEntry ? String(r.journalEntry).slice(-6) : '',
        usuario: r.usuario,
      });
    }

    const final = ws.addRow({
      tipo: 'SALDO FINAL',
      entQty: data.totales.entradasQty,
      salQty: data.totales.salidasQty,
      entVal: data.totales.entradasValor,
      salVal: data.totales.salidasValor,
      saldoQty: data.saldoFinal.qty,
      saldoVal: data.saldoFinal.value,
      prom: data.saldoFinal.unitCost,
    });
    final.font = { bold: true };
    if (conCostos) {
      ['costo', 'entVal', 'salVal', 'saldoVal', 'prom'].forEach((k) => { ws.getColumn(k).numFmt = '"$"#,##0.0000'; });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="kardex.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/**
 * Traslado de stock entre bodegas. body: { product, fromWarehouse, toWarehouse, quantity, reason }
 * Mueve realmente las capas de inventario (kardex): consume FIFO de la bodega de
 * origen y recrea capas equivalentes (mismo costo, lote y vencimiento) en la de
 * destino, de modo que el valor del inventario y la trazabilidad se conservan.
 * El stock global del producto no cambia (solo se reubica). Atómico en transacción.
 *
 * Impacto contable: si ambas bodegas tienen cuenta contable asignada y son
 * DISTINTAS, genera el asiento de reclasificación (débito inventario destino,
 * crédito inventario origen, al costo trasladado). Si comparten cuenta (o no
 * tienen), el traslado es solo movimiento de kardex, sin asiento financiero.
 */
exports.transferStock = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  try {
    const { product, fromWarehouse, toWarehouse, quantity, reason } = req.body;
    if (!product || !fromWarehouse || !toWarehouse || !quantity) return res.status(400).json({ message: 'product, fromWarehouse, toWarehouse y quantity requeridos' });
    if (String(fromWarehouse) === String(toWarehouse)) return res.status(400).json({ message: 'Las bodegas deben ser distintas' });
    const qty = kardex.round4(quantity);
    if (qty <= 0) return res.status(400).json({ message: 'Cantidad inválida' });
    // Fecha FUNCIONAL del traslado (la del documento), no la de grabación.
    const fecha = kardexService.parseLocalDate(req.body.date) || new Date();

    // Reintento: la misma clave devuelve el traslado ya hecho en vez de moverlo dos veces.
    if (idemKey) {
      const previo = await InventoryMovement.findOne({
        clinic: req.clinicId, type: 'traslado', reference: `IDEM:${idemKey}`,
      }).populate('warehouse toWarehouse', 'code name').populate('product', 'code name');
      if (previo) return res.json({ ...previo.toObject(), idempotentReplay: true });
    }

    let entryCreated = false;
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

      const cost = kardex.round2(totalCost);
      const [fromWh, toWh] = await Promise.all([
        Warehouse.findOne({ _id: fromWarehouse, clinic: req.clinicId }).session(session),
        Warehouse.findOne({ _id: toWarehouse, clinic: req.clinicId }).session(session),
      ]);
      if (!fromWh || !toWh) throw Object.assign(new Error('Bodega no encontrada en esta clínica'), { status: 404 });

      // Saldos por bodega DESPUÉS del traslado (de las capas, que son la fuente real: nunca de
      // `Product.stock`, que es global y no dice nada de una bodega).
      const [saldoOrigen, saldoDestino] = await Promise.all([
        kardex.currentStock({ clinicId: req.clinicId, product, warehouse: fromWarehouse }, session),
        kardex.currentStock({ clinicId: req.clinicId, product, warehouse: toWarehouse }, session),
      ]);

      // DOS patas con el mismo `transferGroup`: la salida de la bodega origen y la entrada en la
      // destino. Antes había un solo movimiento al que el kardex daba signo 0, así que el
      // traslado no aparecía NI en el origen NI en el destino. El costo es el de las capas
      // trasladadas: un traslado no puede generar utilidad ni usar el precio de venta.
      const transferGroup = new mongoose.Types.ObjectId();
      const comun = {
        clinic: req.clinicId,
        product,
        type: 'traslado',
        quantity: qty,
        unitCost: qty > 0 ? kardex.round4(cost / qty) : 0,
        totalCost: cost,
        transferGroup,
        movementDate: fecha,
        dateSource: 'DOCUMENTO',
        reason: reason || 'Traslado entre bodegas',
        // La clave de idempotencia se guarda en la referencia: un reintento la reconoce.
        reference: idemKey ? `IDEM:${idemKey}` : `TR-${String(transferGroup).slice(-6)}`,
        sourceModel: 'InventoryMovement',
        createdBy: req.user._id,
      };
      // Centro de costo: el de la bodega es una PROPUESTA. Si el usuario eligió otro (la UI le
      // avisa de la diferencia), se registra el que REALMENTE usó, que es lo que manda.
      const ccElegido = req.body.costCenter
        ? await CostCenter.findOne({ _id: req.body.costCenter, clinic: req.clinicId }).session(session)
        : null;
      if (req.body.costCenter && !ccElegido) {
        throw Object.assign(new Error('El centro de costo no existe en esta clínica'), { status: 400 });
      }
      const ccSalida = ccElegido?._id || fromWh.costCenter || null;
      const ccEntrada = ccElegido?._id || toWh.costCenter || null;

      const [salida] = await InventoryMovement.create([{
        ...comun,
        warehouse: fromWarehouse,
        toWarehouse,
        balanceAfter: saldoOrigen.qty,
        costCenter: ccSalida,
      }], { session });
      const [entrada] = await InventoryMovement.create([{
        ...comun,
        warehouse: toWarehouse,          // la pata de ENTRADA vive en la bodega destino
        toWarehouse: null,
        balanceAfter: saldoDestino.qty,
        costCenter: ccEntrada,
        sourceRef: salida._id,           // vínculo salida ↔ entrada
      }], { session });
      await InventoryMovement.updateOne({ _id: salida._id }, { $set: { sourceRef: entrada._id } }, { session });

      // Asiento de reclasificación entre cuentas de inventario cuando las bodegas están
      // parametrizadas con cuentas DISTINTAS. Nunca toca Caja ni Banco: es inventariable.
      if (cost > 0) {
        const fromAcc = fromWh?.chartAccount ? String(fromWh.chartAccount) : null;
        const toAcc = toWh?.chartAccount ? String(toWh.chartAccount) : null;
        if (fromAcc && toAcc && fromAcc !== toAcc) {
          const entry = await createEntry({
            clinicId: req.clinicId,
            date: fecha,
            description: `Traslado de ${prod.name} (${qty}) de ${fromWh.name} a ${toWh.name}`,
            source: 'TRASLADO',
            sourceModel: 'InventoryMovement',
            sourceRef: salida._id,
            sourceAction: `TRANSFER:${transferGroup}`,   // idempotente por traslado
            lines: [
              { account: toWh.chartAccount, debit: cost, credit: 0, description: `Entrada a bodega ${toWh.name}`, costCenter: ccEntrada },
              { account: fromWh.chartAccount, debit: 0, credit: cost, description: `Salida de bodega ${fromWh.name}`, costCenter: ccSalida },
            ],
            userId: req.user._id,
            session,
          });
          entryCreated = true;
          await InventoryMovement.updateMany(
            { _id: { $in: [salida._id, entrada._id] } },
            { $set: { journalEntry: entry._id } },
            { session }
          );
        }
      }
      return salida._id;
    });

    const mov = await InventoryMovement.findById(movId).populate('warehouse toWarehouse', 'code name').populate('product', 'code name');
    res.status(201).json({ ...mov.toObject(), journalEntryCreated: entryCreated });
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

/**
 * Historial de traslados (más recientes primero). Un traslado son DOS movimientos (salida y
 * entrada); aquí se lista UNA fila por traslado: la pata de SALIDA, que es la que lleva
 * `toWarehouse` y por tanto sabe de dónde a dónde fue.
 */
exports.listTransfers = async (req, res) => {
  try {
    const items = await InventoryMovement.find({
      clinic: req.clinicId, type: 'traslado', toWarehouse: { $ne: null },
    })
      .populate('product', 'code name')
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ----- Toma física -----

/**
 * Una toma sin permiso de costos viaja SIN importes: el contador físico cuenta unidades, no
 * necesita saber cuánto vale cada cosa. Se omite en el servidor, no en la pantalla.
 */
function countForRole(req, pc) {
  const doc = pc.toObject ? pc.toObject() : pc;
  if (canReq(req, 'inventory.costs')) return doc;
  return {
    ...doc,
    costsHidden: true,
    items: (doc.items || []).map((it) => ({ ...it, unitCost: null, adjustmentValue: null })),
  };
}

exports.listCounts = async (req, res) => {
  const items = await PhysicalCount.find({ clinic: req.clinicId })
    .populate('warehouse', 'code name')
    .populate('category', 'code name')
    .populate('responsible confirmedBy', 'name')
    .sort({ date: -1 });
  res.json(items.map((c) => countForRole(req, c)));
};

/**
 * Inicia una toma física de UNA bodega (obligatoria) y, opcionalmente, de UNA categoría de
 * inventario. Congela un SNAPSHOT: qué productos entran, cuánto decía el sistema EN ESA BODEGA
 * y a qué costo real (el de las capas vivas, no `purchasePrice`, que es el precio de hoy).
 *
 * Solo entran productos INVENTARIABLES de la clínica: nunca servicios, ni programas sin stock,
 * ni productos de stock ilimitado, ni inactivos (salvo `includeInactive`).
 */
exports.startCount = async (req, res) => {
  try {
    const {
      warehouse, category, description, notes, responsible, includeInactive,
    } = req.body;
    if (!warehouse) throw Object.assign(new Error('Indica la bodega: una toma física es de UNA bodega.'), { status: 400 });
    const wh = await Warehouse.findOne({ _id: warehouse, clinic: req.clinicId });
    if (!wh) throw Object.assign(new Error('La bodega no existe en esta clínica'), { status: 404 });
    if (wh.active === false) throw Object.assign(new Error('La bodega está inactiva'), { status: 400 });

    let cat = null;
    if (category) {
      cat = await InventoryCategory.findOne({ _id: category, clinic: req.clinicId });
      if (!cat) throw Object.assign(new Error('La categoría no existe en esta clínica'), { status: 404 });
    }

    const fecha = kardexService.parseLocalDate(req.body.date) || new Date();
    const count = await PhysicalCount.countDocuments({ clinic: req.clinicId });
    const code = `TF-${String(count + 1).padStart(5, '0')}`;

    // Inventariables: nunca servicios ni ilimitados.
    const filtro = {
      clinic: req.clinicId,
      unlimited: { $ne: true },
      category: { $ne: 'servicio' },
    };
    if (!includeInactive) filtro.active = true;
    if (cat) filtro.inventoryCategory = cat._id;
    const products = await Product.find(filtro).select('code name barcode categoria inventoryCategory').lean();

    // Stock y costo REALES de la bodega, leídos de las capas (nunca `Product.stock`, que es global).
    const existencias = await kardexService.stockByWarehouse({ clinicId: req.clinicId, warehouse });
    const porProducto = new Map(existencias.map((e) => [String(e.product), e]));

    const items = products.map((p) => {
      const e = porProducto.get(String(p._id)) || { qty: 0, unitCost: 0 };
      return {
        product: p._id,
        productCode: p.code,
        productName: p.name,
        barcode: p.barcode || '',
        inventoryCategory: p.inventoryCategory || null,
        categoria: p.categoria || '',
        systemQty: e.qty,
        countedQty: e.qty,
        counted: false,
        difference: 0,
        unitCost: e.unitCost,
        adjustmentValue: 0,
      };
    });

    const pc = await PhysicalCount.create({
      clinic: req.clinicId,
      code,
      warehouse: wh._id,
      category: cat?._id || null,
      date: fecha,
      responsible: responsible || null,
      description,
      notes,
      items,
      snapshotAt: new Date(),
      snapshotBy: req.user._id,
      createdBy: req.user._id,
    });
    res.status(201).json(countForRole(req, pc));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.updateCount = async (req, res) => {
  try {
    const pc = await PhysicalCount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!pc) return res.status(404).json({ message: 'No encontrada' });
    if (pc.status !== 'BORRADOR') return res.status(400).json({ message: 'No editable' });
    if (req.body.items) {
      // El SNAPSHOT manda: el sistema conserva su `systemQty` y su `unitCost`. Del cliente solo
      // se acepta lo contado y la observación; si no, recontar bastaría para cambiar el costo.
      const porProducto = new Map(pc.items.map((it) => [String(it.product), it]));
      for (const it of req.body.items) {
        const base = porProducto.get(String(it.product));
        if (!base) continue;
        const contado = Number(it.countedQty ?? base.systemQty) || 0;
        base.countedQty = contado;
        base.counted = it.counted !== undefined ? !!it.counted : true;
        base.difference = kardex.round4(contado - base.systemQty);
        base.adjustmentValue = kardex.round2(base.difference * base.unitCost);
        if (it.notes !== undefined) base.notes = it.notes;
      }
    }
    for (const k of ['description', 'notes']) if (req.body[k] !== undefined) pc[k] = req.body[k];
    await pc.save();
    res.json(countForRole(req, pc));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Confirma la toma física: ajusta el inventario DE SU BODEGA y contabiliza la diferencia.
 *
 * Lo que se corrigió aquí (era el bug más grave del módulo): `receiveStock`/`issueStock`/
 * `currentStock` se llamaban SIN bodega aunque la toma tuviera una. Los sobrantes creaban capas
 * con `warehouse: null` y los faltantes consumían capas FIFO de CUALQUIER bodega. Cada toma
 * física corrompía silenciosamente las existencias por bodega.
 *
 * Además, el faltante se valoraba al costo del snapshot; ahora se valora al costo REAL de las
 * capas consumidas (FIFO), que es lo que de verdad sale del inventario.
 *
 * Todo ocurre en UNA transacción: si algo falla, no queda ni medio ajuste. Doble confirmación
 * bloqueada por el estado, releído dentro de la transacción.
 */
exports.confirmCount = async (req, res) => {
  try {
    const countId = await runInTransaction(async (session) => {
      const pc = await PhysicalCount.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!pc) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (pc.status === 'CONFIRMADO') throw Object.assign(new Error('La toma ya fue confirmada: no se puede ajustar dos veces.'), { status: 400 });
      if (pc.status !== 'BORRADOR') throw Object.assign(new Error('No editable'), { status: 400 });
      if (!pc.warehouse) throw Object.assign(new Error('La toma no tiene bodega: no se puede saber qué existencias ajustar.'), { status: 400 });

      // Fecha FUNCIONAL de la toma (no la de grabación).
      const date = kardexService.parseLocalDate(req.body.date) || pc.date || new Date();
      await assertPeriodOpen(req.clinicId, date, { session });

      const wh = await Warehouse.findOne({ _id: pc.warehouse, clinic: req.clinicId }).session(session);
      if (!wh) throw Object.assign(new Error('La bodega de la toma ya no existe'), { status: 400 });
      const costCenter = wh.costCenter || null;

      let positive = 0;
      let negative = 0;
      let ajustes = 0;
      for (const it of pc.items) {
        const diff = kardex.round4((it.countedQty || 0) - (it.systemQty || 0));
        if (Math.abs(diff) < 0.00001) continue;
        ajustes += 1;
        let layerConsumption = [];
        let costoReal = kardex.round4(it.unitCost || 0);
        let valor;

        if (diff > 0) {
          // Sobrante: entra EN SU BODEGA, al costo del snapshot (el más reciente conocido).
          await kardex.receiveStock({
            clinicId: req.clinicId, product: it.product, warehouse: pc.warehouse,
            quantity: diff, unitCost: costoReal, date,
            sourceModel: 'PhysicalCount', sourceRef: pc._id, userId: req.user._id,
          }, session);
          valor = kardex.round2(diff * costoReal);
          positive += valor;
        } else {
          // Faltante: consume capas FIFO DE SU BODEGA y se valora al costo REAL que sale.
          const issue = await kardex.issueStock({
            clinicId: req.clinicId, product: it.product, warehouse: pc.warehouse,
            quantity: Math.abs(diff), allowNegative: true,
          }, session);
          layerConsumption = issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost }));
          valor = kardex.round2(issue.totalCost);
          if (valor > 0) costoReal = kardex.round4(valor / Math.abs(diff));
          negative += valor;
        }

        // Existencias de la bodega DESPUÉS del ajuste (de las capas, no del stock global).
        const enBodega = await kardex.currentStock({
          clinicId: req.clinicId, product: it.product, warehouse: pc.warehouse,
        }, session);
        // `Product.stock` es el agregado global de apoyo: se mantiene coherente, pero NO es la
        // fuente de la decisión por bodega.
        await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $inc: { stock: diff } }, { session });
        const global = await kardex.currentStock({ clinicId: req.clinicId, product: it.product }, session);
        await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $set: { averageCost: global.averageCost } }, { session });

        await InventoryMovement.create([{
          clinic: req.clinicId,
          product: it.product,
          type: diff > 0 ? 'entrada' : 'salida',
          warehouse: pc.warehouse,
          costCenter,
          movementDate: date,
          dateSource: 'DOCUMENTO',
          quantity: Math.abs(diff),
          unitCost: costoReal,
          totalCost: kardex.round2(valor),
          balanceAfter: enBodega.qty,
          layerConsumption,
          reason: 'Ajuste por toma física',
          reference: pc.code,
          sourceModel: 'PhysicalCount',
          sourceRef: pc._id,
          createdBy: req.user._id,
        }], { session });

        it.difference = diff;
        it.unitCost = costoReal;
        it.adjustmentValue = kardex.round2(diff > 0 ? valor : -valor);
      }

      if (!ajustes) {
        // Una toma sin diferencias es válida: se cierra sin asiento (no hay hecho económico).
        pc.status = 'CONFIRMADO';
        pc.confirmedAt = date;
        pc.confirmedBy = req.user._id;
        await pc.save({ session });
        return pc._id;
      }

      const net = kardex.round2(positive - negative);
      if (Math.abs(net) > 0.005) {
        const invAcc = wh.chartAccount
          ? await ChartOfAccount.findOne({ _id: wh.chartAccount, clinic: req.clinicId }).session(session)
          : await getAccount(req.clinicId, 'inventario', { session });
        const gasto = await getAccount(req.clinicId, 'mermaInventario', { session });
        // Una toma física NO toca Caja ni Banco: es puramente inventariable.
        const lines = net > 0
          ? [{ account: invAcc._id, debit: net, credit: 0, description: 'Sobrante de inventario', costCenter },
            { account: gasto._id, debit: 0, credit: net, description: `Ajuste sobrante ${pc.code}`, costCenter }]
          : [{ account: gasto._id, debit: -net, credit: 0, description: 'Faltante de inventario', costCenter },
            { account: invAcc._id, debit: 0, credit: -net, description: `Ajuste faltante ${pc.code}`, costCenter }];
        const entry = await createEntry({
          clinicId: req.clinicId,
          date,
          description: `Ajuste toma física ${pc.code} · ${wh.name}`,
          source: 'AJUSTE',
          sourceRef: pc._id,
          sourceModel: 'PhysicalCount',
          sourceAction: 'CONFIRM',      // idempotente: una toma, un asiento
          lines,
          userId: req.user._id,
          session,
        });
        pc.adjustmentEntry = entry._id;
        await InventoryMovement.updateMany(
          { clinic: req.clinicId, sourceModel: 'PhysicalCount', sourceRef: pc._id },
          { $set: { journalEntry: entry._id } },
          { session }
        );
      }

      pc.status = 'CONFIRMADO';
      pc.confirmedAt = date;
      pc.confirmedBy = req.user._id;
      await pc.save({ session });
      return pc._id;
    });
    const pc = await PhysicalCount.findById(countId);
    return res.json(pc);
  } catch (e) { return res.status(e.status || 400).json({ message: e.message }); }
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
    .populate('purchaseInvoice', 'serie fechaEmision total')
    .populate('journalEntry', 'number date');
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
          if (!bank.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });
          proceedsAccount = bank.chartAccount;
        } else {
          // Sin banco: el ingreso por la venta entra por Caja (rol configurable, no código fijo).
          proceedsAccount = (await getAccount(req.clinicId, 'caja', { session }))._id;
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
        // Pérdida en baja: gasto por rol configurable (no código fijo).
        const lossAcc = await getAccount(req.clinicId, 'otrosGastos', { session });
        lines.push({ account: lossAcc._id, debit: loss, credit: 0, description: `Perdida baja activo ${asset.code}` });
      }
      lines.push({ account: assetAccount, debit: 0, credit: cost, description: `Baja activo ${asset.code}` });
      if (gain > 0) {
        // Ganancia en baja: otros ingresos por rol configurable (no código fijo).
        const gainAcc = await getAccount(req.clinicId, 'otrosIngresos', { session });
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
