const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const InventoryMovement = require('../models/InventoryMovement');
const Counter = require('../models/Counter');
const kardex = require('../utils/kardex');
const { runInTransaction } = require('../utils/accounting');
const { normName, isPhysicalProduct } = require('../utils/productCategoryResolver');

/**
 * Resuelve y valida la categoría contable de inventario (`InventoryCategory`,
 * kind INVENTARIO) de un producto y sincroniza el campo legacy `categoria`.
 * Muta `body`. Reglas:
 *   - Si llega `inventoryCategory`: debe existir, pertenecer a la clínica, estar
 *     activa y ser kind INVENTARIO (error claro si no).
 *   - Si solo llega `categoria` (texto legacy): intenta resolver una categoría
 *     por nombre normalizado; si existe la asigna a `inventoryCategory`.
 *   - Si el producto es físico y `enforce`, exige una categoría contable.
 *   - Si se resuelve una categoría, copia su `name` a `categoria` (compat visual).
 *
 * @param {boolean} enforce  exigir categoría para productos físicos (true en create).
 * @param {Object|null} existing  producto actual (para inferir tipo en updates parciales).
 */
async function applyInventoryCategory(clinicId, body, { enforce, existing = null } = {}) {
  // '' desde el front = sin categoría → null. (undefined en update = no se toca.)
  if (body.inventoryCategory === '') body.inventoryCategory = null;
  const effCategory = body.category !== undefined ? body.category : existing?.category;
  const effUnlimited = body.unlimited !== undefined ? body.unlimited : existing?.unlimited;
  const physical = isPhysicalProduct(effCategory, effUnlimited);

  let category = null;
  const provided = body.inventoryCategory != null && body.inventoryCategory !== '';
  if (provided) {
    category = await InventoryCategory.findOne({ _id: body.inventoryCategory, clinic: clinicId });
    if (!category) throw Object.assign(new Error('La categoría de inventario no existe o no pertenece a la clínica'), { status: 400 });
    if (category.active === false) throw Object.assign(new Error(`La categoría de inventario "${category.name}" está inactiva`), { status: 400 });
    if (category.kind !== 'INVENTARIO') throw Object.assign(new Error(`La categoría "${category.name}" no es de tipo INVENTARIO`), { status: 400 });
  } else if (body.categoria) {
    // Compatibilidad legacy: resolver por nombre normalizado dentro de la clínica.
    const target = normName(body.categoria);
    const candidates = await InventoryCategory.find({ clinic: clinicId, kind: 'INVENTARIO', active: true });
    category = candidates.find((c) => normName(c.name) === target) || null;
    if (category) body.inventoryCategory = category._id;
    else if (physical && enforce) {
      throw Object.assign(new Error(`No existe una categoría contable de inventario "${body.categoria}". Créala en Categorías de Inventario y asígnala.`), { status: 400 });
    }
  }

  // Exigir categoría contable para productos físicos (solo en create / cuando enforce).
  const effInventoryCategory = category || (existing && existing.inventoryCategory);
  if (enforce && physical && !effInventoryCategory) {
    throw Object.assign(new Error('Los productos de inventario (insumos) requieren una categoría contable de inventario.'), { status: 400 });
  }

  // Sincronizar el campo legacy `categoria` con el nombre de la categoría contable.
  if (category) body.categoria = category.name;
}

// Código automático de producto: prefijo + secuencia por clínica.
const CODE_PREFIX = 'P';
const CODE_PAD = 5;
const CODE_KEY = 'product-code';

// Siembra el contador la primera vez a partir del mayor código P##### existente,
// para no chocar con productos previos. Idempotente.
async function ensureCodeCounter(clinicId) {
  let counter = await Counter.findOne({ clinic: clinicId, key: CODE_KEY });
  if (counter) return counter;
  const last = await Product.findOne({
    clinic: clinicId,
    code: new RegExp(`^${CODE_PREFIX}\\d+$`),
  })
    .sort({ code: -1 })
    .select('code');
  let start = 0;
  if (last) {
    const m = last.code.match(/(\d+)$/);
    if (m) start = parseInt(m[1], 10);
  }
  try {
    counter = await Counter.create({ clinic: clinicId, key: CODE_KEY, seq: start });
  } catch (e) {
    if (e.code !== 11000) throw e;
    counter = await Counter.findOne({ clinic: clinicId, key: CODE_KEY });
  }
  return counter;
}

