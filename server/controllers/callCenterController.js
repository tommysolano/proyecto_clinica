const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const CommissionRule = require('../models/CommissionRule');

// ¿La cita cae dentro del horario configurado en la regla?
const inSchedule = (rule, appt) => {
  if (!rule.scheduleEnabled) return true;
  const weekday = new Date(appt.date).getDay();
  if (rule.daysOfWeek?.length && !rule.daysOfWeek.includes(weekday)) return false;
  if (rule.startTime && appt.startTime < rule.startTime) return false;
  if (rule.endTime && appt.startTime > rule.endTime) return false;
  return true;
};

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
 * Comisiones del call center — calculadas a partir de las REGLAS DE COMISIÓN.
 *
 * El admin configura en "Reglas de Comisión" una o varias reglas que apliquen al
 * call center (targetType='role' role='call_center', o targetType='user' apuntando
 * a un agente). Cada regla define el monto ($), el servicio (opcional), el horario
 * (opcional) y el alcance de paciente (nuevo / todos).
 *
 * Una comisión se devenga cuando una cita CREADA por el agente es ASISTIDA y cumple
 * la regla (p. ej. "paciente nuevo asiste a una cita" → patientScope='new').
 *
 * Si req.role === 'call_center' devuelve sólo SUS comisiones; admin/marketing ven todo.
 */
exports.getCommissions = async (req, res) => {
  try {
    const { start, end, range } = resolveRange(req.query);
    const clinicId = new mongoose.Types.ObjectId(req.clinicId);
    const ATTENDED = ['asistida', 'completada'];

    // Reglas activas que apliquen al call center.
    const rules = await CommissionRule.find({
      clinic: clinicId,
      active: true,
      $or: [
        { targetType: 'role', role: 'call_center' },
        { targetType: 'user' },
      ],
    }).lean();
    const callCenterRules = rules.filter(
      (r) => (r.targetType === 'role' && r.role === 'call_center') || r.targetType === 'user'
    );

    const apptMatch = {
      clinic: clinicId,
      createdByRole: 'call_center',
      status: { $in: ATTENDED },
      date: { $gte: start, $lte: end },
    };
    if (req.role === 'call_center' && !req.user.isSuperAdmin) {
      apptMatch.createdBy = req.user._id;
    } else if (req.query.agent && mongoose.isValidObjectId(req.query.agent)) {
      apptMatch.createdBy = new mongoose.Types.ObjectId(req.query.agent);
    }

    const appts = await Appointment.find(apptMatch)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name email')
      .sort({ date: -1 })
      .select('date startTime status patient createdBy services isFirstVisit');

    const useMonthly = (end - start) / (1000 * 60 * 60 * 24) > 90;
    const agentMap = new Map();
    const timelineMap = new Map();
    const details = [];

    for (const appt of appts) {
      const agentId = String(appt.createdBy?._id || appt.createdBy || 'sin-agente');
      const svcIds = (appt.services || []).map((s) => String(s.product?._id || s.product));
      // Buscar la primera regla que aplique (evita doble conteo de la misma cita).
      const rule = callCenterRules.find((r) => {
        if (r.targetType === 'user') {
          if (String(r.user) !== agentId) return false;
        } else if (r.role !== 'call_center') {
          return false;
        }
        if (r.service && !svcIds.includes(String(r.service))) return false;
        if (r.patientScope === 'new' && !appt.isFirstVisit) return false;
        if (!inSchedule(r, appt)) return false;
        return true;
      });
      if (!rule) continue;

      const amount = Number(rule.amount) || 0;
      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, {
          _id: agentId,
          name: appt.createdBy?.name || 'Agente',
          email: appt.createdBy?.email || '',
          commissions: 0,
          total: 0,
          patients: new Set(),
        });
      }
      const a = agentMap.get(agentId);
      a.commissions += 1;
      a.total += amount;
      a.patients.add(String(appt.patient?._id || appt.patient));

      const key = useMonthly
        ? new Date(appt.date).toISOString().slice(0, 7)
        : new Date(appt.date).toISOString().slice(0, 10);
      timelineMap.set(key, (timelineMap.get(key) || 0) + amount);

      details.push({
        _id: appt._id,
        date: appt.date,
        startTime: appt.startTime,
        status: appt.status,
        isFirstVisit: appt.isFirstVisit,
        patient: appt.patient,
        createdBy: appt.createdBy,
        ruleName: rule.name,
        amount,
      });
    }

    const byAgent = [...agentMap.values()]
      .map((a) => ({
        _id: a._id,
        name: a.name,
        email: a.email,
        commissions: a.commissions,
        total: +a.total.toFixed(2),
        uniquePatients: a.patients.size,
      }))
      .sort((x, y) => y.total - x.total);

    const timeline = [...timelineMap.entries()]
      .map(([k, v]) => ({ _id: k, total: +v.toFixed(2) }))
      .sort((x, y) => (x._id < y._id ? -1 : 1));

    const total = +byAgent.reduce((acc, a) => acc + a.total, 0).toFixed(2);

    res.json({
      from: start,
      to: end,
      range,
      total,
      rulesCount: callCenterRules.length,
      byAgent,
      timeline,
      details: details.slice(0, 200),
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
