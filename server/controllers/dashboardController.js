const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const mongoose = require('mongoose');
const { isDoctorRole } = require('../constants/roles');

exports.getDashboard = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);

    const clinicId = req.clinicId;
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(clinicId);

    const isClinician = isDoctorRole(req.role);
    const appointmentQuery = { clinic: clinicId, date: { $gte: today, $lt: tomorrow } };
    if (isClinician) {
      appointmentQuery.doctor = req.user._id;
    }

    const [
      todayAppointments,
      totalPatients,
      monthSales,
      lowStockProducts,
      appointmentsByStatus,
    ] = await Promise.all([
      Appointment.find(appointmentQuery)
        .populate('patient', 'firstName lastName')
        .populate('doctor', 'name specialty')
        .sort({ startTime: 1 }),
      Patient.countDocuments({ clinic: clinicId, active: true }),
      isClinician
        ? Promise.resolve([])
        : Sale.aggregate([
            {
              $match: {
                clinic: clinicObjId,
                createdAt: { $gte: startOfMonth, $lte: endOfMonth },
                status: 'completada',
              },
            },
            {
              $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } },
            },
          ]),
      isClinician
        ? Promise.resolve([])
        : Product.find({
            clinic: clinicId,
            active: true,
            unlimited: { $ne: true },
            $expr: { $lte: ['$stock', '$minStock'] },
          })
            .select('name code stock minStock')
            .limit(10),
      Appointment.aggregate([
        { $match: { clinic: clinicObjId, date: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      todayAppointments,
      totalPatients,
      monthSales: monthSales[0] || { total: 0, count: 0 },
      lowStockProducts,
      appointmentsByStatus,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener dashboard', error: error.message });
  }
};

/**
 * Top productos / servicios más vendidos en la clínica activa.
 * Acepta filtros opcionales `startDate`, `endDate` y `limit`.
 */
exports.getTopProducts = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { startDate, endDate, limit = 10 } = req.query;

    const match = { clinic: clinicObjId, status: 'completada' };
    if (startDate && endDate) {
      match.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate + 'T23:59:59.999'),
      };
    }

    const top = await Sale.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          name: { $first: '$items.productName' },
          category: { $first: '$items.category' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.subtotal' },
          salesCount: { $sum: 1 },
        },
      },
      { $sort: { quantity: -1 } },
      { $limit: Number(limit) || 10 },
    ]);

    res.json(top);
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al obtener top productos', error: error.message });
  }
};

/** Formato de agrupación de fecha por granularidad. */
function dateGroupExpr(granularity, field) {
  switch (granularity) {
    case 'day': return { $dateToString: { format: '%Y-%m-%d', date: field } };
    case 'week': return { $dateToString: { format: '%G-S%V', date: field } };
    case 'year': return { $dateToString: { format: '%Y', date: field } };
    case 'quarter': return { $concat: [{ $dateToString: { format: '%Y', date: field } }, '-T', { $toString: { $ceil: { $divide: [{ $month: field }, 3] } } }] };
    case 'month':
    default: return { $dateToString: { format: '%Y-%m', date: field } };
  }
}

/**
 * Dashboard contable: ventas por período, comparativas, top vendido/gastado,
 * resumen de caja/bancos, stock bajo e indicadores financieros.
 * query: { granularity=month, periods=12 }
 */
