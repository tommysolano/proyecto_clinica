const Sale = require('../models/Sale');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Discount = require('../models/Discount');
const Treatment = require('../models/Treatment');
const DeferredIncome = require('../models/DeferredIncome');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openReceivable, applyToReceivable, voidReceivable } = require('../utils/subledger');
const kardex = require('../utils/kardex');
const { calculateSaleLine, summarizeSaleTaxes } = require('../utils/tax');
const { emitToClinic } = require('../realtime');

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
      .populate('callCenter', 'name')
      .populate('doctor', 'name')
      .populate('nurse', 'name')
      .populate('recommendedBy', 'name')
      .populate('bankAccount', 'name bank')
      .populate('creditCard', 'name brand')
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
  // Idempotencia: clave provista por el cliente para evitar ventas duplicadas
  // por doble-submit / reintento de red. Declarada fuera del try para usarla en el catch.
  const idempotencyKey = (req.body.idempotencyKey || '').trim() || null;
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

    // Si el cliente reenvía la misma operación, devolvemos la venta ya creada.
    if (idempotencyKey) {
      const existingSale = await Sale.findOne({ clinic: req.clinicId, idempotencyKey })
        .populate('patient', 'firstName lastName cedula')
        .populate('createdBy', 'name');
      if (existingSale) return res.status(200).json(existingSale);
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

    {
      const txSaleId = await runInTransaction(async (session) => {
        const saleDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, saleDate, { session });

        const txProductIds = [...new Set(items.map((i) => String(i.product)))];
        const txProducts = await Product.find({
          _id: { $in: txProductIds },
          clinic: req.clinicId,
          active: true,
        }).session(session);
        if (txProducts.length !== txProductIds.length) {
          throw Object.assign(new Error('Algun producto no existe en esta clinica'), { status: 400 });
        }

        const txProductMap = new Map(txProducts.map((p) => [String(p._id), p]));
        const txIsUnlimited = (p) => p.unlimited === true || p.category === 'servicio';

        for (const item of items) {
          const product = txProductMap.get(String(item.product));
          const qty = Number(item.quantity);
          if (!qty || qty <= 0) {
            throw Object.assign(new Error(`Cantidad invalida para ${product.name}`), { status: 400 });
          }
          if (!txIsUnlimited(product) && Number(product.stock || 0) < qty) {
            throw Object.assign(new Error(`Stock insuficiente para "${product.name}". Disponible: ${product.stock}`), { status: 400 });
          }
        }

        for (const item of items) {
          const product = txProductMap.get(String(item.product));
          const qty = Number(item.quantity);
          if (txIsUnlimited(product)) continue;
          const updated = await Product.findOneAndUpdate(
            { _id: product._id, clinic: req.clinicId, stock: { $gte: qty } },
            { $inc: { stock: -qty } },
            { new: true, session }
          );
          if (!updated) {
            throw Object.assign(new Error(`Stock insuficiente para "${product.name}" (cambio durante la operacion)`), { status: 400 });
          }
          product.stock = updated.stock;
        }

        const txSaleItems = items.map((item) => {
          const product = txProductMap.get(String(item.product));
          const tax = calculateSaleLine({
            product,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discount: item.discount || 0,
            priceIncludesVat: item.priceIncludesVat,
          });
          return {
            product: product._id,
            productCode: product.code,
            productName: product.name,
            category: product.category,
            quantity: tax.quantity,
            unitPrice: tax.unitPrice,
            unitPriceExcludingTax: tax.unitPriceExcludingTax,
            grossAmount: tax.grossAmount,
            taxBase: tax.taxBase,
            taxAmount: tax.taxAmount,
            lineTotal: tax.lineTotal,
            taxRate: tax.taxRate,
            taxCodeSri: tax.taxCodeSri,
            taxCategory: tax.taxCategory,
            priceIncludesVat: tax.priceIncludesVat,
            discount: tax.discount,
            discountTaxBase: tax.discountTaxBase,
            discountRef: item.discountRef || undefined,
            treatment: item.treatment || undefined,
            subtotal: tax.taxBase,
          };
        });
        const txTotals = summarizeSaleTaxes(txSaleItems);

        let txIsFirstVisit = false;
        if (patient) {
          const previousCount = await Sale.countDocuments({
            clinic: req.clinicId,
            patient,
            status: 'completada',
          }).session(session);
          if (previousCount === 0) txIsFirstVisit = txProducts.some((p) => !p.excludeFromFirstVisit);
        }

        const [txSale] = await Sale.create([{
          clinic: req.clinicId,
          items: txSaleItems,
          patient: patient || undefined,
          clientName,
          clientCedula,
          clientEmail,
          clientPhone,
          clientAddress,
          subtotal: txTotals.visibleSubtotal,
          taxableSubtotal: txTotals.taxableSubtotal,
          subtotal0: txTotals.subtotal0,
          subtotalExento: txTotals.subtotalExento,
          subtotalNoObjeto: txTotals.subtotalNoObjeto,
          discountTotal: txTotals.discountTotal,
          discountTaxBase: txTotals.discountTaxBase,
          taxAmount: txTotals.taxAmount,
          total: txTotals.total,
          paymentMethod,
          dueDate: paymentMethod === 'credito' ? (req.body.dueDate ? new Date(req.body.dueDate) : null) : null,
          balance: paymentMethod === 'credito' ? txTotals.total : 0,
          paid: paymentMethod !== 'credito',
          notes,
          isFirstVisit: txIsFirstVisit,
          clientCity,
          clientZone,
          callCenter: req.body.callCenter || undefined,
          cashier: req.body.cashier || (req.role === 'cajero' ? req.user._id : undefined),
          doctor: req.body.doctor || undefined,
          nurse: req.body.nurse || undefined,
          recommendedBy: req.body.recommendedBy || undefined,
          bankAccount: paymentMethod === 'transferencia' ? (req.body.bankAccount || undefined) : undefined,
          creditCard: paymentMethod === 'tarjeta' ? (req.body.creditCard || undefined) : undefined,
          cardPos: paymentMethod === 'tarjeta' ? (req.body.cardPos || '') : '',
          cardLote: paymentMethod === 'tarjeta' ? (req.body.cardLote || '').trim() : '',
          cardVoucher: paymentMethod === 'tarjeta' ? (req.body.cardVoucher || '').trim() : '',
          appointment: req.body.appointment || undefined,
          idempotencyKey,
          createdAt: saleDate,
          createdBy: req.user._id,
        }], { session });

        for (const it of txSaleItems) {
          if (!it.treatment) continue;
          try {
            const treatment = await Treatment.findOne({ _id: it.treatment, clinic: req.clinicId }).session(session);
            if (!treatment) continue;
            const idx = treatment.items.findIndex((x) => String(x.product) === String(it.product));
            if (idx >= 0) {
              treatment.items[idx].completed = Math.min((treatment.items[idx].completed || 0) + it.quantity, treatment.items[idx].quantity);
              treatment.items[idx].completionRefs.push({ type: 'sale', ref: txSale._id, date: saleDate });
              if (treatment.progress >= 100) treatment.status = 'completado';
              await treatment.save({ session });
            }
          } catch (e) {
            console.warn('No se pudo actualizar tratamiento', it.treatment, e.message);
          }
        }

        for (const it of txSaleItems) {
          const prod = txProductMap.get(String(it.product));
          if (prod && txIsUnlimited(prod)) continue;
          // Kardex: consume capas FIFO -> costo de venta exacto. allowNegative cubre
          // productos con stock previo al kardex (sin capas): el faltante se valora
          // al costo promedio como respaldo.
          const issue = await kardex.issueStock({
            clinicId: req.clinicId,
            product: it.product,
            warehouse: it.warehouse || null,
            quantity: it.quantity,
            lot: it.lot || null,
            allowNegative: true,
          }, session);
          let itemCost = issue.totalCost;
          if (issue.shortfall > 0.00001) {
            itemCost = +(itemCost + issue.shortfall * Number(prod.averageCost || prod.purchasePrice || 0)).toFixed(2);
          }
          it._cogs = itemCost;
          const cur = await kardex.currentStock({ clinicId: req.clinicId, product: it.product }, session);
          await Product.updateOne(
            { _id: it.product, clinic: req.clinicId },
            { $set: { averageCost: cur.averageCost } },
            { session }
          );
          await InventoryMovement.create([{
            clinic: req.clinicId,
            product: it.product,
            type: 'salida',
            quantity: it.quantity,
            unitCost: it.quantity > 0 ? +(itemCost / it.quantity).toFixed(4) : 0,
            totalCost: itemCost,
            balanceAfter: cur.qty,
            lot: it.lot || '',
            layerConsumption: issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost })),
            reason: 'Venta',
            reference: txSale.saleNumber,
            sourceModel: 'Sale',
            sourceRef: txSale._id,
            createdBy: req.user._id,
          }], { session });
        }

        const txLines = [];
        let txDebitAcc = null;
        if (paymentMethod === 'transferencia' && txSale.bankAccount) {
          const BankAccount = require('../models/BankAccount');
          const ChartOfAccount = require('../models/ChartOfAccount');
          const bank = await BankAccount.findOne({ _id: txSale.bankAccount, clinic: req.clinicId }).session(session);
          if (bank?.chartAccount) txDebitAcc = await ChartOfAccount.findById(bank.chartAccount).session(session);
        } else if (paymentMethod === 'tarjeta' && txSale.creditCard) {
          const CreditCard = require('../models/CreditCard');
          const ChartOfAccount = require('../models/ChartOfAccount');
          const card = await CreditCard.findOne({ _id: txSale.creditCard, clinic: req.clinicId }).session(session);
          if (card?.chartAccount) txDebitAcc = await ChartOfAccount.findById(card.chartAccount).session(session);
        }
        if (!txDebitAcc) {
          let debitRole = 'clientes';
          if (paymentMethod === 'efectivo') debitRole = 'caja';
          else if (paymentMethod === 'tarjeta') debitRole = 'tarjetasPorLiquidar';
          else if (paymentMethod === 'transferencia') debitRole = 'bancos';
          txDebitAcc = await getAccount(req.clinicId, debitRole);
        }
        txLines.push({ account: txDebitAcc._id, debit: txTotals.total, credit: 0, description: `Venta ${txSale.saleNumber}` });

        // Ingreso diferido (paquetes): la base de los ítems marcados como
        // deferredIncome NO se reconoce ahora; se acredita a "Ingresos diferidos".
        const isDeferred = (i) => txProductMap.get(String(i.product))?.deferredIncome === true;
        const productBase = +txSaleItems
          .filter((i) => i.category !== 'servicio' && !isDeferred(i))
          .reduce((s, i) => s + i.taxBase + (i.discountTaxBase || 0), 0)
          .toFixed(2);
        const serviceBase = +txSaleItems
          .filter((i) => i.category === 'servicio' && !isDeferred(i))
          .reduce((s, i) => s + i.taxBase + (i.discountTaxBase || 0), 0)
          .toFixed(2);
        const deferredBase = +txSaleItems
          .filter(isDeferred)
          .reduce((s, i) => s + i.taxBase + (i.discountTaxBase || 0), 0)
          .toFixed(2);
        if (productBase > 0) {
          const accProd = await getAccount(req.clinicId, 'ingresoProductos');
          txLines.push({ account: accProd._id, debit: 0, credit: productBase, description: 'Ingreso productos' });
        }
        if (serviceBase > 0) {
          const accServ = await getAccount(req.clinicId, 'ingresoServicios');
          txLines.push({ account: accServ._id, debit: 0, credit: serviceBase, description: 'Ingreso servicios' });
        }
        let accDeferred = null;
        let accDeferredIncomeTarget = null;
        if (deferredBase > 0) {
          accDeferred = await getAccount(req.clinicId, 'ingresoDiferido');
          accDeferredIncomeTarget = await getAccount(req.clinicId, 'ingresoServicios');
          txLines.push({ account: accDeferred._id, debit: 0, credit: deferredBase, description: 'Ingreso diferido (paquete)' });
        }
        if (txTotals.taxAmount > 0) {
          const ivaV = await getAccount(req.clinicId, 'ivaVentas');
          txLines.push({ account: ivaV._id, debit: 0, credit: txTotals.taxAmount, description: 'IVA en ventas' });
        }
        if (txTotals.discountTaxBase > 0) {
          const desc = await getAccount(req.clinicId, 'descuentoVentas');
          txLines.push({ account: desc._id, debit: txTotals.discountTaxBase, credit: 0, description: 'Descuento en venta' });
        }

        const costoDefault = await getAccount(req.clinicId, 'costoProductos');
        const inventarioDefault = await getAccount(req.clinicId, 'inventario');
        for (const it of txSaleItems) {
          const prod = txProductMap.get(String(it.product));
          if (!prod || txIsUnlimited(prod)) continue;
          const totalCost = +Number(it._cogs || 0).toFixed(2);
          if (totalCost <= 0) continue;
          txLines.push({ account: prod.expenseAccount || costoDefault._id, debit: totalCost, credit: 0, description: `Costo venta ${it.productName}` });
          txLines.push({ account: prod.inventoryAccount || inventarioDefault._id, debit: 0, credit: totalCost, description: `Salida inventario ${it.productName}` });
        }

        const txEntry = await createEntry({
          clinicId: req.clinicId,
          date: saleDate,
          description: `Venta ${txSale.saleNumber}`,
          source: 'VENTA',
          sourceRef: txSale._id,
          sourceModel: 'Sale',
          sourceAction: 'POST',
          lines: txLines,
          userId: req.user._id,
          doctor: txSale.doctor || null,
          costCenter: req.body.costCenter || null,
          session,
        });
        txSale.journalEntry = txEntry._id;
        await txSale.save({ session });

        // Ingreso diferido: registra un documento por cada ítem de paquete para
        // reconocer el ingreso por sesión más adelante.
        if (deferredBase > 0 && accDeferred) {
          for (const it of txSaleItems) {
            if (!isDeferred(it)) continue;
            const base = +(Number(it.taxBase || 0) + Number(it.discountTaxBase || 0)).toFixed(2);
            if (base <= 0) continue;
            const prod = txProductMap.get(String(it.product));
            await DeferredIncome.create([{
              clinic: req.clinicId,
              sourceModel: 'Sale',
              sourceRef: txSale._id,
              product: it.product,
              productName: it.productName,
              patient: txSale.patient || null,
              partyName: txSale.clientName || '',
              treatment: it.treatment || null,
              deferredAccount: accDeferred._id,
              incomeAccount: (prod && prod.incomeAccount) || accDeferredIncomeTarget._id,
              total: base,
              sessionsTotal: (prod && prod.sessionsIncluded) || 0,
              issueDate: saleDate,
              createdBy: req.user._id,
            }], { session });
          }
        }

        // Cartera (CxC): una venta a crédito abre un documento de cobro en el subledger.
        if (paymentMethod === 'credito') {
          await openReceivable({
            clinic: req.clinicId,
            party: { model: 'Patient', ref: txSale.patient || null, name: txSale.clientName || '' },
            sourceModel: 'Sale',
            sourceRef: txSale._id,
            docType: 'VENTA',
            number: txSale.saleNumber,
            issueDate: saleDate,
            dueDate: txSale.dueDate || null,
            total: txTotals.total,
            account: txDebitAcc._id,
          }, { session });
        }
        return txSale._id;
      });

      const txPopulated = await Sale.findById(txSaleId)
        .populate('patient', 'firstName lastName cedula')
        .populate('createdBy', 'name');
      emitToClinic(req.clinicId, 'sale:created', { id: txSaleId });
      // Evento de dominio para el motor de workflows (trigger sale_created).
      if (txPopulated.patient?._id) {
        const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
        emitDomainEvent(DOMAIN_EVENTS.SALE_CREATED, {
          clinicId: String(req.clinicId),
          patientId: String(txPopulated.patient._id),
          saleId: String(txSaleId),
        });
      }
      return res.status(201).json(txPopulated);
    }
  } catch (error) {
    // Carrera de idempotencia: otra petición con la misma clave ganó. Devolvemos esa venta.
    if (error.code === 11000 && idempotencyKey) {
      const existingSale = await Sale.findOne({ clinic: req.clinicId, idempotencyKey })
        .populate('patient', 'firstName lastName cedula')
        .populate('createdBy', 'name');
      if (existingSale) return res.status(200).json(existingSale);
    }
    res.status(error.status || 500).json({ message: 'Error al crear venta', error: error.message });
  }
};

