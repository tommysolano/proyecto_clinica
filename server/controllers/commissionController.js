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
      doctor: { $ne: null },
    })
      .populate('doctor', 'name clinics')
      .populate('patient', 'firstName lastName');

    // Resolver rol del performer por clínica
    const roleFor = (doctor) => {
      if (!doctor?.clinics) return null;
      const f = doctor.clinics.find((c) => String(c.clinic) === String(req.clinicId));
      return f ? f.role : null;
    };

    const detail = [];
    for (const appt of appts) {
      const performer = appt.doctor;
      if (!performer) continue;
      const performerRole = roleFor(performer);
      const services = appt.services?.length ? appt.services : [{ product: null, name: '—' }];
      for (const svc of services) {
        for (const rule of rules) {
          // target
          if (rule.targetType === 'user') {
            if (String(rule.user) !== String(performer._id)) continue;
          } else {
            if (rule.role !== performerRole) continue;
          }
          // service
          if (rule.service && String(rule.service) !== String(svc.product)) continue;
          // patient scope
          if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
          // schedule
          if (!inSchedule(rule, appt)) continue;

          detail.push({
            userId: String(performer._id),
            userName: performer.name,
            ruleName: rule.name,
            amount: rule.amount,
            date: appt.date,
            service: svc.name || '—',
            patient: appt.patient ? `${appt.patient.firstName} ${appt.patient.lastName}` : '—',
          });
        }
      }
    }

    // ─── Comisiones por ÍTEM vendido en ventas ───
    // Por cada venta no anulada en el rango, por cada item vendido, evaluamos las
    // reglas (target = createdBy de la venta) y aplicamos rule.amount * quantity.
    const Sale = require('../models/Sale');
    const User = require('../models/User');
    const sales = await Sale.find({
      clinic: req.clinicId,
      status: { $ne: 'anulada' },
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .populate('createdBy', 'name clinics')
      .populate('patient', 'firstName lastName');
    for (const sale of sales) {
      const performer = sale.createdBy;
      if (!performer) continue;
      const performerRole = roleFor(performer);
      for (const it of sale.items || []) {
        for (const rule of rules) {
          if (rule.targetType === 'user') {
            if (String(rule.user) !== String(performer._id)) continue;
          } else if (rule.role !== performerRole) {
            continue;
          }
          // Si rule.service está definido, debe coincidir con el producto vendido.
          if (rule.service && String(rule.service) !== String(it.product)) continue;
          const qty = Number(it.quantity || 1);
          detail.push({
            userId: String(performer._id),
            userName: performer.name,
            ruleName: rule.name,
            amount: Number(rule.amount) * qty,
            date: sale.createdAt,
            service: it.productName || '—',
            patient: sale.patient
              ? `${sale.patient.firstName || ''} ${sale.patient.lastName || ''}`.trim()
              : sale.clientName || '—',
            source: 'venta',
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