const fmtCode = (n) => `${CODE_PREFIX}${String(n).padStart(CODE_PAD, '0')}`;

// Genera (y reserva) el siguiente código libre de forma atómica. Reintenta si el
// código generado coincidiera con uno ingresado manualmente.
async function nextProductCode(clinicId) {
  await ensureCodeCounter(clinicId);
  for (let i = 0; i < 50; i++) {
    const updated = await Counter.findOneAndUpdate(
      { clinic: clinicId, key: CODE_KEY },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const code = fmtCode(updated.seq);
    const clash = await Product.findOne({ clinic: clinicId, code }).select('_id');
    if (!clash) return code;
  }
  throw Object.assign(new Error('No se pudo generar un código de producto único'), { status: 500 });
}

// Calcula el siguiente código SIN reservarlo (solo para previsualizar en la UI).
async function peekProductCode(clinicId) {
  const counter = await ensureCodeCounter(clinicId);
  let seq = counter ? counter.seq : 0;
  for (let i = 1; i <= 50; i++) {
    const code = fmtCode(seq + i);
    const clash = await Product.findOne({ clinic: clinicId, code }).select('_id');
    if (!clash) return code;
  }
  return fmtCode(seq + 1);
}

// Populate de la categoría contable de inventario + sus cuentas (activo/costo/ingreso).
const INVENTORY_CATEGORY_POPULATE = {
  path: 'inventoryCategory',
  select: 'code name kind active assetAccount expenseAccount incomeAccount',
  populate: [
    { path: 'assetAccount', select: 'code name' },
    { path: 'expenseAccount', select: 'code name' },
    { path: 'incomeAccount', select: 'code name' },
  ],
};

exports.getProducts = async (req, res) => {
  try {
    const { search, category, categoria, inventoryCategory, lowStock } = req.query;
    // Catálogo COMPARTIDO por toda la organización: un producto no pertenece a una
    // sola sucursal. `availableInClinics` decide en qué sucursales se ofrece: vacío
    // (o ausente) = disponible en TODAS; con clínicas = solo en esas. Por eso el
    // listado se filtra por disponibilidad, no por la sucursal dueña (antes solo se
    // veían los productos de la sucursal que los creó, ocultándolos en las demás).
    const query = {
      active: true,
      $and: [
        {
          $or: [
            { availableInClinics: { $exists: false } },
            { availableInClinics: { $size: 0 } },
            { availableInClinics: req.clinicId },
          ],
        },
      ],
    };

    if (search) {
      // Escapa el texto: códigos con ( ) + [ . etc. rompían el regex y "no encontraba" el producto.
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$and.push({
        $or: [
          { name: { $regex: safe, $options: 'i' } },
          { code: { $regex: safe, $options: 'i' } },
        ],
      });
    }
    if (category) query.category = category;
    // Filtro principal por categoría contable; `categoria` (texto) queda como legacy.
    if (inventoryCategory) query.inventoryCategory = inventoryCategory;
    if (categoria) query.categoria = categoria;
    if (lowStock === 'true') {
      query.unlimited = { $ne: true };
      query.$expr = { $lte: ['$stock', '$minStock'] };
    }

    const products = await Product.find(query)
      .populate(INVENTORY_CATEGORY_POPULATE)
      .sort({ name: 1 });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos' });
  }
};

exports.getProduct = async (req, res) => {
  try {
    // Catálogo compartido: el producto se puede consultar desde cualquier sucursal.
    const product = await Product.findOne({ _id: req.params.id }).populate(INVENTORY_CATEGORY_POPULATE);
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener producto' });
  }
};

// Si se envía stockByClinic, el stock total del producto es la suma por clínica.
const syncStockFromClinics = (body) => {
  if (Array.isArray(body.stockByClinic) && body.stockByClinic.length > 0) {
    body.stock = body.stockByClinic.reduce((a, s) => a + (Number(s.stock) || 0), 0);
  }
};

exports.createProduct = async (req, res) => {
  try {
    let code = String(req.body.code || '').trim();
    if (!code) {
      // Sin código → el sistema lo genera automáticamente.
      code = await nextProductCode(req.clinicId);
    } else {
      // Código único en todo el catálogo compartido (no solo dentro de una sucursal).
      const existing = await Product.findOne({ code });
      if (existing) {
        return res.status(400).json({ message: 'Ya existe un producto con ese código' });
      }
    }

    syncStockFromClinics(req.body);
    // Valida/resuelve la categoría contable de inventario (obligatoria para insumos).
    await applyInventoryCategory(req.clinicId, req.body, { enforce: true });
    const product = await Product.create({ ...req.body, clinic: req.clinicId, code });
    res.status(201).json(product);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Error al crear producto', error: error.message });
  }
};

// Previsualiza el próximo código automático (no lo reserva).
exports.previewNextCode = async (req, res) => {
  try {
    const code = await peekProductCode(req.clinicId);
    res.json({ code });
  } catch (error) {
    res.status(500).json({ message: 'Error al generar código' });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    // Catálogo compartido: editable desde cualquier sucursal.
    const existing = await Product.findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ message: 'Producto no encontrado' });
    syncStockFromClinics(req.body);
    // Valida/resuelve la categoría contable si se envía; NO bloquea la edición de
    // productos legacy sin categoría (enforce:false) para no romper flujos existentes.
    await applyInventoryCategory(req.clinicId, req.body, { enforce: false, existing });
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id },
      req.body,
      { new: true, runValidators: true }
    ).populate(INVENTORY_CATEGORY_POPULATE);
    res.json(product);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Error al actualizar producto' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    // Catálogo compartido: se puede desactivar desde cualquier sucursal.
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id },
      { active: false },
      { new: true }
    );
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json({ message: 'Producto eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar producto' });
  }
};

