const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');

exports.getProducts = async (req, res) => {
  try {
    const { search, category, lowStock } = req.query;
    const query = { active: true };

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
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener producto' });
  }
};

exports.createProduct = async (req, res) => {
  try {
    const existing = await Product.findOne({ code: req.body.code });
    if (existing) {
      return res.status(400).json({ message: 'Ya existe un producto con ese código' });
    }

    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear producto', error: error.message });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar producto' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
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
    const query = {};

    if (product) query.product = product;
    if (type) query.type = type;
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const movements = await InventoryMovement.find(query)
      .populate('product', 'name code')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(movements);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener movimientos' });
  }
};

exports.createMovement = async (req, res) => {
  try {
    const { product: productId, type, quantity, reason, reference } = req.body;

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Producto no encontrado' });

    if (type === 'salida' && product.stock < quantity) {
      return res.status(400).json({ message: 'Stock insuficiente' });
    }

    // Actualizar stock
    if (type === 'entrada') {
      product.stock += quantity;
    } else if (type === 'salida') {
      product.stock -= quantity;
    } else {
      product.stock = quantity; // ajuste directo
    }
    await product.save();

    const movement = await InventoryMovement.create({
      product: productId,
      type,
      quantity,
      reason,
      reference,
      createdBy: req.user._id,
    });

    const populated = await movement
      .populate('product', 'name code stock')
      .then(doc => doc.populate('createdBy', 'name'));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear movimiento', error: error.message });
  }
};
