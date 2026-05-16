const Sale = require('../models/Sale');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Discount = require('../models/Discount');
const Treatment = require('../models/Treatment');
const { createEntry, findAccount, reverseEntry } = require('../utils/accounting');

exports.getSales = async (req, res) => {
  try {
    const { startDate, endDate, status, patient, product, page = 1, limit = 20 } = req.query;
    const query = { clinic: req.clinicId };

    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (status) query.status = status;
    if (patient) query.patient = patient;
    // Filtro por producto/servicio: solo trae ventas que contengan ese producto.
    if (product) query['items.product'] = product;

    const sales = await Sale.find(query)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name email')
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

    // Validar dirección/zona si la ciudad es Guayaquil:
    // En Guayaquil exigimos seleccionar una zona reconocida por la alcaldía.
    const clientCity = (req.body.clientCity || 'Guayaquil').trim();
    let clientZone = (req.body.clientZone || '').trim();
    if (clientCity.toLowerCase() === 'guayaquil' && clientZone) {
      const { isValidGuayaquilZone } = require('../utils/guayaquilZones');
      if (!isValidGuayaquilZone(clientZone)) {
        return res.status(400).json({
          message:
            'La zona de Guayaquil seleccionada no es válida. Debes elegirla del listado oficial.',
        });
      }
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

    const isUnlimited = (p) => p.unlimited === true || p.category === 'servicio';

    // Pre-validar stock antes de descontar
    for (const item of items) {
      const product = products.find((p) => String(p._id) === String(item.product));
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) {
        return res.status(400).json({ message: `Cantidad inválida para ${product.name}` });
      }
      if (!isUnlimited(product) && product.stock < qty) {
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
        if (isUnlimited(product)) continue;

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
    // Aplicar descuentos por ítem (compatibles con SRI: descuento sobre base imponible).
    let subtotal = 0;
    let discountTotal = 0;
    let taxAmount = 0;
    const saleItems = items.map((item) => {
      const product = products.find((p) => String(p._id) === String(item.product));
      const qty = Number(item.quantity);
      const unitPrice = Number(item.unitPrice ?? product.salePrice);
      const itemBase = +(unitPrice * qty).toFixed(2);
      const itemDiscount = +Number(item.discount || 0).toFixed(2);
      const itemSubtotal = +(itemBase - itemDiscount).toFixed(2);
      const itemTax = +(itemSubtotal * (product.taxRate / 100)).toFixed(2);
      subtotal += itemBase;
      discountTotal += itemDiscount;
      taxAmount += itemTax;
      return {
        product: product._id,
        productCode: product.code,
        productName: product.name,
        category: product.category,
        quantity: qty,
        unitPrice,
        taxRate: product.taxRate,
        discount: itemDiscount,
        discountRef: item.discountRef || undefined,
        treatment: item.treatment || undefined,
        subtotal: itemSubtotal,
      };
    });
    subtotal = +subtotal.toFixed(2);
    discountTotal = +discountTotal.toFixed(2);
    taxAmount = +taxAmount.toFixed(2);
    const total = +(subtotal - discountTotal + taxAmount).toFixed(2);

    // ¿Es primera venta del paciente? (paciente nuevo)
    // No se considera "nuevo" si TODOS los productos de la venta tienen el flag
    // excludeFromFirstVisit (servicios recurrentes que no deben marcar nuevo).
    let isFirstVisit = false;
    if (patient) {
      const previousCount = await Sale.countDocuments({
        clinic: req.clinicId,
        patient,
        status: 'completada',
      });
      if (previousCount === 0) {
        const someCounts = products.some((p) => !p.excludeFromFirstVisit);
        isFirstVisit = someCounts;
      }
    }

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
      discountTotal,
      taxAmount,
      total,
      paymentMethod,
      notes,
      isFirstVisit,
      clientCity,
      clientZone,
      callCenter: req.body.callCenter || undefined,
      cashier: req.body.cashier || (req.role === 'cajero' ? req.user._id : undefined),
      doctor: req.body.doctor || undefined,
      nurse: req.body.nurse || undefined,
      appointment: req.body.appointment || undefined,
      createdBy: req.user._id,
    });

    // Avance automático de tratamientos: si un ítem está vinculado a un
    // tratamiento del paciente, suma `quantity` cumplimientos.
    for (const it of saleItems) {
      if (!it.treatment) continue;
      try {
        const t = await Treatment.findOne({
          _id: it.treatment,
          clinic: req.clinicId,
        });
        if (!t) continue;
        const idx = t.items.findIndex(
          (x) => String(x.product) === String(it.product)
        );
        if (idx >= 0) {
          t.items[idx].completed = Math.min(
            (t.items[idx].completed || 0) + it.quantity,
            t.items[idx].quantity
          );
          t.items[idx].completionRefs.push({
            type: 'sale',
            ref: sale._id,
            date: new Date(),
          });
          if (t.progress >= 100) t.status = 'completado';
          await t.save();
        }
      } catch (e) {
        console.warn('No se pudo actualizar tratamiento', it.treatment, e.message);
      }
    }

    // Registrar movimientos de inventario (omitir productos ilimitados/servicios)
    for (const it of saleItems) {
      const prod = products.find((p) => String(p._id) === String(it.product));
      if (prod && (prod.unlimited === true || prod.category === 'servicio')) continue;
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

    // Asiento contable automático de la venta (best-effort: si falla no rompe la venta)
    try {
      const lines = [];
      // Débito: cobro (caja/banco/tarjeta) o cuentas por cobrar
      let debitCode = '1.1.02.01';
      if (paymentMethod === 'efectivo') debitCode = '1.1.01.01';
      else if (paymentMethod === 'tarjeta') debitCode = '1.1.02.02';
      else if (paymentMethod === 'transferencia') debitCode = '1.1.01.03';
      const debitAcc = await findAccount(req.clinicId, { code: debitCode });
      lines.push({ account: debitAcc._id, debit: total, credit: 0, description: `Venta ${sale.saleNumber}` });

      // Crédito: ingresos por producto/servicio
      const productosVendidos = saleItems.filter((i) => i.category !== 'servicio');
      const servicios = saleItems.filter((i) => i.category === 'servicio');
      const baseProd = productosVendidos.reduce((s, i) => s + i.subtotal, 0);
      const baseServ = servicios.reduce((s, i) => s + i.subtotal, 0);
      if (baseProd > 0) {
        const accProd = await findAccount(req.clinicId, { code: '4.1.02' });
        lines.push({ account: accProd._id, debit: 0, credit: baseProd, description: 'Ingreso productos' });
      }
      if (baseServ > 0) {
        const accServ = await findAccount(req.clinicId, { code: '4.1.01' });
        lines.push({ account: accServ._id, debit: 0, credit: baseServ, description: 'Ingreso servicios' });
      }
      if (taxAmount > 0) {
        const ivaV = await findAccount(req.clinicId, { taxCode: 'IVA_VENTAS' });
        lines.push({ account: ivaV._id, debit: 0, credit: taxAmount, description: 'IVA en ventas' });
      }
      if (discountTotal > 0) {
        const desc = await findAccount(req.clinicId, { code: '4.1.03' });
        // El descuento es contra-ingreso: débito
        lines.push({ account: desc._id, debit: discountTotal, credit: 0, description: 'Descuento en venta' });
        // Ajustar el débito principal: caja recibió total real ya descontado.
        // Para cuadrar, el bruto fue subtotal + iva; el descuento se aplica al ingreso.
        // Sumamos descuento al ingreso bruto en crédito:
        const accProd2 = lines.find((l) => l.description === 'Ingreso productos');
        const accServ2 = lines.find((l) => l.description === 'Ingreso servicios');
        if (accProd2) accProd2.credit += discountTotal; // simplificación
        else if (accServ2) accServ2.credit += discountTotal;
      }
      const entry = await createEntry({
        clinicId: req.clinicId, date: new Date(),
        description: `Venta ${sale.saleNumber}`,
        source: 'VENTA', sourceRef: sale._id, sourceModel: 'Sale',
        lines, userId: req.user._id,
      });
      sale.journalEntry = entry._id;
      await sale.save();
    } catch (accErr) {
      console.warn('No se pudo generar asiento contable de venta:', accErr.message);
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

    // Restaurar stock (saltar productos ilimitados / servicios)
    for (const item of sale.items) {
      if (item.category === 'servicio') continue;
      const prod = await Product.findOne({ _id: item.product, clinic: req.clinicId }).select(
        'unlimited category'
      );
      if (prod && prod.unlimited) continue;
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

    // Reversar asiento contable si existe
    if (sale.journalEntry) {
      try {
        await reverseEntry({ clinicId: req.clinicId, entryId: sale.journalEntry, userId: req.user._id, reason: 'Anulación venta' });
      } catch (e) { console.warn('No se pudo reversar asiento:', e.message); }
    }

    res.json({ message: 'Venta anulada exitosamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular venta', error: error.message });
  }
};
