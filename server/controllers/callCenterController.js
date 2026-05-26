const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');

/**
 * Resolución de rango temporal (mismo patrón que marketing).
 */
function resolveRange(query) {
  const now = new Date();
  const range = query.range || 'month';
  const end = query.endDate ? new Date(query.endDate) : now;
  let start;
  if (query.startDate) {
    start = new Date(query.startDate);
  } else {
    switch (range) {
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week': {
        const d = new Date(now);
        d.setDate(d.getDate() - 7);
        start = d;
        break;
      }
      case 'quarter':
        start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        break;
      case 'year':
        start = new Date(now.getFullYear(), 0, 1);
        break;
      case 'month':
      default:
        start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end, range };
}

/**
 * Comisiones del call center.
 * Definición: el call center gana 1 comisión por cada paciente NUEVO
 * (isFirstVisit=true) que ASISTIÓ (status in ['asistida','completada']) a
 * una cita creada por ese agente.
 *
 * Si req.role === 'call_center' devuelve sólo SUS comisiones.
 * Si es admin / marketing: agrupado por agente (marketing supervisa al call center).
 */
exports.getCommissions = async (req, res) => {
  try {
    const { start, end, range } = resolveRange(req.query);
    const clinicId = new mongoose.Types.ObjectId(req.clinicId);
    const ATTENDED = ['asistida', 'completada'];

    const baseMatch = {
      clinic: clinicId,
      createdByRole: 'call_center',
      isFirstVisit: true,
      status: { $in: ATTENDED },
      date: { $gte: start, $lte: end },
    };

    // Si el rol es call_center => solo sus comisiones
    let targetAgent = null;
    if (req.role === 'call_center' && !req.user.isSuperAdmin) {
      targetAgent = req.user._id;
      baseMatch.createdBy = targetAgent;
    } else if (req.query.agent && mongoose.isValidObjectId(req.query.agent)) {
      baseMatch.createdBy = new mongoose.Types.ObjectId(req.query.agent);
      targetAgent = baseMatch.createdBy;
    }

    // Agrupado por agente
    const byAgent = await Appointment.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$createdBy',
          commissions: { $sum: 1 },
          patients: { $addToSet: '$patient' },
        },
      },
      {
        $project: {
          _id: 1,
          commissions: 1,
          uniquePatients: { $size: '$patients' },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'agent' } },
      { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          commissions: 1,
          uniquePatients: 1,
          name: '$agent.name',
          email: '$agent.email',
        },
      },
      { $sort: { commissions: -1 } },
    ]);

    // Evolución diaria/mensual (de TODO el conjunto filtrado)
    const useMonthly = (end - start) / (1000 * 60 * 60 * 24) > 90;
    const timeline = await Appointment.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: useMonthly
            ? { $dateToString: { format: '%Y-%m', date: '$date' } }
            : { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          commissions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Detalle por cita (limitado) — útil para el agente
    const detailFilter = { ...baseMatch };
    const details = await Appointment.find(detailFilter)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name')
      .sort({ date: -1 })
      .limit(200)
      .select('date startTime status patient createdBy services isFirstVisit');

    const total = byAgent.reduce((acc, a) => acc + (a.commissions || 0), 0);

    res.json({
      from: start,
      to: end,
      range,
      total,
      byAgent,
      timeline,
      details,
      scope: req.role === 'call_center' ? 'self' : 'all',
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al calcular comisiones', error: err.message });
  }
};

/**
 * Resumen general para el dashboard del call center: citas creadas, primeras,
 * asistidas, no-show, etc. Si rol = call_center, sólo sus métricas.
 */
exports.getAgentSummary = async (req, res) => {
  try {
    const { start, end } = resolveRange(req.query);
    const clinicId = new mongoose.Types.ObjectId(req.clinicId);
    const baseMatch = {
      clinic: clinicId,
      createdByRole: 'call_center',
      date: { $gte: start, $lte: end },
    };

    if (req.role === 'call_center' && !req.user.isSuperAdmin) {
      baseMatch.createdBy = req.user._id;
    } else if (req.query.agent && mongoose.isValidObjectId(req.query.agent)) {
      baseMatch.createdBy = new mongoose.Types.ObjectId(req.query.agent);
    }

    const agg = await Appointment.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$createdBy',
          totalCreated: { $sum: 1 },
          firstVisit: { $sum: { $cond: ['$isFirstVisit', 1, 0] } },
          attended: {
            $sum: { $cond: [{ $in: ['$status', ['asistida', 'completada']] }, 1, 0] },
          },
          firstAttended: {
            $sum: {
              $cond: [
                {
                  $and: [
                    '$isFirstVisit',
                    { $in: ['$status', ['asistida', 'completada']] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          noShow: { $sum: { $cond: [{ $eq: ['$status', 'no_asistio'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelada'] }, 1, 0] } },
        },
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'agent' } },
      { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          name: '$agent.name',
          email: '$agent.email',
          totalCreated: 1,
          firstVisit: 1,
          attended: 1,
          firstAttended: 1,
          noShow: 1,
          cancelled: 1,
        },
      },
      { $sort: { firstAttended: -1 } },
    ]);

    res.json({ from: start, to: end, agents: agg });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener resumen', error: err.message });
  }
};

/**
 * Lista de agentes call_center activos en la clínica (para selector de supervisor).
 */
exports.listAgents = async (req, res) => {
  try {
    const users = await User.find({
      active: true,
      'clinics.clinic': req.clinicId,
      'clinics.role': 'call_center',
    }).select('name email');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar agentes', error: err.message });
  }
};