// Movimientos de inventario
exports.getMovements = async (req, res) => {
  try {
    const { product, type, startDate, endDate } = req.query;
    const query = { clinic: req.clinicId };

    if (product) query.product = product;
    if (type) query.type = type;
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const movements = await InventoryMovement.find(query)
      .populate('product', 'name code')
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(200);

    res.json(movements);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener movimientos' });
  }
};

/**
 * Si el producto tiene stock pero ninguna capa de inventario viva (datos previos
 * al kardex), crea una capa de apertura "Sin bodega" para conciliar, de modo que
 * los movimientos posteriores no descarten ese stock heredado al recalcular el
 * stock global desde las capas. Idempotente: solo actúa cuando no hay capas.
 */
async function reconcileOpeningLayer(clinicId, product, userId, session) {
  const cur = await kardex.currentStock({ clinicId, product: product._id }, session);
  if (cur.qty <= 0 && Number(product.stock) > 0) {
    await kardex.receiveStock({
      clinicId, product: product._id, warehouse: null,
      quantity: Number(product.stock),
      unitCost: Number(product.averageCost || product.purchasePrice || 0),
      date: new Date('2000-01-01'), sourceModel: 'Opening', userId,
    }, session);
  }
}

/**
 * Movimiento manual de inventario (entrada / salida / ajuste), opcionalmente en
 * una bodega. Pasa por el sistema de capas (kardex) para que las existencias por
 * bodega y la valoración FIFO sean reales. El stock global del producto queda como
 * caché de la suma de capas vivas. Atómico en transacción.
 */