exports.getAccountingDashboard = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const granularity = req.query.granularity || 'month';
    const periods = Math.min(parseInt(req.query.periods) || 12, 60);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const startOfPrevYear = new Date(now.getFullYear() - 1, 0, 1);
    const endOfPrevYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const grp = dateGroupExpr(granularity, '$createdAt');

    const [
      salesSeries, expenseSeries, topSold, topSpent, lowStock,
      monthSales, prevMonthSales, yearSales, prevYearSales,
      todayCashSales, bankAccounts, apAgg,
    ] = await Promise.all([
      // Serie de ventas
      Sale.aggregate([
        { $match: { clinic: clinicObjId, status: 'completada' } },
        { $group: { _id: grp, total: { $sum: '$total' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }, { $limit: periods + 24 },
      ]),
      // Serie de gastos (compras)
      PurchaseInvoice.aggregate([
        { $match: { clinic: clinicObjId, status: { $ne: 'ANULADA' } } },
        { $group: { _id: dateGroupExpr(granularity, '$fechaEmision'), total: { $sum: '$total' } } },
        { $sort: { _id: 1 } }, { $limit: periods + 24 },
      ]),
      // Top productos vendidos (mes actual)
      Sale.aggregate([
        { $match: { clinic: clinicObjId, status: 'completada', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.productName', quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.subtotal' } } },
        { $sort: { revenue: -1 } }, { $limit: 8 },
      ]),
      // Top categorías de gasto (compras del mes por cuenta del ítem)
      PurchaseInvoice.aggregate([
        { $match: { clinic: clinicObjId, status: { $ne: 'ANULADA' }, fechaEmision: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.description', total: { $sum: '$items.subtotal' } } },
        { $sort: { total: -1 } }, { $limit: 8 },
      ]),
      Product.find({ clinic: req.clinicId, active: true, unlimited: { $ne: true }, $expr: { $lte: ['$stock', '$minStock'] } })
        .select('name code stock minStock').sort({ stock: 1 }).limit(50),
      Sale.aggregate([{ $match: { clinic: clinicObjId, status: 'completada', createdAt: { $gte: startOfMonth, $lte: endOfMonth } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Sale.aggregate([{ $match: { clinic: clinicObjId, status: 'completada', createdAt: { $gte: startOfPrevMonth, $lte: endOfPrevMonth } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Sale.aggregate([{ $match: { clinic: clinicObjId, status: 'completada', createdAt: { $gte: startOfYear } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Sale.aggregate([{ $match: { clinic: clinicObjId, status: 'completada', createdAt: { $gte: startOfPrevYear, $lte: endOfPrevYear } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Sale.aggregate([{ $match: { clinic: clinicObjId, status: 'completada', paymentMethod: 'efectivo', createdAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      BankAccount.find({ clinic: req.clinicId, active: true }).select('name bank initialBalance'),
      // Cuentas por pagar (saldo de facturas de compra)
      PurchaseInvoice.aggregate([{ $match: { clinic: clinicObjId, status: { $ne: 'ANULADA' } } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
    ]);

    // Saldos bancarios
    let bankTotal = 0;
    for (const a of bankAccounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: clinicObjId, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      bankTotal += (a.initialBalance || 0) + (agg[0]?.total || 0);
    }

    const monthRevenue = monthSales[0]?.total || 0;
    const monthExpenseAgg = await PurchaseInvoice.aggregate([
      { $match: { clinic: clinicObjId, status: { $ne: 'ANULADA' }, fechaEmision: { $gte: startOfMonth, $lte: endOfMonth } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    const monthExpenseTotal = monthExpenseAgg[0]?.total || 0;
    const profit = monthRevenue - monthExpenseTotal;
    const margin = monthRevenue > 0 ? (profit / monthRevenue) * 100 : 0;

    const pct = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : (cur > 0 ? 100 : 0));

    // Proyección simple: promedio de los últimos períodos de la serie
    const lastVals = salesSeries.slice(-Math.min(6, salesSeries.length)).map((s) => s.total);
    const projection = lastVals.length ? +(lastVals.reduce((a, b) => a + b, 0) / lastVals.length).toFixed(2) : 0;

    res.json({
      granularity,
      salesSeries: salesSeries.slice(-periods),
      expenseSeries: expenseSeries.slice(-periods),
      topSold,
      topSpent,
      lowStock,
      comparison: {
        month: { current: monthRevenue, previous: prevMonthSales[0]?.total || 0, pct: pct(monthRevenue, prevMonthSales[0]?.total || 0) },
        year: { current: yearSales[0]?.total || 0, previous: prevYearSales[0]?.total || 0, pct: pct(yearSales[0]?.total || 0, prevYearSales[0]?.total || 0) },
      },
      cash: { bankTotal: +bankTotal.toFixed(2), todayCashSales: todayCashSales[0]?.total || 0 },
      ratios: {
        monthRevenue, monthExpense: monthExpenseTotal, profit: +profit.toFixed(2), margin: +margin.toFixed(2),
        accountsPayable: apAgg[0]?.total || 0,
        projectionNextPeriod: projection,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener dashboard contable', error: error.message });
  }
};
