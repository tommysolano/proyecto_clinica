const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Counter = require('../models/Counter');
const kardex = require('../utils/kardex');
const { runInTransaction } = require('../utils/accounting');

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

exports.getProducts = async (req, res) => {
  try {
    const { search, category, categoria, lowStock } = req.query;
    const query = { clinic: req.clinicId, active: true };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }
    if (category) query.category = category;
    if (categoria) query.categoria = categoria;
    if (lowStock === 'true') {
      query.unlimited = { $ne: true };
      query.$expr = { $lte: ['$stock', '$minStock'] };
    }

    const products = await Product.find(query).sort({ name: 1 });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos' });
  }
};

exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, clinic: req.clinicId });
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
      const existing = await Product.findOne({ clinic: req.clinicId, code });
      if (existing) {
        return res.status(400).json({ message: 'Ya existe un producto con ese código' });
      }
    }

    syncStockFromClinics(req.body);
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
    syncStockFromClinics(req.body);
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar producto' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
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
