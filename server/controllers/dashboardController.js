const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const Product = require('../models/Product');

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

    const appointmentQuery = { clinic: clinicId, date: { $gte: today, $lt: tomorrow } };
    if (req.role === 'doctor') {
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
      req.role === 'doctor'
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
      req.role === 'doctor'
        ? Promise.resolve([])
        : Product.find({
            clinic: clinicId,
            active: true,
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
