const EmployeeDeduction = require('../models/EmployeeDeduction');
const Employee = require('../models/Employee');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const kardex = require('../utils/kardex');

// Cuenta contraparte por defecto del asiento de creación según el tipo.
const DEFAULT_COUNTERPART = {
  ANTICIPO: 'caja',        // anticipo de sueldo entregado en efectivo
  MULTA: 'otrosIngresos',  // sanción que ingresa a la empresa
  CONSUMO: 'otrosIngresos',
  UNIFORME: 'otrosIngresos',
  OTRO: 'otrosIngresos',
};

/* ============================ DEDUCCIONES ============================ */

exports.listDeductions = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.employee) filter.employee = req.query.employee;
    if (req.query.status) filter.status = req.query.status;
    const items = await EmployeeDeduction.find(filter)
      .populate('employee', 'code firstName lastName')
      .populate('counterpartAccount', 'code name')
      .sort({ createdAt: -1 })
      .limit(500);
    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createDeduction = async (req, res) => {
  try {
    const { employee, type = 'OTRO', amount, description, date, counterpartAccount } = req.body;
    const amt = +(Number(amount) || 0).toFixed(2);
    if (!employee) return res.status(400).json({ message: 'Empleado requerido' });
    if (amt <= 0) return res.status(400).json({ message: 'Monto inválido' });

    const result = await runInTransaction(async (session) => {
      const emp = await Employee.findOne({ _id: employee, clinic: req.clinicId }).session(session);
      if (!emp) throw Object.assign(new Error('Empleado no encontrado'), { status: 404 });
      const txDate = date ? new Date(date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });

      const cxc = await getAccount(req.clinicId, 'cxcEmpleados', { session });
      let counterpart = null;
      if (counterpartAccount) {
        counterpart = await ChartOfAccount.findOne({ _id: counterpartAccount, clinic: req.clinicId }).session(session);
      }
      if (!counterpart) {
        counterpart = await getAccount(req.clinicId, DEFAULT_COUNTERPART[type] || 'otrosIngresos', { session });
      }

      const [ded] = await EmployeeDeduction.create([{
        clinic: req.clinicId,
        employee: emp._id,
        type,
        date: txDate,
        amount: amt,
        description: description || '',
        counterpartAccount: counterpart._id,
        status: 'PENDIENTE',
        createdBy: req.user._id,
      }], { session });

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: txDate,
        description: `Deducción ${type} - ${emp.firstName} ${emp.lastName}`,
        source: 'AJUSTE',
        sourceModel: 'EmployeeDeduction',
        sourceRef: ded._id,
        sourceAction: 'REGISTER',
        lines: [
          { account: cxc._id, debit: amt, credit: 0, description: `CxC empleado ${emp.lastName}` },
          { account: counterpart._id, debit: 0, credit: amt, description: description || `Deducción ${type}` },
        ],
        userId: req.user._id,
        session,
      });
      ded.journalEntry = entry._id;
      await ded.save({ session });
      return ded._id;
    });

    const ded = await EmployeeDeduction.findById(result).populate('employee', 'code firstName lastName');
    res.status(201).json(ded);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.voidDeduction = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const ded = await EmployeeDeduction.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!ded) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (ded.status === 'ANULADO') throw Object.assign(new Error('Ya anulada'), { status: 400 });
      if (ded.status === 'APLICADO') throw Object.assign(new Error('No se puede anular: ya fue descontada en un rol'), { status: 400 });
      const date = req.body.date ? new Date(req.body.date) : new Date();
      if (ded.journalEntry) {
        await reverseEntry({ clinicId: req.clinicId, entryId: ded.journalEntry, userId: req.user._id, reason: 'Anulación de deducción', date, session });
      }
      ded.status = 'ANULADO';
      await ded.save({ session });
      return { message: 'Deducción anulada' };
    });
    res.json(result);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/* ========================= CONSUMO INTERNO ========================= */