/**
 * Anula una venta. Si tenía factura emitida, debe anularse antes la factura
 * (proceso aparte por el SRI). Esta acción solo cubre la venta interna.
 */
exports.cancelSale = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const sale = await Sale.findOne({ _id: req.params.id, clinic: req.clinicId })
          .populate('invoice')
          .session(session);
        if (!sale) throw Object.assign(new Error('Venta no encontrada'), { status: 404 });
        if (sale.status === 'anulada') throw Object.assign(new Error('La venta ya esta anulada'), { status: 400 });
        if (sale.invoice && sale.invoice.estado === 'AUTORIZADO') {
          throw Object.assign(
            new Error('No se puede anular: tiene factura autorizada por el SRI. Anule primero la factura electronica.'),
            { status: 400 }
          );
        }

        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });

        // Kardex: devuelve a sus capas originales lo consumido por las salidas de esta venta.
        const salidas = await InventoryMovement.find({
          clinic: req.clinicId,
          sourceModel: 'Sale',
          sourceRef: sale._id,
          type: 'salida',
        }).session(session);
        for (const mov of salidas) {
          await kardex.reverseIssue({ consumption: (mov.layerConsumption || []).map((c) => ({ layerId: c.layer, qty: c.qty })) }, session);
        }

        for (const item of sale.items) {
          if (item.category === 'servicio') continue;
          const prod = await Product.findOne({ _id: item.product, clinic: req.clinicId })
            .select('unlimited category stock averageCost purchasePrice')
            .session(session);
          if (prod && (prod.unlimited || prod.category === 'servicio')) continue;
          await Product.updateOne(
            { _id: item.product, clinic: req.clinicId },
            { $inc: { stock: item.quantity } },
            { session }
          );
          const cur = await kardex.currentStock({ clinicId: req.clinicId, product: item.product }, session);
          await Product.updateOne(
            { _id: item.product, clinic: req.clinicId },
            { $set: { averageCost: cur.averageCost } },
            { session }
          );
          const unitCost = Number(prod?.averageCost || prod?.purchasePrice || 0);
          await InventoryMovement.create([{
            clinic: req.clinicId,
            product: item.product,
            type: 'entrada',
            quantity: item.quantity,
            unitCost,
            totalCost: +(Number(item.quantity || 0) * unitCost).toFixed(2),
            reason: 'Anulacion de venta',
            reference: sale.saleNumber,
            sourceModel: 'Sale',
            sourceRef: sale._id,
            createdBy: req.user._id,
          }], { session });
        }

        // Revertir cobros previos (venta a crédito): reversa cada asiento de COBRO y
        // anula su movimiento bancario para que Clientes y caja/banco queden cuadrados.
        const JournalEntry = require('../models/JournalEntry');
        const BankTransaction = require('../models/BankTransaction');
        const cobros = await JournalEntry.find({
          clinic: req.clinicId,
          sourceModel: 'Sale',
          sourceRef: sale._id,
          source: 'COBRO',
          status: 'CONTABILIZADO',
          isReversed: false,
        }).session(session);
        for (const cobro of cobros) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: cobro._id,
            userId: req.user._id,
            reason: `Anulacion venta ${sale.saleNumber}`,
            date: reversalDate,
            session,
          });
        }
        await BankTransaction.updateMany(
          { clinic: req.clinicId, sourceModel: 'Sale', sourceRef: sale._id, voided: false },
          { $set: { voided: true, voidedAt: reversalDate, voidedBy: req.user._id } },
          { session }
        );

        // Revertir el progreso de tratamiento que esta venta marcó como cumplido.
        for (const item of sale.items) {
          if (!item.treatment) continue;
          const treatment = await Treatment.findOne({ _id: item.treatment, clinic: req.clinicId }).session(session);
          if (!treatment) continue;
          const idx = treatment.items.findIndex((x) => String(x.product) === String(item.product));
          if (idx < 0) continue;
          const before = treatment.items[idx].completionRefs.length;
          treatment.items[idx].completionRefs = treatment.items[idx].completionRefs.filter(
            (r) => !(r.type === 'sale' && String(r.ref) === String(sale._id))
          );
          if (treatment.items[idx].completionRefs.length !== before) {
            treatment.items[idx].completed = Math.max(0, (treatment.items[idx].completed || 0) - item.quantity);
          }
          if (treatment.status === 'completado') treatment.status = 'activo';
          await treatment.save({ session });
        }

        if (sale.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: sale.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion venta',
            date: reversalDate,
            session,
          });
        }
        // Ingreso diferido: reversa los asientos de reconocimiento ya emitidos y
        // anula los documentos. El reverso del asiento principal deshace la
        // acreditación original a "Ingresos diferidos".
        const deferreds = await DeferredIncome.find({
          clinic: req.clinicId, sourceModel: 'Sale', sourceRef: sale._id, status: { $ne: 'ANULADO' },
        }).session(session);
        for (const di of deferreds) {
          const recEntries = await JournalEntry.find({
            clinic: req.clinicId, sourceModel: 'DeferredIncome', sourceRef: di._id,
            status: 'CONTABILIZADO', isReversed: false,
          }).session(session);
          for (const re of recEntries) {
            await reverseEntry({
              clinicId: req.clinicId, entryId: re._id, userId: req.user._id,
              reason: `Anulacion venta ${sale.saleNumber}`, date: reversalDate, session,
            });
          }
          di.status = 'ANULADO';
          await di.save({ session });
        }

        // Cartera: anula el documento de cobro (CxC) si la venta era a crédito.
        await voidReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: sale._id }, { session });

        sale.status = 'anulada';
        sale.balance = 0;
        await sale.save({ session });
        return { message: 'Venta anulada exitosamente' };
      });
      return res.json(result);
    }
  } catch (error) {
    res.status(error.status || 500).json({ message: 'Error al anular venta', error: error.message });
  }
};

