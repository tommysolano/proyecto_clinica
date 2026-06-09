const CommissionRule = require('../models/CommissionRule');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const CommissionPosting = require('../models/CommissionPosting');
const { createEntry, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

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

// ─────────── Cálculo de comisiones devengadas ───────────
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
 * partir de las citas COMPLETADAS y las ventas, según las reglas activas.
 * Devuelve la lista completa de detalles (sin filtrar) y el número de reglas.
 * Cada detalle incluye la cuenta contable de la regla (ruleAccount) para poder
 * contabilizarla.
 */
async function computeCommissions(clinicId, startDate, endDate) {
  const rules = await CommissionRule.find({ clinic: clinicId, active: true });
  if (!rules.length) return { rules: [], detail: [] };

  const appts = await Appointment.find({
    clinic: clinicId,
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
    const f = u.clinics.find((c) => String(c.clinic) === String(clinicId));
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
          const creatorRole = roleFor(creator);
          if (!matchTarget(rule, creator, creatorRole)) continue;
          detail.push({
            userId: String(creator._id), userName: creator.name, userRole: creatorRole,
            ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
            amount: rule.amount, date: appt.date,
            service: svc.name || '—',
            patient: appt.patient ? `${appt.patient.firstName} ${appt.patient.lastName}` : '—',
            source: 'cita agendada',
          });
        } else if (!rule.trigger || rule.trigger === 'appointment_performed') {
          for (const performer of performers) {
            const performerRole = roleFor(performer);
            if (!matchTarget(rule, performer, performerRole)) continue;
            detail.push({
              userId: String(performer._id), userName: performer.name, userRole: performerRole,
              ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
              amount: rule.amount, date: appt.date,
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
    clinic: clinicId,
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
        const performerRole = roleFor(performer);
        if (!matchTarget(rule, performer, performerRole)) continue;
        detail.push({
          userId: String(performer._id), userName: performer.name, userRole: performerRole,
          ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
          amount: Number(rule.amount) * qty,
          date: sale.createdAt, service: it.productName || '—',
          patient: patientName, source,
        });
      }
    }
  }

  return { rules, detail };
}

/** Agrupa el detalle por usuario y calcula el total. */
function summarize(detail) {
  const byUserMap = {};
  for (const d of detail) {
    if (!byUserMap[d.userId]) byUserMap[d.userId] = { userId: d.userId, userName: d.userName, count: 0, total: 0 };
    byUserMap[d.userId].count += 1;
    byUserMap[d.userId].total += d.amount;
  }
  const byUser = Object.values(byUserMap).sort((a, b) => b.total - a.total);
  const total = detail.reduce((a, d) => a + d.amount, 0);
  return { byUser, total: +total.toFixed(2) };
}

const parseRange = (start, end) => {
  const startDate = start ? new Date(start) : new Date(Date.now() - 30 * 86400000);
  startDate.setHours(0, 0, 0, 0);
  const endDate = end ? new Date(end) : new Date();
  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
};

// ─────────── Reporte de comisiones devengadas ───────────
exports.report = async (req, res) => {
  try {
    const { start, end, user, role: roleFilter } = req.query;
    const { startDate, endDate } = parseRange(start, end);

    const { rules, detail } = await computeCommissions(req.clinicId, startDate, endDate);
    if (!rules.length) return res.json({ rules: 0, byUser: [], detail: [], total: 0 });

    const filtered = user
      ? detail.filter((d) => d.userId === String(user))
      : roleFilter
      ? detail.filter((d) => d.userRole === roleFilter)
      : detail;

    const { byUser, total } = summarize(filtered);

    res.json({
      rules: rules.length,
      byUser,
      detail: filtered.sort((a, b) => new Date(b.date) - new Date(a.date)),
      total,
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular comisiones', error: e.message });
  }
};

// ─────────── Contabilización de comisiones ───────────

/** Lista las contabilizaciones de comisiones registradas. */
exports.listPostings = async (req, res) => {
  try {
    const items = await CommissionPosting.find({ clinic: req.clinicId })
      .populate('journalEntry', 'number date status')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener contabilizaciones', error: e.message });
  }
};

/**
 * Genera el asiento contable de las comisiones devengadas en un rango:
 *   Débito  gasto de comisiones (por la cuenta de cada regla, o "Comisiones al
 *           personal" si la regla no tiene cuenta asignada)
 *   Crédito comisiones por pagar al personal (pasivo)
 * Es idempotente: bloquea si ya existe una contabilización vigente que se
 * solape con el rango indicado.
 */
exports.postCommissions = async (req, res) => {
  try {
    const { start, end, notes } = req.body;
    const { startDate, endDate } = parseRange(start, end);

    // Evitar doble contabilización de rangos solapados.
    const overlap = await CommissionPosting.findOne({
      clinic: req.clinicId,
      status: 'CONTABILIZADO',
      start: { $lte: endDate },
      end: { $gte: startDate },
    });
    if (overlap) {
      return res.status(400).json({
        message: `Ya existe una contabilización de comisiones (${overlap.start.toISOString().slice(0, 10)} a ${overlap.end.toISOString().slice(0, 10)}) que se solapa con este período. Anúlala antes de volver a contabilizar.`,
      });
    }

    const { rules, detail } = await computeCommissions(req.clinicId, startDate, endDate);
    if (!rules.length) return res.status(400).json({ message: 'No hay reglas de comisión activas' });

    const { byUser, total } = summarize(detail);
    if (total <= 0) {
      return res.status(400).json({ message: 'No hay comisiones con monto ($) para contabilizar en este período' });
    }

    // Agrupar el débito por cuenta de gasto: cada regla puede tener su cuenta.
    // Si no la tiene, se usa el rol configurable "Comisiones al personal".
    const defaultExpense = await getAccount(req.clinicId, 'comisionesPersonal');
    const byAccount = new Map(); // accountId -> { account, amount }
    for (const d of detail) {
      if (!d.amount) continue;
      const accId = d.ruleAccount ? String(d.ruleAccount) : String(defaultExpense._id);
      const prev = byAccount.get(accId) || { accountId: d.ruleAccount || defaultExpense._id, amount: 0 };
      prev.amount += d.amount;
      byAccount.set(accId, prev);
    }

    const lines = [];
    for (const { accountId, amount } of byAccount.values()) {
      const amt = +amount.toFixed(2);
      if (amt <= 0) continue;
      lines.push({ account: accountId, debit: amt, credit: 0, description: 'Comisiones devengadas' });
    }
    const porPagar = await getAccount(req.clinicId, 'comisionesPorPagar');
    lines.push({ account: porPagar._id, debit: 0, credit: +total.toFixed(2), description: 'Comisiones por pagar al personal' });

    const periodLabel = `${startDate.toISOString().slice(0, 10)} a ${endDate.toISOString().slice(0, 10)}`;
    const entry = await createEntry({
      clinicId: req.clinicId, date: endDate,
      description: `Comisiones devengadas ${periodLabel}`,
      source: 'NOMINA', sourceModel: 'CommissionPosting',
      lines, userId: req.user._id,
    });

    const posting = await CommissionPosting.create({
      clinic: req.clinicId, start: startDate, end: endDate,
      total: +total.toFixed(2), byUser, journalEntry: entry._id,
      notes: notes || '', createdBy: req.user._id,
    });
    // Enlazar el asiento con su origen.
    entry.sourceRef = posting._id;
    await entry.save();

    res.status(201).json({ posting, journalEntry: { _id: entry._id, number: entry.number } });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Anula una contabilización: reversa el asiento y marca el registro como ANULADO. */
exports.cancelPosting = async (req, res) => {
  try {
    const p = await CommissionPosting.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'Contabilización no encontrada' });
    if (p.status === 'ANULADO') return res.status(400).json({ message: 'Ya está anulada' });
    if (p.journalEntry) {
      await reverseEntry({ clinicId: req.clinicId, entryId: p.journalEntry, userId: req.user._id, reason: 'Anulación contabilización de comisiones' });
    }
    p.status = 'ANULADO';
    await p.save();
    res.json(p);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};
