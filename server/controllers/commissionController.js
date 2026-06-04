const CommissionRule = require('../models/CommissionRule');
const Appointment = require('../models/Appointment');
const User = require('../models/User');

// ─────────── CRUD de reglas ───────────
exports.listRules = async (req, res) => {
  try {
    const rules = await CommissionRule.find({ clinic: req.clinicId })
      .populate('user', 'name')
      .populate('service', 'name')
      .sort({ createdAt: -1 });
    res.json(rules);
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener reglas', error: e.message });
  }
};

exports.createRule = async (req, res) => {
  try {
    const rule = await CommissionRule.create({
      ...req.body,
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    res.status(201).json(rule);
  } catch (e) {
    res.status(500).json({ message: 'Error al crear regla', error: e.message });
  }
};

exports.updateRule = async (req, res) => {
  try {
    const rule = await CommissionRule.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!rule) return res.status(404).json({ message: 'Regla no encontrada' });
    res.json(rule);
  } catch (e) {
    res.status(500).json({ message: 'Error al actualizar regla', error: e.message });
  }
};

exports.deleteRule = async (req, res) => {
  try {
    const rule = await CommissionRule.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!rule) return res.status(404).json({ message: 'Regla no encontrada' });
    res.json({ message: 'Regla eliminada' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar regla', error: e.message });
  }
};

// ─────────── Reporte de comisiones devengadas ───────────
const inSchedule = (rule, appt) => {
  if (!rule.scheduleEnabled) return true;
  const d = new Date(appt.date);
  const weekday = d.getDay();
  if (rule.daysOfWeek?.length && !rule.daysOfWeek.includes(weekday)) return false;
  if (rule.startTime && appt.startTime < rule.startTime) return false;
  if (rule.endTime && appt.startTime > rule.endTime) return false;
  return true;
};

/**
 * Calcula, sobre la marcha, las comisiones devengadas en un rango de fechas a
 * partir de las citas COMPLETADAS y las reglas activas de la clínica.
 */
exports.report = async (req, res) => {
  try {
    const { start, end, user } = req.query;
    const startDate = start ? new Date(start) : new Date(Date.now() - 30 * 86400000);
    startDate.setHours(0, 0, 0, 0);
    const endDate = end ? new Date(end) : new Date();
    endDate.setHours(23, 59, 59, 999);

    const rules = await CommissionRule.find({ clinic: req.clinicId, active: true });
    if (!rules.length) return res.json({ rules: 0, byUser: [], detail: [], total: 0 });

    const appts = await Appointment.find({
      clinic: req.clinicId,
      status: 'completada',
      date: { $gte: startDate, $lte: endDate },
    })
      .populate('doctor', 'name clinics')
      .populate('attendedByNurse', 'name clinics')
      .populate('createdBy', 'name clinics')
      .populate('patient', 'firstName lastName');

    // Resolver rol de un usuario en esta clínica
    const roleFor = (u) => {
      if (!u?.clinics) return null;
      const f = u.clinics.find((c) => String(c.clinic) === String(req.clinicId));
      return f ? f.role : null;
    };

    // Coincidencia de target (usuario o rol) entre una regla y un performer.
    const matchTarget = (rule, performer, performerRole) => {
      if (!performer) return false;
      if (rule.targetType === 'user') return String(rule.user) === String(performer._id);
      return rule.role === performerRole;
    };

    const detail = [];
    for (const appt of appts) {
      const services = appt.services?.length ? appt.services : [{ product: null, name: '—' }];
      // Candidatos según el evento de cada regla:
      //  - appointment_performed: doctor o enfermero que atendió
      //  - appointment_created: quien agendó la cita
      const performers = [appt.doctor, appt.attendedByNurse].filter(Boolean);
      const creator = appt.createdBy;
      for (const svc of services) {
        for (const rule of rules) {
          if (rule.service && String(rule.service) !== String(svc.product)) continue;
          if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
          if (!inSchedule(rule, appt)) continue;

          if (rule.trigger === 'appointment_created') {
            if (!matchTarget(rule, creator, roleFor(creator))) continue;
            detail.push({
              userId: String(creator._id), userName: creator.name,
              ruleName: rule.name, amount: rule.amount, date: appt.date,
              service: svc.name || '—',
              patient: appt.patient ? `${appt.patient.firstName} ${appt.patient.lastName}` : '—',
              source: 'cita agendada',
            });
          } else if (!rule.trigger || rule.trigger === 'appointment_performed') {
            for (const performer of performers) {
              if (!matchTarget(rule, performer, roleFor(performer))) continue;
              detail.push({
                userId: String(performer._id), userName: performer.name,
                ruleName: rule.name, amount: rule.amount, date: appt.date,
                service: svc.name || '—',
                patient: appt.patient ? `${appt.patient.firstName} ${appt.patient.lastName}` : '—',
                source: 'cita atendida',
              });
            }
          }
        }
      }
    }

    // ─── Comisiones sobre ventas ───
    // trigger 'sale'           -> performer = quien registró la venta (cajero)
    // trigger 'recommendation' -> performer = recomendado por (doctor/enfermero/otro)
    const Sale = require('../models/Sale');
    const sales = await Sale.find({
      clinic: req.clinicId,
      status: { $ne: 'anulada' },
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .populate('createdBy', 'name clinics')
      .populate('recommendedBy', 'name clinics')
      .populate('patient', 'firstName lastName');
    for (const sale of sales) {
      const patientName = sale.patient
        ? `${sale.patient.firstName || ''} ${sale.patient.lastName || ''}`.trim()
        : sale.clientName || '—';
      for (const it of sale.items || []) {
        for (const rule of rules) {
          if (rule.service && String(rule.service) !== String(it.product)) continue;
          const qty = Number(it.quantity || 1);
          let performer = null;
          let source = '';
          if (rule.trigger === 'sale') { performer = sale.createdBy; source = 'venta'; }
          else if (rule.trigger === 'recommendation') { performer = sale.recommendedBy; source = 'recomendación'; }
          else continue;
          if (!matchTarget(rule, performer, roleFor(performer))) continue;
          detail.push({
            userId: String(performer._id), userName: performer.name,
            ruleName: rule.name, amount: Number(rule.amount) * qty,
            date: sale.createdAt, service: it.productName || '—',
            patient: patientName, source,
          });
        }
      }
    }

    const filtered = user ? detail.filter((d) => d.userId === String(user)) : detail;

    const byUserMap = {};
    for (const d of filtered) {
      if (!byUserMap[d.userId]) byUserMap[d.userId] = { userId: d.userId, userName: d.userName, count: 0, total: 0 };
      byUserMap[d.userId].count += 1;
      byUserMap[d.userId].total += d.amount;
    }
    const byUser = Object.values(byUserMap).sort((a, b) => b.total - a.total);
    const total = filtered.reduce((a, d) => a + d.amount, 0);

    res.json({
      rules: rules.length,
      byUser,
      detail: filtered.sort((a, b) => new Date(b.date) - new Date(a.date)),
      total: +total.toFixed(2),
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular comisiones', error: e.message });
  }
};