/**
 * Registra el cobro (total o parcial) de una venta a crédito (CxC):
 * Débito caja/banco, crédito Clientes; reduce el saldo de la venta.
 * Body: { amount, paymentMethod: 'efectivo'|'transferencia', bankAccount?, date? }
 */
exports.collectSale = async (req, res) => {
  try {
    const BankAccount = require('../models/BankAccount');
    const BankTransaction = require('../models/BankTransaction');
    {
      const result = await runInTransaction(async (session) => {
        const sale = await Sale.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!sale) throw Object.assign(new Error('Venta no encontrada'), { status: 404 });
        if (sale.status !== 'completada') throw Object.assign(new Error('La venta no esta activa'), { status: 400 });
        if (sale.paymentMethod !== 'credito') throw Object.assign(new Error('La venta no es a credito'), { status: 400 });

        const amount = +(Number(req.body.amount) || 0).toFixed(2);
        if (amount <= 0) throw Object.assign(new Error('Monto invalido'), { status: 400 });
        if (amount > Number(sale.balance || 0) + 0.01) {
          throw Object.assign(new Error(`El monto excede el saldo (${Number(sale.balance || 0).toFixed(2)})`), { status: 400 });
        }

        const method = req.body.paymentMethod || 'efectivo';
        const date = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, date, { session });

        const clientes = await getAccount(req.clinicId, 'clientes');
        let debitAcc;
        let bank = null;
        if (method === 'transferencia' && req.body.bankAccount) {
          bank = await BankAccount.findOne({ _id: req.body.bankAccount, clinic: req.clinicId }).session(session);
          if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
          const ChartOfAccount = require('../models/ChartOfAccount');
          debitAcc = await ChartOfAccount.findById(bank.chartAccount).session(session);
        } else {
          debitAcc = await getAccount(req.clinicId, 'caja');
        }

        const sourceAction = req.body.idempotencyKey
          ? `COLLECT:${req.body.idempotencyKey}`
          : `COLLECT:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const entry = await createEntry({
          clinicId: req.clinicId,
          date,
          description: `Cobro venta ${sale.saleNumber}`,
          source: 'COBRO',
          sourceRef: sale._id,
          sourceModel: 'Sale',
          sourceAction,
          lines: [
            { account: debitAcc._id, debit: amount, credit: 0, description: `Cobro ${sale.saleNumber}` },
            { account: clientes._id, debit: 0, credit: amount, description: `Cobro ${sale.saleNumber}` },
          ],
          userId: req.user._id,
          session,
        });

        if (bank) {
          await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date,
            type: 'COBRO',
            amount,
            direction: 1,
            description: `Cobro venta ${sale.saleNumber}`,
            reference: sale.saleNumber,
            journalEntry: entry._id,
            sourceModel: 'Sale',
            sourceRef: sale._id,
            createdBy: req.user._id,
          }], { session });
        }

        // Cartera (CxC): asegura el documento de cobro y aplica el abono. Idempotente:
        // si la venta es anterior al subledger, lo abre reconstruyendo el saldo previo.
        await openReceivable({
          clinic: req.clinicId,
          party: { model: 'Patient', ref: sale.patient || null, name: sale.clientName || '' },
          sourceModel: 'Sale',
          sourceRef: sale._id,
          docType: 'VENTA',
          number: sale.saleNumber,
          issueDate: sale.createdAt || date,
          dueDate: sale.dueDate || null,
          total: sale.total,
          applied: +(Number(sale.total || 0) - Number(sale.balance || 0)).toFixed(2),
          account: clientes._id,
        }, { session });
        await applyToReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: sale._id, amount }, { session });

        sale.balance = +(Number(sale.balance || 0) - amount).toFixed(2);
        sale.paid = sale.balance <= 0.01;
        if (sale.paid) sale.balance = 0;
        await sale.save({ session });
        return { ok: true, balance: sale.balance, paid: sale.paid };
      });
      return res.json(result);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
