const Sale = require('../models/Sale');
const Product = require('../models/Product');

exports.getSales = async (req, res) => {
  try {
    const { startDate, endDate, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (status) query.status = status;

    const sales = await Sale.find(query)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Sale.countDocuments(query);

    res.json({
      sales,
      total,
      pages: Math.ceil(total / limit),
      currentPage: parseInt(page),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas' });
  }
};

exports.getSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .populate('patient', 'firstName lastName cedula')
      .populate('items.product', 'name code')
      .populate('createdBy', 'name');

    if (!sale) return res.status(404).json({ message: 'Venta no encontrada' });
    res.json(sale);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta' });
  }
};

exports.createSale = async (req, res) => {
  try {
    const { items, patient, clientName, clientCedula, paymentMethod, notes } = req.body;

    // Validar stock y calcular totales
    let subtotal = 0;
    let taxAmount = 0;
    const saleItems = [];

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({ message: `Producto no encontrado: ${item.product}` });
      }

      if (product.category !== 'servicio' && product.stock < item.quantity) {
        return res.status(400).json({ message: `Stock insuficiente para: ${product.name}` });
      }

      const itemSubtotal = product.salePrice * item.quantity;
      const itemTax = itemSubtotal * (product.taxRate / 100);

      saleItems.push({
        product: product._id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice: product.salePrice,
        taxRate: product.taxRate,
        subtotal: itemSubtotal,
      });

      subtotal += itemSubtotal;
      taxAmount += itemTax;

      // Descontar stock (excepto servicios)
      if (product.category !== 'servicio') {
        product.stock -= item.quantity;
        await product.save();
      }
    }

    const sale = await Sale.create({
      items: saleItems,
      patient,
      clientName,
      clientCedula,
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
      paymentMethod,
      notes,
      createdBy: req.user._id,
    });

    const populated = await sale
      .populate('patient', 'firstName lastName cedula')
      .then(doc => doc.populate('createdBy', 'name'));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear venta', error: error.message });
  }
};

exports.cancelSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) return res.status(404).json({ message: 'Venta no encontrada' });

    if (sale.status === 'anulada') {
      return res.status(400).json({ message: 'La venta ya está anulada' });
    }

    // Restaurar stock
    for (const item of sale.items) {
      const product = await Product.findById(item.product);
      if (product && product.category !== 'servicio') {
        product.stock += item.quantity;
        await product.save();
      }
    }

    sale.status = 'anulada';
    await sale.save();

    res.json({ message: 'Venta anulada exitosamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular venta' });
  }
};
