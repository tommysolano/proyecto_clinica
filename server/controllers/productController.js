const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');

exports.getProducts = async (req, res) => {
  try {
    const { search, category, lowStock } = req.query;
    const query = { clinic: req.clinicId, active: true };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }
    if (category) query.category = category;
    if (lowStock === 'true') {
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

exports.createProduct = async (req, res) => {
  try {
    const existing = await Product.findOne({ clinic: req.clinicId, code: req.body.code });
    if (existing) {
      return res.status(400).json({ message: 'Ya existe un producto con ese código' });
    }

    const product = await Product.create({ ...req.body, clinic: req.clinicId });
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear producto', error: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
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
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(200);

    res.json(movements);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener movimientos' });
  }
};

exports.createMovement = async (req, res) => {
  try {
    const { product: productId, type, quantity, reason, reference } = req.body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ message: 'Cantidad inválida' });
    }

    const product = await Product.findOne({ _id: productId, clinic: req.clinicId });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });

    if (type === 'salida' && product.stock < qty) {
      return res.status(400).json({ message: 'Stock insuficiente' });
    }

    if (type === 'entrada') {
      product.stock += qty;
    } else if (type === 'salida') {
      product.stock -= qty;
    } else {
      product.stock = qty;
    }
    await product.save();

    const movement = await InventoryMovement.create({
      clinic: req.clinicId,
      product: productId,
      type,
      quantity: qty,
      balanceAfter: product.stock,
      reason,
      reference,
      createdBy: req.user._id,
    });

    const populated = await movement
      .populate('product', 'name code stock')
      .then((doc) => doc.populate('createdBy', 'name'));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear movimiento', error: error.message });
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