/**
 * Registra el consumo interno de insumos/productos por parte de la clínica
 * (no es una venta): da salida del inventario (FIFO) y carga el costo a la
 * cuenta de gasto "Consumo interno". Body:
 *   { items: [{ product, quantity }], account?, date?, notes? }
 */
exports.internalConsumption = async (req, res) => {
  try {
    const { items = [], account, date, notes } = req.body;
    const clean = (items || []).filter((i) => i.product && Number(i.quantity) > 0);
    if (!clean.length) return res.status(400).json({ message: 'Agrega al menos un producto con cantidad' });

    const result = await runInTransaction(async (session) => {
      const txDate = date ? new Date(date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });

      const gastoDefault = account
        ? await ChartOfAccount.findOne({ _id: account, clinic: req.clinicId }).session(session)
        : await getAccount(req.clinicId, 'consumoInterno', { session });
      const inventarioDefault = await getAccount(req.clinicId, 'inventario', { session });

      const lines = [];
      let total = 0;
      const movements = [];

      for (const it of clean) {
        const prod = await Product.findOne({ _id: it.product, clinic: req.clinicId }).populate('inventoryCategory', 'assetAccount').session(session);
        if (!prod) throw Object.assign(new Error('Producto no encontrado'), { status: 400 });
        if (prod.unlimited || prod.category === 'servicio') {
          throw Object.assign(new Error(`"${prod.name}" es un servicio/ilimitado y no se puede consumir como insumo`), { status: 400 });
        }
        const qty = Number(it.quantity);
        const issue = await kardex.issueStock({
          clinicId: req.clinicId, product: it.product, quantity: qty, allowNegative: true,
        }, session);
        let cost = issue.totalCost;
        if (issue.shortfall > 0.00001) {
          cost = +(cost + issue.shortfall * Number(prod.averageCost || prod.purchasePrice || 0)).toFixed(2);
        }
        await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $inc: { stock: -qty } }, { session });
        const cur = await kardex.currentStock({ clinicId: req.clinicId, product: it.product }, session);
        await Product.updateOne({ _id: it.product, clinic: req.clinicId }, { $set: { averageCost: cur.averageCost } }, { session });

        movements.push({
          clinic: req.clinicId,
          product: it.product,
          type: 'salida',
          quantity: qty,
          unitCost: qty > 0 ? +(cost / qty).toFixed(4) : 0,
          totalCost: cost,
          balanceAfter: cur.qty,
          layerConsumption: issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost })),
          reason: 'Consumo interno',
          createdBy: req.user._id,
        });

        if (cost > 0) {
          // La cuenta de inventario (crédito) sale de la CATEGORÍA del producto (misma regla que
          // ventas/compras); solo si el producto no tiene categoría se usa el rol genérico —este
          // flujo administrativo no bloquea, a diferencia de la venta—. Ya no se usa la cuenta
          // legacy del producto (`prod.inventoryAccount`), que era la que descuadraba las cuentas.
          const invAcc = prod.inventoryCategory?.assetAccount || inventarioDefault._id;
          lines.push({ account: (gastoDefault?._id || inventarioDefault._id), debit: cost, credit: 0, description: `Consumo interno ${prod.name}` });
          lines.push({ account: invAcc, debit: 0, credit: cost, description: `Salida inventario ${prod.name}` });
        }
        total += cost;
      }

      let entry = null;
      if (lines.length) {
        entry = await createEntry({
          clinicId: req.clinicId,
          date: txDate,
          description: notes ? `Consumo interno: ${notes}` : 'Consumo interno de insumos',
          source: 'AJUSTE',
          sourceModel: 'InventoryMovement',
          sourceAction: 'CONSUMO_INTERNO',
          lines,
          userId: req.user._id,
          session,
        });
      }
      for (const m of movements) {
        if (entry) { m.journalEntry = entry._id; m.sourceRef = entry._id; }
        await InventoryMovement.create([m], { session });
      }
      return { total: +total.toFixed(2), count: movements.length, entry: entry?._id || null };
    });

    res.status(201).json(result);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
