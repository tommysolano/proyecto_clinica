const CommissionRule = require('../models/CommissionRule');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const CommissionPosting = require('../models/CommissionPosting');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ClinicalRecord = require('../models/ClinicalRecord');
const Sale = require('../models/Sale');
const Referral = require('../models/Referral');
const { createEntry, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { DOCTOR_SPECIALTY_ROLES } = require('../constants/roles');
const ExcelJS = require('exceljs');

const ROLE_LABELS = { admin: 'Administrador', doctor: 'Médico', optica: 'Óptica', ginecologia: 'Ginecología', podologia: 'Podología', odontologia: 'Odontología', odontologia_neurofocal: 'Odontología Neurofocal', cosmetologia: 'Cosmetología', cardiologia: 'Cardiología', terapeuta: 'Terapeuta', nurse: 'Enfermero/a', call_center: 'Call center', marketing: 'Marketing', contabilidad: 'Contabilidad' };

// Especialidades que heredan una regla escrita para el rol 'doctor' (ver matchTarget).
//
// Sale de la lista central de especialidades para que una nueva herede sola: esta
// lista estaba escrita a mano y 'cardiologia' se quedó fuera al crearse, así que
// una regla "para los doctores" no le pagaba. 'optica' se descuenta a propósito
// (ver matchTarget).
const DOCTOR_RULE_HEIRS = DOCTOR_SPECIALTY_ROLES.filter((r) => r !== 'optica');

// ─────────── CRUD de reglas ───────────

/**
 * Deja coherentes los campos que admiten VARIOS valores con su versión singular.
 *
 * Una regla puede nombrar varias personas (`users`), varias condiciones (`triggers`) y
 * varios servicios (`services`). El campo singular se conserva porque lo leen las reglas
 * antiguas, los listados y los reportes; aquí se sincroniza con el PRIMER elemento para
 * que nunca digan cosas distintas (una regla con `users: [A, B]` y `user: C` sería una
 * trampa esperando a que alguien lea el campo equivocado).
 */
const normalizeRuleBody = (body = {}) => {
  const out = { ...body };
  const lista = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  const unicos = (arr) => [...new Set(arr)];

  if (out.targetType === 'role') {
    out.users = [];
    out.user = null;
  } else if ('users' in out || 'user' in out) {
    const users = unicos(lista(out.users).length ? lista(out.users) : lista([out.user]));
    out.users = users;
    out.user = users[0] || null;
  }

  if ('triggers' in out || 'trigger' in out) {
    const triggers = unicos(lista(out.triggers).length ? lista(out.triggers) : lista([out.trigger]));
    out.triggers = triggers;
    out.trigger = triggers[0] || 'appointment_performed';
  }

  if ('services' in out || 'service' in out) {
    const services = unicos(lista(out.services).length ? lista(out.services) : lista([out.service]));
    out.services = services;
    out.service = services[0] || null;
  }
  return out;
};

exports.listRules = async (req, res) => {
  try {
    const rules = await CommissionRule.find({ clinic: req.clinicId })
      .populate('user users', 'name')
      .populate('service services', 'name')
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
      ...normalizeRuleBody(req.body),
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
      normalizeRuleBody(req.body),
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

// Una regla puede tener VARIAS condiciones, VARIAS personas y VARIOS servicios. Los
// lectores viven en el modelo para que exista una sola interpretación del dato.
const { ruleTriggers, ruleUsers, ruleServices } = CommissionRule;
/** ¿La regla se devenga por este evento? */
const hasTrigger = (rule, trigger) => ruleTriggers(rule).includes(trigger);

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
    // Los turnos, para pagar a TODOS los que atendieron. `attendedByNurse` es un
    // espejo del último turno de enfermería: con dos enfermeras en un mismo
    // detox, pagar solo por el espejo dejaba a una sin cobrar lo que hizo.
    .populate('turns.user', 'name clinics')
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

  // Coincidencia de target (personas o rol) entre una regla y un performer.
  const matchTarget = (rule, performer, performerRole) => {
    if (!performer) return false;
    if (rule.targetType === 'user') return ruleUsers(rule).includes(String(performer._id));
    if (rule.role === performerRole) return true;
    // Las especialidades médicas heredan las reglas por rol 'doctor'.
    // 'optica' queda FUERA a propósito: siempre tuvo sus propias reglas y
    // meterla aquí cambiaría lo que ya se está pagando hoy.
    if (rule.role === 'doctor' && DOCTOR_RULE_HEIRS.includes(performerRole)) return true;
    return false;
  };

  /** ¿Este producto entra en la lista de servicios de la regla? (lista vacía = cualquiera). */
  const matchService = (rule, productId) => {
    const svcs = ruleServices(rule);
    return !svcs.length || svcs.includes(String(productId));
  };

  // ¿La cita incluye un servicio que la regla exige? (filtro a nivel de cita).
  const apptHasRuleService = (rule, appt) => {
    const svcs = appt.services || [];
    if (rule.serviceAmounts?.length) {
      return svcs.some((s) => rule.serviceAmounts.some((sa) => String(sa.service) === String(s.product)));
    }
    const permitidos = ruleServices(rule);
    if (permitidos.length) return svcs.some((s) => permitidos.includes(String(s.product)));
    return true;
  };

  const detail = [];
  for (const appt of appts) {
    const isCompleted = appt.status === 'completada';
    const isAttended = appt.status === 'asistida' || isCompleted;
    const services = appt.services?.length ? appt.services : [{ product: null, name: '—', price: 0 }];
    /**
     * Quién atendió, para pagarle. Se recorren los TURNOS de enfermería y no
     * solo `attendedByNurse`: ese campo es un espejo del último turno, así que
     * en un detox atendido por dos enfermeras la primera se quedaba sin cobrar
     * su parte. Con `Set` por id para no pagar dos veces a quien tuvo dos turnos.
     */
    const enfermeros = (appt.turns || [])
      .filter((t) => t.kind === 'enfermeria' && t.user && t.status === 'completado')
      .map((t) => t.user);
    const performers = [];
    const vistos = new Set();
    for (const p of [appt.doctor, appt.attendedByNurse, ...enfermeros]) {
      const id = p && String(p._id || p);
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      performers.push(p);
    }
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
          if (!matchService(rule, svc.product)) continue;
          cfg = { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        }

        if (hasTrigger(rule, 'admin_service')) {
          if (!isCompleted) continue;
          const targets =
            rule.targetType === 'user'
              ? ruleUsers(rule).map((id) => clinicUsersById.get(id)).filter(Boolean)
              : adminUsers;
          for (const adm of targets) {
            detail.push({
              userId: String(adm._id), userName: adm.name, userRole: roleFor(adm) || 'admin',
              ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
              amount: calcAmount(cfg, svc.price), date: appt.date,
              service: svc.name || '—', patient: patientName, source: 'servicio atendido', apptId: String(appt._id),
            });
          }
        }
        // `if` aparte, no `else if`: una regla puede llevar VARIAS condiciones y pagar
        // por las dos (p. ej. al admin por servicio atendido y al doctor que lo atiende).
        if (hasTrigger(rule, 'appointment_performed')) {
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
        if (!hasTrigger(rule, 'appointment_created')) continue;
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
        if (!hasTrigger(rule, 'referral')) continue;
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
        // Una regla puede pagar por vender Y por recomendar: se evalúan las dos.
        const porVenta = hasTrigger(rule, 'sale');
        const porRecomendacion = hasTrigger(rule, 'recommendation');
        if (!porVenta && !porRecomendacion) continue;
        // Filtro de servicio + config de monto.
        let cfg;
        if (rule.serviceAmounts?.length) {
          cfg = amountConfigFor(rule, it.product);
          if (!cfg) continue;
        } else {
          if (!matchService(rule, it.product)) continue;
          cfg = { amountType: rule.amountType || 'fixed', amount: num(rule.amount), percent: num(rule.percent) };
        }
        const qty = num(it.quantity) || 1;
        // Precio que paga el paciente por la línea (incluye impuestos y cantidad).
        const linePaid = num(it.lineTotal) || num(it.subtotal);
        const candidatos = [
          porVenta && { performer: sale.createdBy, source: 'venta' },
          porRecomendacion && { performer: sale.recommendedBy, source: 'recomendación' },
        ].filter(Boolean);
        for (const { performer, source } of candidatos) {
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
  }

  // ─── Comisión del MARKETING ligado a un call center ───
  // Depende de las comisiones del call center ya calculadas arriba (source
  // 'cita agendada'). El marketing gana % sobre lo que devengó su agente, o un
  // monto fijo por cada comisión generada por ese agente.
  for (const rule of rules) {
    if (!hasTrigger(rule, 'call_center_commission') || !rule.linkedCallCenter) continue;
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
        ? ruleUsers(rule).map((id) => clinicUsersById.get(id)).filter(Boolean)
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

// ─────────── Resumen de atenciones por doctor (solo super-admin) ───────────

/** 'a,b,c' → ['a','b','c'] (trim, sin vacíos). */
const parseList = (v) =>
  String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const ESTADOS_CITA = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'];

/** Query compartida por el resumen por doctor y su detalle de citas. */
async function construirQueryResumen(req) {
  const { start, end, doctor, status, service, clinic } = req.query;
  const { startDate, endDate } = parseRange(start, end);

  const query = { date: { $gte: startDate, $lte: endDate } };
  if (clinic === 'all') {
    // 'all' = todas las sucursales
  } else {
    query.clinic = clinic || req.clinicId;
  }

  const doctores = parseList(doctor);
  if (doctores.length === 1) query.doctor = doctores[0];
  else if (doctores.length > 1) query.doctor = { $in: doctores };

  const estados = parseList(status);
  query.status = { $in: estados.length ? estados : ['asistida', 'completada'] };

  const servicios = parseList(service);
  if (servicios.length) {
    const items = await AppointmentServiceItem.find({ _id: { $in: servicios } }).select('name').lean();
    const nombreDe = new Map(items.map((n) => [String(n._id), n.name]));
    query.$or = servicios.flatMap((id) => [
      { serviceItem: id },
      ...(nombreDe.has(id) ? [{ serviceName: nombreDe.get(id) }] : []),
      { 'services.product': id },
      { 'additionalServices.serviceItem': id },
    ]);
  }

  return { query, estados, startDate, endDate };
}

exports.doctorSummary = async (req, res) => {
  try {
    const { query, estados, startDate, endDate } = await construirQueryResumen(req);

    const appts = await Appointment.find(query)
      .populate('doctor', 'name specialty')
      .populate('clinic', 'name nombreComercial')
      .lean();

    const ESTADOS = ESTADOS_CITA;
    const byDoctor = new Map();
    for (const appt of appts) {
      const doc = appt.doctor;
      if (!doc || !doc.name) continue;
      const id = String(doc._id);
      let fila = byDoctor.get(id);
      if (!fila) {
        fila = {
          doctorId: id,
          name: doc.name,
          specialty: doc.specialty || '',
          clinics: new Set(),
          total: 0,
          byStatus: Object.fromEntries(ESTADOS.map((s) => [s, 0])),
          services: [],
        };
        byDoctor.set(id, fila);
      }
      fila.total += 1;
      const nombreSucursal = appt.clinic?.nombreComercial || appt.clinic?.name;
      if (nombreSucursal) fila.clinics.add(nombreSucursal);
      if (fila.byStatus[appt.status] != null) fila.byStatus[appt.status] += 1;

      const apptStatus = appt.status;
      const nombresServicios = [
        appt.serviceName,
        ...(appt.additionalServices || []).map((s) => s.name),
        ...(appt.services || []).map((s) => s.name),
      ].filter(Boolean);
      const vistos = new Set();
      for (const nombre of nombresServicios) {
        if (!nombre || vistos.has(nombre)) continue;
        vistos.add(nombre);
        let svc = fila.services.find((s) => s.name === nombre);
        if (!svc) {
          svc = { name: nombre, count: 0 };
          fila.services.push(svc);
        }
        svc.count += 1;
        if (svc.byStatus == null) svc.byStatus = {};
        svc.byStatus[apptStatus] = (svc.byStatus[apptStatus] || 0) + 1;
      }
    }

    const doctors = [...byDoctor.values()]
      .map((f) => ({ ...f, clinics: [...f.clinics] }))
      .sort((a, b) => b.total - a.total);
    const totals = Object.fromEntries(ESTADOS.map((s) => [s, 0]));
    for (const fila of doctors) {
      for (const s of ESTADOS) totals[s] += fila.byStatus[s] || 0;
    }

    res.json({
      start: startDate,
      end: endDate,
      statuses: estados.length ? estados : ESTADOS,
      doctors,
      totals: { total: appts.length, byStatus: totals },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular el resumen por doctor', error: e.message });
  }
};

/**
 * DETALLE de las citas del resumen: una fila por cita con paciente, quién atendió
 * (turnos: puede ser más de un doctor), valor/pago (canje, abono, venta) y lo que
 * el doctor escribió en seguimientos (sueros y demás receta). Mismos filtros que
 * `doctorSummary` (start/end/clinic/doctor/status/service).
 */
exports.doctorAppointments = async (req, res) => {
  try {
    const { query, startDate, endDate } = await construirQueryResumen(req);

    const appts = await Appointment.find(query)
      .populate('patient', 'firstName lastName')
      .populate('doctor', 'name')
      .populate('turns.user', 'name')
      .populate('attendedByNurse', 'name')
      .populate('clinic', 'name nombreComercial')
      .sort({ date: 1, startTime: 1 })
      .lean();

    // Ventas ligadas: para decir CUÁNDO se pagó la cita y con qué número.
    const ids = appts.map((a) => a._id);
    const ventas = ids.length
      ? await Sale.find({ appointment: { $in: ids }, status: { $ne: 'anulada' } })
          .select('appointment saleNumber total createdAt')
          .lean()
      : [];
    const ventaDe = new Map(ventas.map((v) => [String(v.appointment), v]));

    // Seguimientos de los turnos (ahí vive la receta y los sueros recetados).
    const followUpIds = [];
    for (const a of appts) {
      for (const t of a.turns || []) if (t.followUp) followUpIds.push(t.followUp);
      if (a.autoSerumFollowUp) followUpIds.push(a.autoSerumFollowUp);
    }
    let parteDe = new Map();
    if (followUpIds.length) {
      const partes = await ClinicalRecord.aggregate([
        { $match: { 'followUps._id': { $in: followUpIds } } },
        { $unwind: '$followUps' },
        { $match: { 'followUps._id': { $in: followUpIds } } },
        {
          $project: {
            parte: {
              id: '$followUps._id',
              kind: '$followUps.kind',
              motivoConsulta: '$followUps.motivoConsulta',
              sueros: {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$followUps.recetaItems', []] },
                    as: 'it',
                    cond: { $eq: ['$$it.isSerum', true] },
                  },
                },
              },
              otros: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$followUps.recetaItems', []] },
                      as: 'it',
                      cond: { $ne: ['$$it.isSerum', true] },
                    },
                  },
                  as: 'it',
                  in: '$$it.name',
                },
              },
            },
          },
        },
      ]);
      parteDe = new Map(partes.map((p) => [String(p.parte.id), p.parte]));
    }

    // Visitas repetidas: cuántas veces atendió este doctor AL MISMO paciente.
    // Se cuenta DENTRO del resultado (las citas que pasaron los filtros).
    const visitasPaciente = new Map();
    for (const a of appts) {
      const pid = a.patient?._id ? String(a.patient._id) : null;
      const did = a.doctor?._id ? String(a.doctor._id) : null;
      if (!pid || !did) continue;
      const key = `${pid}|${did}`;
      if (!visitasPaciente.has(key)) visitasPaciente.set(key, []);
      visitasPaciente.get(key).push(a);
    }
    const visitaDe = new Map();
    for (const citas of visitasPaciente.values()) {
      citas.sort((x, y) => new Date(x.date) - new Date(y.date));
      citas.forEach((a, i) => { visitaDe.set(String(a._id), { numero: i + 1, total: citas.length }); });
    }

    // Derivaciones AÑADIDAS por los doctores del resultado, en el mismo rango.
    const doctorIds = [...new Set(appts.filter((a) => a.doctor).map((a) => String(a.doctor._id || a.doctor)))];
    let derivaciones = [];
    if (doctorIds.length) {
      const filtroDeriva = { fromDoctor: { $in: doctorIds }, date: { $gte: startDate, $lte: endDate } };
      if (query.clinic) filtroDeriva.clinic = query.clinic;
      derivaciones = await Referral.find(filtroDeriva)
        .populate('patient', 'firstName lastName')
        .populate('toDoctor', 'name')
        .select('fromDoctor patient toDoctor specialty status date reason')
        .lean();
    }
    const derivacionesPorDoctor = new Map();
    for (const d of derivaciones) {
      const did = String(d.fromDoctor);
      if (!derivacionesPorDoctor.has(did)) derivacionesPorDoctor.set(did, []);
      derivacionesPorDoctor.get(did).push({
        id: String(d._id),
        patient: d.patient ? `${d.patient.firstName} ${d.patient.lastName}` : '—',
        toDoctor: d.toDoctor?.name || '',
        specialty: d.specialty || '',
        status: d.status,
        date: d.date,
        reason: d.reason || '',
      });
    }

    const appointments = appts.map((a) => {
      const pid = a.patient?._id ? String(a.patient._id) : null;
      const did = a.doctor?._id ? String(a.doctor._id) : null;
      const visit = pid && did ? visitaDe.get(String(a._id)) : null;
      const atendientes = (a.turns || [])
        .filter((t) => t.user)
        .map((t) => ({
          kind: t.kind,
          name: t.user?.name || '—',
          status: t.status,
          serviceName: t.serviceName || '',
        }));
      if (a.attendedByNurse && !(a.turns || []).some((t) => String(t.user?._id) === String(a.attendedByNurse._id))) {
        atendientes.push({ kind: 'enfermeria', name: a.attendedByNurse.name, status: '', serviceName: '' });
      }
      const doctoresTurno = (a.turns || []).filter((t) => t.kind === 'doctor' && t.user);
      const seguimientos = (a.turns || [])
        .filter((t) => t.followUp && parteDe.has(String(t.followUp)))
        .map((t) => parteDe.get(String(t.followUp)));
      const venta = ventaDe.get(String(a._id));
      return {
        id: String(a._id),
        date: a.date,
        startTime: a.startTime,
        patientId: pid,
        patient: a.patient ? `${a.patient.firstName} ${a.patient.lastName}` : '—',
        status: a.status,
        clinic: a.clinic?.nombreComercial || a.clinic?.name || '',
        services: [
          a.serviceName,
          ...(a.additionalServices || []).map((s) => s.name),
          ...(a.services || []).map((s) => s.name),
        ].filter(Boolean),
        atendientes,
        multiprofesional: doctoresTurno.length > 1,
        visitNumber: visit?.numero || null,
        visitsTotal: visit?.total || null,
        payment: {
          agreedValue: a.agreedValue,
          isCanje: a.isCanje,
          advancePayment: a.advancePayment || '',
          advanceAmount: a.advanceAmount,
          advanceMethod: a.advanceMethod || '',
          valueSetAt: a.valueSetAt,
        },
        venta: venta
          ? { number: venta.saleNumber || '', total: venta.total, date: venta.createdAt }
          : null,
        seguimientos,
      };
    });

    const doctorNames = {};
    for (const a of appts) {
      if (a.doctor?._id) doctorNames[String(a.doctor._id)] = a.doctor.name;
    }

    res.json({
      start: startDate,
      end: endDate,
      appointments,
      doctorNames,
      referralsByDoctor: Object.fromEntries(derivacionesPorDoctor),
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener el detalle de citas', error: e.message });
  }
};

/**
 * Resumen de AGENDAMIENTOS por agente de call center: cuántas citas agendó cada
 * uno y de esas cuántas fueron para pacientes NUEVOS y cuántas para
 * RECURRENTES. Mismo alcance de fechas/sucursal que el resumen por doctor.
 */
exports.callCenterSummary = async (req, res) => {
  try {
    const { start, end, clinic } = req.query;
    const { startDate, endDate } = parseRange(start, end);

    const query = { date: { $gte: startDate, $lte: endDate } };
    if (clinic === 'all') {
      // 'all' = todas las sucursales
    } else {
      query.clinic = clinic || req.clinicId;
    }

    const agentes = await User.find({
      active: true,
      ...(clinic === 'all'
        ? { 'clinics.role': 'call_center' }
        : User.enSucursal(clinic || req.clinicId, ['call_center'])),
    })
      .select('name clinics worksInAllClinics')
      .lean();
    const idsAgentes = agentes.map((a) => String(a._id));

    const appts = idsAgentes.length
      ? await Appointment.find({ ...query, createdBy: { $in: idsAgentes } })
          .populate('clinic', 'name nombreComercial')
          .select('createdBy isFirstVisit clinic')
          .lean()
      : [];

    const porAgente = new Map();
    for (const a of appts) {
      const id = String(a.createdBy?._id || a.createdBy);
      let fila = porAgente.get(id);
      if (!fila) {
        fila = { total: 0, nuevos: 0, recurrentes: 0, clinics: new Set() };
        porAgente.set(id, fila);
      }
      fila.total += 1;
      if (a.isFirstVisit) fila.nuevos += 1;
      else fila.recurrentes += 1;
      const nombreSucursal = a.clinic?.nombreComercial || a.clinic?.name;
      if (nombreSucursal) fila.clinics.add(nombreSucursal);
    }

    const agents = agentes
      .map((a) => {
        const f = porAgente.get(String(a._id)) || { total: 0, nuevos: 0, recurrentes: 0, clinics: [] };
        return {
          userId: String(a._id),
          name: a.name,
          clinics: f.clinics instanceof Set ? [...f.clinics] : (f.clinics || []),
          total: f.total,
          nuevos: f.nuevos,
          recurrentes: f.recurrentes,
        };
      })
      .sort((a, b) => b.total - a.total);

    res.json({
      start: startDate,
      end: endDate,
      agents,
      totals: {
        total: appts.length,
        nuevos: agents.reduce((t, a) => t + a.nuevos, 0),
        recurrentes: agents.reduce((t, a) => t + a.recurrentes, 0),
      },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular el resumen de call center', error: e.message });
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
