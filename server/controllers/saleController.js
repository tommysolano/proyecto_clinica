const Sale = require('../models/Sale');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');

exports.getSales = async (req, res) => {
  try {
    const { startDate, endDate, status, patient, page = 1, limit = 20 } = req.query;
    const query = { clinic: req.clinicId };

    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (status) query.status = status;
    if (patient) query.patient = patient;

    const sales = await Sale.find(query)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name')
      .populate('invoice', 'estado claveAcceso secuencial estab ptoEmi')
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
    res.status(500).json({ message: 'Error al obtener ventas', error: error.message });
  }
};

exports.getSale = async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', 'firstName lastName cedula address phone email')
      .populate('items.product', 'name code')
      .populate('createdBy', 'name')
      .populate('invoice');

    if (!sale) return res.status(404).json({ message: 'Venta no encontrada' });
    res.json(sale);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta' });
  }
};

/**
 * Crea una venta. Valida stock por ítem (no permite si stock insuficiente para
 * productos no-servicio) y descuenta de forma atómica usando $inc condicional.
 */
exports.createSale = async (req, res) => {
  try {
    const {
      items,
      patient,
      clientName,
      clientCedula,
      clientEmail,
      clientPhone,
      clientAddress,
      paymentMethod,
      notes,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Debe agregar al menos un ítem' });
    }

    // Validar y consolidar productos
    const productIds = items.map((i) => i.product);
    const products = await Product.find({
      _id: { $in: productIds },
      clinic: req.clinicId,
      active: true,
    });

    if (products.length !== productIds.length) {
      return res.status(400).json({ message: 'Algún producto no existe en esta clínica' });
    }

    // Pre-validar stock antes de descontar
    for (const item of items) {
      const product = products.find((p) => String(p._id) === String(item.product));
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) {
        return res.status(400).json({ message: `Cantidad inválida para ${product.name}` });
      }
      if (product.category !== 'servicio' && product.stock < qty) {
        return res.status(400).json({
          message: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}`,
        });
      }
    }

    // Descontar stock atómicamente. Si falla alguno, hacemos rollback.
    const decremented = [];
    try {
      for (const item of items) {
        const product = products.find((p) => String(p._id) === String(item.product));
        const qty = Number(item.quantity);
        if (product.category === 'servicio') continue;

        const updated = await Product.findOneAndUpdate(
          {
            _id: product._id,
            clinic: req.clinicId,
            stock: { $gte: qty },
          },
          { $inc: { stock: -qty } },
          { new: true }
        );
        if (!updated) {
          throw new Error(`Stock insuficiente para "${product.name}" (cambió durante la operación)`);
        }
        decremented.push({ productId: product._id, qty });
      }
    } catch (err) {
      // rollback
      for (const d of decremented) {
        await Product.updateOne({ _id: d.productId }, { $inc: { stock: d.qty } });
      }
      return res.status(400).json({ message: err.message });
    }

    // Construir items y totales (precio de venta interpretado como SIN IVA)
    let subtotal = 0;
    let taxAmount = 0;
    const saleItems = items.map((item) => {
      const product = products.find((p) => String(p._id) === String(item.product));
      const qty = Number(item.quantity);
      const unitPrice = Number(item.unitPrice ?? product.salePrice);
      const itemSubtotal = +(unitPrice * qty).toFixed(2);
      const itemTax = +(itemSubtotal * (product.taxRate / 100)).toFixed(2);
      subtotal += itemSubtotal;
      taxAmount += itemTax;
      return {
        product: product._id,
        productCode: product.code,
        productName: product.name,
        category: product.category,
        quantity: qty,
        unitPrice,
        taxRate: product.taxRate,
        subtotal: itemSubtotal,
      };
    });
    subtotal = +subtotal.toFixed(2);
    taxAmount = +taxAmount.toFixed(2);
    const total = +(subtotal + taxAmount).toFixed(2);

    const sale = await Sale.create({
      clinic: req.clinicId,
      items: saleItems,
      patient: patient || undefined,
      clientName,
      clientCedula,
      clientEmail,
      clientPhone,
      clientAddress,
      subtotal,
      taxAmount,
      total,
      paymentMethod,
      notes,
      createdBy: req.user._id,
    });

    // Registrar movimientos de inventario
    for (const it of saleItems) {
      if (it.category === 'servicio') continue;
      await InventoryMovement.create({
        clinic: req.clinicId,
        product: it.product,
        type: 'salida',
        quantity: it.quantity,
        reason: 'Venta',
        reference: sale.saleNumber,
        createdBy: req.user._id,
      });
    }

    const populated = await sale
      .populate('patient', 'firstName lastName cedula')
      .then((doc) => doc.populate('createdBy', 'name'));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear venta', error: error.message });
  }
};

/**
 * Anula una venta. Si tenía factura emitida, debe anularse antes la factura
 * (proceso aparte por el SRI). Esta acción solo cubre la venta interna.
 */
exports.cancelSale = async (req, res) => {
  try {
    const sale = await Sale.findOne({ _id: req.params.id, clinic: req.clinicId }).populate(
      'invoice'
    );
    if (!sale) return res.status(404).json({ message: 'Venta no encontrada' });

    if (sale.status === 'anulada') {
      return res.status(400).json({ message: 'La venta ya está anulada' });
    }

    if (sale.invoice && sale.invoice.estado === 'AUTORIZADO') {
      return res.status(400).json({
        message:
          'No se puede anular: tiene factura autorizada por el SRI. Anule primero la factura electrónica.',
      });
    }

    // Restaurar stock
    for (const item of sale.items) {
      if (item.category === 'servicio') continue;
      await Product.updateOne(
        { _id: item.product, clinic: req.clinicId },
        { $inc: { stock: item.quantity } }
      );
      await InventoryMovement.create({
        clinic: req.clinicId,
        product: item.product,
        type: 'entrada',
        quantity: item.quantity,
        reason: 'Anulación de venta',
        reference: sale.saleNumber,
        createdBy: req.user._id,
      });
    }

    sale.status = 'anulada';
    await sale.save();

    res.json({ message: 'Venta anulada exitosamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular venta', error: error.message });
  }
};
