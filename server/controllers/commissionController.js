const CommissionRule = require('../models/CommissionRule');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const CommissionPosting = require('../models/CommissionPosting');
const { createEntry, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const ExcelJS = require('exceljs');

const ROLE_LABELS = { admin: 'Administrador', doctor: 'Médico', ginecologia: 'Ginecología', nurse: 'Enfermero/a', call_center: 'Call center', marketing: 'Marketing', contabilidad: 'Contabilidad' };

// ─────────── CRUD de reglas ───────────
exports.listRules = async (req, res) => {
  try {
    const rules = await CommissionRule.find({ clinic: req.clinicId })
      .populate('user', 'name')
      .populate('service', 'name')
      .populate('linkedCallCenter', 'name')
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
const num = (v) => Number(v) || 0;

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
 * Resuelve la configuración de monto (fijo/porcentaje) que aplica a un producto
 * dentro de una regla.
 *   - Regla multi-servicio (serviceAmounts): devuelve la entrada del servicio, o
 *     null si el producto no está en la lista (la regla NO aplica).
 *   - Regla simple: devuelve la config global de la regla (respetando el filtro
 *     `service` que se valida aparte por quien llama).
 */
const amountConfigFor = (rule, productId) => {
  if (rule.serviceAmounts?.length) {
    const m = rule.serviceAmounts.find((sa) => String(sa.service) === String(productId));
    if (!m) return null;
    return { amountType: m.amountType || 'fixed', amount: num(m.amount), percent: num(m.percent) };
  }
  return { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
};

/**
 * Valor de la comisión a partir de la config y el precio que paga el paciente.
 *   - percent: porcentaje sobre `paidPrice` (que ya incluye la cantidad).
 *   - fixed:   monto fijo × cantidad.
 */
const calcAmount = (cfg, paidPrice, qty = 1) => {
  if (!cfg) return 0;
  if (cfg.amountType === 'percent') return +((cfg.percent / 100) * num(paidPrice)).toFixed(2);
  return +(cfg.amount * qty).toFixed(2);
};

/**
 * Calcula, sobre la marcha, las comisiones devengadas en un rango de fechas a
 * partir de las citas (asistidas/completadas), ventas y derivaciones, según las
 * reglas activas. Devuelve la lista completa de detalles (sin filtrar) y las
 * reglas. Cada detalle incluye la cuenta contable de la regla (ruleAccount).
 */
async function computeCommissions(clinicId, startDate, endDate) {
  const rules = await CommissionRule.find({ clinic: clinicId, active: true });
  if (!rules.length) return { rules: [], detail: [] };

  // Citas asistidas o completadas. El call center devenga al ASISTIR; el doctor /
  // enfermero / admin sólo cuando la cita se COMPLETA (fue atendida).
  const appts = await Appointment.find({
    clinic: clinicId,
    status: { $in: ['asistida', 'completada'] },
    date: { $gte: startDate, $lte: endDate },
  })
    .populate('doctor', 'name clinics')
    .populate('attendedByNurse', 'name clinics')
    .populate('createdBy', 'name clinics')
    .populate('patient', 'firstName lastName')
    .populate({ path: 'referral', populate: { path: 'fromDoctor', select: 'name clinics' } });

  // Usuarios de la clínica (para targets por rol: admin / marketing).
  const clinicUsers = await User.find({ 'clinics.clinic': clinicId }).select('name clinics');
  const clinicUsersById = new Map(clinicUsers.map((u) => [String(u._id), u]));
  const usersWithRole = (role) =>
    clinicUsers.filter((u) => (u.clinics || []).some((c) => String(c.clinic) === String(clinicId) && c.role === role));
  const adminUsers = usersWithRole('admin');
  const marketingUsers = usersWithRole('marketing');

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
    if (rule.role === performerRole) return true;
    // 'ginecologia' es un doctor especializado: hereda las reglas por rol 'doctor'.
    if (rule.role === 'doctor' && performerRole === 'ginecologia') return true;
    return false;
  };

  // ¿La cita incluye un servicio que la regla exige? (filtro a nivel de cita).
  const apptHasRuleService = (rule, appt) => {
    const svcs = appt.services || [];
    if (rule.serviceAmounts?.length) {
      return svcs.some((s) => rule.serviceAmounts.some((sa) => String(sa.service) === String(s.product)));
    }
    if (rule.service) return svcs.some((s) => String(s.product) === String(rule.service));
    return true;
  };

  const detail = [];
  for (const appt of appts) {
    const isCompleted = appt.status === 'completada';
    const isAttended = appt.status === 'asistida' || isCompleted;
    const services = appt.services?.length ? appt.services : [{ product: null, name: '—', price: 0 }];
    const performers = [appt.doctor, appt.attendedByNurse].filter(Boolean);
    const creator = appt.createdBy;
    const patientName = appt.patient ? `${appt.patient.firstName} ${appt.patient.lastName}` : '—';
    const apptTotal = (appt.services || []).reduce((a, s) => a + num(s.price), 0);

    // ── Comisiones por SERVICIO de la cita (doctor/enfermero atiende; admin) ──
    for (const svc of services) {
      for (const rule of rules) {
        if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
        if (!inSchedule(rule, appt)) continue;

        // Filtro de servicio + config de monto.
        let cfg;
        if (rule.serviceAmounts?.length) {
          cfg = amountConfigFor(rule, svc.product);
          if (!cfg) continue;
        } else {
          if (rule.service && String(rule.service) !== String(svc.product)) continue;
          cfg = { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        }

        if (rule.trigger === 'admin_service') {
          if (!isCompleted) continue;
          const targets =
            rule.targetType === 'user'
              ? [clinicUsersById.get(String(rule.user))].filter(Boolean)
              : adminUsers;
          for (const adm of targets) {
            detail.push({
              userId: String(adm._id), userName: adm.name, userRole: roleFor(adm) || 'admin',
              ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
              amount: calcAmount(cfg, svc.price), date: appt.date,
              service: svc.name || '—', patient: patientName, source: 'servicio atendido', apptId: String(appt._id),
            });
          }
        } else if (!rule.trigger || rule.trigger === 'appointment_performed') {
          if (!isCompleted) continue;
          for (const performer of performers) {
            const performerRole = roleFor(performer);
            if (!matchTarget(rule, performer, performerRole)) continue;
            detail.push({
              userId: String(performer._id), userName: performer.name, userRole: performerRole,
              ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
              amount: calcAmount(cfg, svc.price), date: appt.date,
              service: svc.name || '—', patient: patientName, source: 'cita atendida', apptId: String(appt._id),
            });
          }
        }
      }
    }

    // ── Comisión del CALL CENTER: una vez por cita (no por servicio) ──
    if (isAttended) {
      for (const rule of rules) {
        if (rule.trigger !== 'appointment_created') continue;
        if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
        if (!inSchedule(rule, appt)) continue;
        const creatorRole = roleFor(creator);
        if (!matchTarget(rule, creator, creatorRole)) continue;
        if (!apptHasRuleService(rule, appt)) continue;
        // Para % en call center se toma el total de servicios de la cita.
        const cfg = rule.serviceAmounts?.length
          ? amountConfigFor(rule, (appt.services || []).find((s) => rule.serviceAmounts.some((sa) => String(sa.service) === String(s.product)))?.product)
          : { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        detail.push({
          userId: String(creator._id), userName: creator.name, userRole: creatorRole,
          ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
          amount: calcAmount(cfg, apptTotal), date: appt.date,
          service: appt.services?.[0]?.name || '—', patient: patientName, source: 'cita agendada', apptId: String(appt._id),
        });
      }
    }

    // ── Comisión por DERIVACIÓN: una vez por cita derivada completada ──
    if (isCompleted && appt.origin === 'referral' && appt.referral?.fromDoctor) {
      const fromDoc = appt.referral.fromDoctor;
      const fromRole = roleFor(fromDoc);
      for (const rule of rules) {
        if (rule.trigger !== 'referral') continue;
        if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
        if (!inSchedule(rule, appt)) continue;
        if (!matchTarget(rule, fromDoc, fromRole)) continue;
        if (!apptHasRuleService(rule, appt)) continue;
        const cfg = { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        detail.push({
          userId: String(fromDoc._id), userName: fromDoc.name, userRole: fromRole,
          ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
          amount: calcAmount(cfg, apptTotal), date: appt.date,
          service: appt.services?.[0]?.name || '—', patient: patientName, source: 'derivación', apptId: String(appt._id),
        });
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
        if (rule.trigger !== 'sale' && rule.trigger !== 'recommendation') continue;
        // Filtro de servicio + config de monto.
        let cfg;
        if (rule.serviceAmounts?.length) {
          cfg = amountConfigFor(rule, it.product);
          if (!cfg) continue;
        } else {
          if (rule.service && String(rule.service) !== String(it.product)) continue;
          cfg = { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        }
        const qty = num(it.quantity) || 1;
        // Precio que paga el paciente por la línea (incluye impuestos y cantidad).
        const linePaid = num(it.lineTotal) || num(it.subtotal);
        let performer = null;
        let source = '';
        if (rule.trigger === 'sale') { performer = sale.createdBy; source = 'venta'; }
        else { performer = sale.recommendedBy; source = 'recomendación'; }
        const performerRole = roleFor(performer);
        if (!matchTarget(rule, performer, performerRole)) continue;
        detail.push({
          userId: String(performer._id), userName: performer.name, userRole: performerRole,
          ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
          amount: calcAmount(cfg, linePaid, qty),
          date: sale.createdAt, service: it.productName || '—',
          patient: patientName, source, invoiceNumber: sale.saleNumber || '',
        });
      }
    }
  }

  // ─── Comisión del MARKETING ligado a un call center ───
  // Depende de las comisiones del call center ya calculadas arriba (source
  // 'cita agendada'). El marketing gana % sobre lo que devengó su agente, o un
  // monto fijo por cada comisión generada por ese agente.
  for (const rule of rules) {
    if (rule.trigger !== 'call_center_commission' || !rule.linkedCallCenter) continue;
    const agentId = String(rule.linkedCallCenter);
    const agentDetails = detail.filter((d) => d.userId === agentId && d.source === 'cita agendada');
    if (!agentDetails.length) continue;
    const base = agentDetails.reduce((a, d) => a + num(d.amount), 0);
    const count = agentDetails.length;
    const amount =
      (rule.amountType || 'fixed') === 'percent'
        ? +((num(rule.percent) / 100) * base).toFixed(2)
        : +(num(rule.amount) * count).toFixed(2);
    if (amount <= 0 && count === 0) continue;
    const agentName = clinicUsersById.get(agentId)?.name || 'Call center';
    const targets =
      rule.targetType === 'user'
        ? [clinicUsersById.get(String(rule.user))].filter(Boolean)
        : marketingUsers;
    for (const t of targets) {
      detail.push({
        userId: String(t._id), userName: t.name, userRole: roleFor(t) || 'marketing',
        ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
        amount, date: endDate, service: '—',
        patient: `Agente: ${agentName} (${count} comis.)`, source: 'comisión call center',
      });
    }
  }

  // Nº de factura/venta de las comisiones por cita: se busca la venta ligada a la cita.
  const apptIds = [...new Set(detail.filter((d) => d.apptId && !d.invoiceNumber).map((d) => d.apptId))];
  if (apptIds.length) {
    const apptSales = await Sale.find({ clinic: clinicId, status: { $ne: 'anulada' }, appointment: { $in: apptIds } })
      .select('appointment saleNumber');
    const numByAppt = new Map(apptSales.map((s) => [String(s.appointment), s.saleNumber || '']));
    for (const d of detail) {
      if (d.apptId && !d.invoiceNumber) d.invoiceNumber = numByAppt.get(d.apptId) || '';
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

/**
 * Exporta el detalle de comisiones a Excel con formato (dos hojas: resumen por usuario y
 * detalle con Nº de factura asociada). Mismos filtros que `report` (start/end/user/role).
 */
exports.reportExcel = async (req, res) => {
  try {
    const { start, end, user, role: roleFilter } = req.query;
    const { startDate, endDate } = parseRange(start, end);
    const { detail } = await computeCommissions(req.clinicId, startDate, endDate);
    const filtered = user
      ? detail.filter((d) => d.userId === String(user))
      : roleFilter
      ? detail.filter((d) => d.userRole === roleFilter)
      : detail;
    const { byUser, total } = summarize(filtered);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema clínica';
    wb.created = new Date();
    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' } };
    const money = '"$"#,##0.00';
    const styleHeader = (ws) => ws.getRow(1).eachCell((c) => {
      c.fill = headerFill; c.font = headerFont;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
    });

    // Hoja 1 — Resumen por usuario
    const s1 = wb.addWorksheet('Resumen por usuario', { views: [{ state: 'frozen', ySplit: 1 }] });
    s1.columns = [
      { header: 'Usuario', key: 'userName', width: 34 },
      { header: 'Comisiones', key: 'count', width: 14 },
      { header: 'Valor ($)', key: 'total', width: 16, style: { numFmt: money } },
    ];
    byUser.forEach((u) => s1.addRow({ userName: u.userName, count: u.count, total: +Number(u.total).toFixed(2) }));
    const t1 = s1.addRow({ userName: 'TOTAL', count: filtered.length, total: +Number(total).toFixed(2) });
    t1.eachCell((c) => { c.font = { bold: true }; });
    styleHeader(s1);

    // Hoja 2 — Detalle (con Nº de factura)
    const s2 = wb.addWorksheet('Detalle', { views: [{ state: 'frozen', ySplit: 1 }] });
    s2.columns = [
      { header: 'Fecha', key: 'date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
      { header: 'Factura', key: 'invoiceNumber', width: 16 },
      { header: 'Usuario', key: 'userName', width: 28 },
      { header: 'Rol', key: 'role', width: 16 },
      { header: 'Regla', key: 'ruleName', width: 26 },
      { header: 'Servicio', key: 'service', width: 26 },
      { header: 'Paciente', key: 'patient', width: 26 },
      { header: 'Origen', key: 'source', width: 16 },
      { header: 'Valor ($)', key: 'amount', width: 14, style: { numFmt: money } },
    ];
    [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date)).forEach((d) => s2.addRow({
      date: d.date ? new Date(d.date) : null,
      invoiceNumber: d.invoiceNumber || '',
      userName: d.userName,
      role: ROLE_LABELS[d.userRole] || d.userRole || '',
      ruleName: d.ruleName, service: d.service, patient: d.patient, source: d.source,
      amount: +Number(d.amount || 0).toFixed(2),
    }));
    const t2 = s2.addRow({ patient: 'TOTAL', amount: +Number(total).toFixed(2) });
    t2.eachCell((c) => { c.font = { bold: true }; });
    styleHeader(s2);

    const fname = `comisiones_${start || ''}_${end || ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ message: 'Error al exportar comisiones', error: e.message });
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
