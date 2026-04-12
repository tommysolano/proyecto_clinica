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

    const appointmentQuery = { date: { $gte: today, $lt: tomorrow } };
    if (req.user.role === 'doctor') {
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
      Patient.countDocuments({ active: true }),
      Sale.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'completada',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$total' },
            count: { $sum: 1 },
          },
        },
      ]),
      Product.find({ active: true, $expr: { $lte: ['$stock', '$minStock'] } })
        .select('name code stock minStock')
        .limit(10),
      Appointment.aggregate([
        { $match: { date: { $gte: today, $lt: tomorrow } } },
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