exports.createMovement = async (req, res) => {
  try {
    const { product: productId, type, quantity, reason, reference, warehouse, unitCost } = req.body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ message: 'Cantidad inválida' });
    if (!['entrada', 'salida', 'ajuste'].includes(type)) return res.status(400).json({ message: 'Tipo inválido' });
    const wh = warehouse || null;

    const movId = await runInTransaction(async (session) => {
      const product = await Product.findOne({ _id: productId, clinic: req.clinicId }).session(session);
      if (!product) throw Object.assign(new Error('Producto no encontrado'), { status: 404 });
      if (product.unlimited) throw Object.assign(new Error('Los productos/servicios ilimitados no manejan stock'), { status: 400 });

      await reconcileOpeningLayer(req.clinicId, product, req.user._id, session);

      const layerConsumption = [];
      let movUnitCost = Number(unitCost) || Number(product.averageCost || product.purchasePrice || 0);
      let movTotalCost = 0;

      if (type === 'entrada') {
        await kardex.receiveStock({
          clinicId: req.clinicId, product: product._id, warehouse: wh,
          quantity: qty, unitCost: movUnitCost, date: new Date(),
          sourceModel: 'Adjustment', userId: req.user._id,
        }, session);
        movTotalCost = kardex.round2(qty * movUnitCost);
      } else if (type === 'salida') {
        const issue = await kardex.issueStock({
          clinicId: req.clinicId, product: product._id, warehouse: wh,
          quantity: qty, allowNegative: false,
        }, session);
        movTotalCost = issue.totalCost;
        movUnitCost = qty > 0 ? kardex.round4(issue.totalCost / qty) : 0;
        for (const c of issue.consumption) layerConsumption.push({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost });
      } else { // ajuste: fija el stock de la bodega (o "sin bodega") al valor indicado
        const curWh = await kardex.currentStock({ clinicId: req.clinicId, product: product._id, warehouse: wh }, session);
        const delta = kardex.round4(qty - curWh.qty);
        if (delta > 0) {
          await kardex.receiveStock({
            clinicId: req.clinicId, product: product._id, warehouse: wh,
            quantity: delta, unitCost: movUnitCost, date: new Date(),
            sourceModel: 'Adjustment', userId: req.user._id,
          }, session);
          movTotalCost = kardex.round2(delta * movUnitCost);
        } else if (delta < 0) {
          const issue = await kardex.issueStock({
            clinicId: req.clinicId, product: product._id, warehouse: wh,
            quantity: -delta, allowNegative: false,
          }, session);
          movTotalCost = issue.totalCost;
          for (const c of issue.consumption) layerConsumption.push({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost });
        }
      }

      // El stock global y el costo promedio pasan a ser caché de las capas vivas.
      const cur = await kardex.currentStock({ clinicId: req.clinicId, product: product._id }, session);
      product.stock = cur.qty;
      product.averageCost = cur.averageCost;
      await product.save({ session });

      const [movement] = await InventoryMovement.create([{
        clinic: req.clinicId,
        product: productId,
        type,
        warehouse: wh,
        quantity: qty,
        unitCost: movUnitCost,
        totalCost: movTotalCost,
        balanceAfter: product.stock,
        layerConsumption,
        reason,
        reference,
        createdBy: req.user._id,
      }], { session });
      return movement._id;
    });

    const populated = await InventoryMovement.findById(movId)
      .populate('product', 'name code stock')
      .populate('warehouse toWarehouse', 'code name')
      .populate('createdBy', 'name');
    res.status(201).json(populated);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Error al crear movimiento' });
  }
};

/**
 * Inventario consolidado: agrupa por código de producto el stock de TODAS las
 * clínicas a las que el usuario tiene acceso (o todas las activas si es superadmin).
 * Devuelve también el desglose por clínica para cada producto.
 */
exports.getConsolidated = async (req, res) => {
  try {
    const Clinic = require('../models/Clinic');
    let clinicIds;
    if (req.user.isSuperAdmin) {
      clinicIds = (await Clinic.find({ active: true }).select('_id')).map((c) => c._id);
    } else {
      clinicIds = (req.user.clinics || []).map((c) => c.clinic);
    }
    if (!clinicIds.length) return res.json([]);

    const rows = await Product.aggregate([
      { $match: { clinic: { $in: clinicIds }, active: true } },
      {
        $group: {
          _id: '$code',
          name: { $first: '$name' },
          category: { $first: '$category' },
          unit: { $first: '$unit' },
          unlimited: { $first: '$unlimited' },
          totalStock: { $sum: '$stock' },
          minStockSum: { $sum: '$minStock' },
          avgSalePrice: { $avg: '$salePrice' },
          avgPurchasePrice: { $avg: '$purchasePrice' },
          totalValue: { $sum: { $multiply: ['$stock', { $ifNull: ['$averageCost', '$purchasePrice'] }] } },
          byClinic: {
            $push: {
              clinic: '$clinic',
              productId: '$_id',
              stock: '$stock',
              minStock: '$minStock',
              salePrice: '$salePrice',
              purchasePrice: '$purchasePrice',
              averageCost: '$averageCost',
            },
          },
        },
      },
      { $sort: { name: 1 } },
    ]);

    // Resolver nombres de clínicas (una sola consulta)
    const clinics = await Clinic.find({ _id: { $in: clinicIds } }).select('name');
    const cmap = Object.fromEntries(clinics.map((c) => [String(c._id), c.name]));
    for (const r of rows) {
      r.byClinic = r.byClinic.map((x) => ({ ...x, clinicName: cmap[String(x.clinic)] || '—' }));
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener inventario consolidado', error: e.message });
  }
};
