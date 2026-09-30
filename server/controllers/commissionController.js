const CommissionRule = require('../models/CommissionRule');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const CommissionPosting = require('../models/CommissionPosting');
const CommissionAdjustment = require('../models/CommissionAdjustment');
const CommissionPayout = require('../models/CommissionPayout');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ClinicalRecord = require('../models/ClinicalRecord');
const Sale = require('../models/Sale');
const Referral = require('../models/Referral');
const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');
const { normalizePhone } = require('../utils/phoneNormalize');
const { citasConHistoriaPrevia } = require('../utils/firstVisit');
const { createEntry, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { DOCTOR_SPECIALTY_ROLES, DOCTOR_LIKE_ROLES } = require('../constants/roles');
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
    // Las reglas doctor-servicio se editan en Comisiones > Doctores. Ocultarlas
    // aquí evita que aparezcan duplicadas en los dos editores.
    const rules = await CommissionRule.find({
      clinic: req.clinicId,
      managedFromDoctorCommissions: { $ne: true },
    })
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

/** Guarda una regla administrada desde Comisiones > Doctores. */
const saveManagedDoctorRule = async (req, res, scope) => {
  try {
    const { doctor, amountType = 'fixed', active = true } = req.body || {};
    const isPatientRule = scope === 'patient';
    const isReferralRule = scope === 'referral';
    // La derivación admite tarifa por servicio derivado o base (sin servicio).
    const service = isPatientRule ? null : (req.body?.service || null);
    const sinServicio = isPatientRule || (isReferralRule && !service);
    // «Solo la primera vez» es de las tarifas por servicio atendido.
    const firstTimeOnly = scope === 'service' && req.body?.firstTimeOnly === true;
    const rawValue = req.body?.value;
    const value = Number(rawValue);
    const clinicIds = [...new Set(
      (Array.isArray(req.body?.clinics) && req.body.clinics.length
        ? req.body.clinics
        : [req.body?.clinic || req.clinicId])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    )];

    if (!mongoose.isValidObjectId(doctor) || (!sinServicio && !mongoose.isValidObjectId(service))) {
      return res.status(400).json({ message: 'Doctor o servicio no válido' });
    }
    if (!clinicIds.length) return res.status(400).json({ message: 'Selecciona al menos una sucursal' });
    if (!['fixed', 'percent'].includes(amountType)) {
      return res.status(400).json({ message: 'El tipo de comisión no es válido' });
    }
    if (active !== false && (!Number.isFinite(value) || value < 0 || (amountType === 'percent' && value > 100))) {
      return res.status(400).json({ message: amountType === 'percent' ? 'El porcentaje debe estar entre 0 y 100' : 'El monto debe ser mayor o igual a cero' });
    }

    // Tarifas por horario: el mismo servicio paga distinto en la mañana y en la
    // tarde. Se validan aquí para que el cálculo nunca dude qué tarifa aplica.
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const timeBands = [];
    for (const b of Array.isArray(req.body?.timeBands) ? req.body.timeBands : []) {
      const startTime = String(b?.startTime || '').slice(0, 5);
      const endTime = String(b?.endTime || '').slice(0, 5);
      const bType = b?.amountType === 'percent' ? 'percent' : 'fixed';
      const bValue = Number(b?.value);
      if (!HHMM.test(startTime) || !HHMM.test(endTime)) {
        return res.status(400).json({ message: 'Cada horario necesita hora de inicio y de fin (HH:MM)' });
      }
      if (startTime >= endTime) {
        return res.status(400).json({ message: `El horario ${startTime}–${endTime} termina antes de empezar` });
      }
      if (!Number.isFinite(bValue) || bValue < 0 || (bType === 'percent' && bValue > 100)) {
        return res.status(400).json({ message: `El valor del horario ${startTime}–${endTime} no es válido` });
      }
      timeBands.push({
        startTime, endTime, amountType: bType,
        amount: bType === 'fixed' ? bValue : 0,
        percent: bType === 'percent' ? bValue : 0,
      });
    }
    timeBands.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < timeBands.length; i += 1) {
      if (timeBands[i].startTime < timeBands[i - 1].endTime) {
        return res.status(400).json({
          message: `Los horarios ${timeBands[i - 1].startTime}–${timeBands[i - 1].endTime} y ${timeBands[i].startTime}–${timeBands[i].endTime} se cruzan`,
        });
      }
    }

    const [doctorDoc, serviceDoc] = await Promise.all([
      User.findById(doctor).select('name').lean(),
      sinServicio ? null : AppointmentServiceItem.findById(service).select('name').lean(),
    ]);
    if (!doctorDoc) return res.status(404).json({ message: 'Doctor no encontrado' });
    if (!sinServicio && !serviceDoc) return res.status(404).json({ message: 'Servicio no encontrado' });

    // El ALCANCE es parte de la identidad: la base por paciente y la base por
    // derivación comparten `appointmentService: null` y no deben pisarse.
    const identity = {
      doctorServiceDoctor: doctor,
      appointmentService: sinServicio ? null : service,
      managedFromDoctorCommissions: true,
      doctorCommissionScope: scope,
    };
    const trigger = isReferralRule ? 'referral' : 'appointment_performed';
    let nombre = `${doctorDoc.name} · ${serviceDoc?.name || ''}`;
    if (isPatientRule) nombre = `${doctorDoc.name} · Paciente atendido`;
    else if (isReferralRule) nombre = `${doctorDoc.name} · Derivación${serviceDoc ? ` a ${serviceDoc.name}` : ''}`;
    if (active === false) {
      await CommissionRule.deleteMany({ ...identity, clinic: { $in: clinicIds } });
      return res.json({ active: false, clinics: clinicIds });
    }

    const saved = [];
    for (const clinicId of clinicIds) {
      const rule = await CommissionRule.findOneAndUpdate(
        { ...identity, clinic: clinicId },
        {
          $set: {
            clinic: clinicId,
            name: nombre,
            active: true,
            targetType: 'user',
            user: doctor,
            users: [doctor],
            role: '',
            trigger,
            triggers: [trigger],
            service: null,
            services: [],
            serviceAmounts: [],
            appointmentService: sinServicio ? null : service,
            doctorServiceDoctor: doctor,
            managedFromDoctorCommissions: true,
            doctorCommissionScope: scope,
            firstTimeOnly,
            timeBands,
            amountType,
            amount: amountType === 'fixed' ? value : 0,
            percent: amountType === 'percent' ? value : 0,
            patientScope: 'all',
            scheduleEnabled: false,
            daysOfWeek: [],
            startTime: '',
            endTime: '',
            createdBy: req.user._id,
          },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
      ).lean();
      saved.push(rule);
    }
    res.json({ active: true, amountType, value, firstTimeOnly, timeBands, clinics: clinicIds, rules: saved });
  } catch (e) {
    const status = e?.code === 11000 ? 409 : 500;
    res.status(status).json({
      message: status === 409
        ? 'Ya existe una configuración para este doctor'
        : 'Error al guardar la comisión',
      error: e.message,
    });
  }
};

/** Comisión prioritaria por servicio de Agenda. */
exports.saveDoctorServiceRule = (req, res) => saveManagedDoctorRule(req, res, 'service');

/** Comisión base por paciente, usada solo cuando la cita no comisiona por servicio. */
exports.saveDoctorPatientRule = (req, res) => saveManagedDoctorRule(req, res, 'patient');

/**
 * Comisión por DERIVACIÓN: el doctor gana cuando el paciente SE REALIZA la cita
 * a la que lo derivó. Con `service`, solo por las derivaciones a ese servicio;
 * sin él, la base para cualquier derivación sin tarifa propia.
 */
exports.saveDoctorReferralRule = (req, res) => saveManagedDoctorRule(req, res, 'referral');

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

const normalizeServiceName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

/** Importe monetario representado por la columna Pago de una cita. */
const appointmentPaymentValue = (appt) => {
  if (appt?.isCanje) return 0;
  if (appt?.agreedValue != null) return num(appt.agreedValue);
  // El adelanto solo se usa cuando aún no existe un valor total acordado; de
  // otro modo se contaría dos veces una parte del mismo cobro.
  if (['abono', 'total'].includes(appt?.advancePayment)) return num(appt.advanceAmount);
  return 0;
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

  const appointmentServiceIds = [...new Set(
    rules.filter((r) => r.appointmentService).map((r) => String(r.appointmentService))
  )];
  const appointmentServiceDocs = appointmentServiceIds.length
    ? await AppointmentServiceItem.find({ _id: { $in: appointmentServiceIds } }).select('name').lean()
    : [];
  const appointmentServiceNameById = new Map(
    appointmentServiceDocs.map((s) => [String(s._id), normalizeServiceName(s.name)])
  );
  const matchesAppointmentService = (rule, svc) => {
    if (!rule.appointmentService || svc?.sourceType !== 'appointment') return false;
    const ruleServiceId = String(rule.appointmentService);
    if (svc.appointmentService && String(svc.appointmentService) === ruleServiceId) return true;
    return !svc.appointmentService
      && !!svc.normalizedName
      && svc.normalizedName === appointmentServiceNameById.get(ruleServiceId);
  };

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

  // «Solo la primera vez»: se consulta el historial del paciente solo si alguna
  // regla lo pide (ver detectorPrimeraVez).
  const esPrimeraVez = rules.some((r) => r.firstTimeOnly)
    ? await detectorPrimeraVez(appts.filter((a) => a.status === 'completada'), await catalogoServicios())
    : () => true;
  const esAlcance = (rule, scope) => rule.managedFromDoctorCommissions && (rule.doctorCommissionScope || 'service') === scope;

  const detail = [];
  for (const appt of appts) {
    // Una cita de CANJE no genera comisión para nadie (sep-2026): el paciente no
    // pagó, se cambió por otra cosa. Ver también calcularComisionesDoctores.
    if (appt.isCanje) continue;
    const isCompleted = appt.status === 'completada';
    const isAttended = appt.status === 'asistida' || isCompleted;
    const legacyServices = appt.services?.length
      ? appt.services.map((s) => ({
          product: s.product,
          name: s.name,
          price: s.price,
          sourceType: 'product',
        }))
      : [{ product: null, name: '—', price: 0, sourceType: 'product' }];
    const paidValue = appointmentPaymentValue(appt);
    const agendaServices = [];
    const agendaSeen = new Set();
    const addAgendaService = (serviceId, name) => {
      const id = serviceId ? String(serviceId) : '';
      const normalizedName = normalizeServiceName(name);
      const key = id || normalizedName;
      if (!key || agendaSeen.has(key)) return;
      agendaSeen.add(key);
      agendaServices.push({
        appointmentService: id || null,
        normalizedName,
        name: name || '—',
        price: paidValue,
        sourceType: 'appointment',
      });
    };
    addAgendaService(appt.serviceItem, appt.serviceName);
    for (const extra of appt.additionalServices || []) addAgendaService(extra.serviceItem, extra.name);
    const services = [...legacyServices, ...agendaServices];
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

        // La regla base por paciente se evalúa una sola vez después de los
        // servicios, donde también se aplica la prioridad anti-doble-pago. Las
        // de derivación, en el bloque de derivaciones.
        if (esAlcance(rule, 'patient') || esAlcance(rule, 'referral')) continue;

        // Filtro de servicio + config de monto.
        let cfg;
        if (rule.appointmentService) {
          if (!matchesAppointmentService(rule, svc)) continue;
          // Tarifa de Comisiones > Doctores: puede cambiar según el horario de la cita.
          cfg = cfgDeRegla(rule, appt);
        } else if (svc.sourceType === 'appointment') {
          // Las reglas generales apuntan a productos de inventario, no al
          // catálogo operativo de Agenda.
          continue;
        } else if (rule.serviceAmounts?.length) {
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
          // Tarifa de «solo la primera vez» y el paciente ya lo había recibido: no paga.
          if (rule.firstTimeOnly && !esPrimeraVez(appt, svc.normalizedName || normalizeServiceName(svc.name))) continue;
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

    // Comisión BASE POR PACIENTE: se paga una sola vez por cita completada y
    // solamente si para ese doctor no aplica ninguna comisión de servicio en
    // esta misma cita. Así una configuración de servicio reemplaza a la base en
    // vez de sumarse a ella.
    if (isCompleted) {
      const patientRules = rules.filter((r) =>
        r.managedFromDoctorCommissions && r.doctorCommissionScope === 'patient'
      );
      for (const performer of performers) {
        const performerRole = roleFor(performer);
        const hasSpecificServiceCommission = rules.some((r) =>
          esAlcance(r, 'service')
          && !!r.appointmentService
          && matchTarget(r, performer, performerRole)
          && inSchedule(r, appt)
          && agendaServices.some((svc) => matchesAppointmentService(r, svc))
        );
        if (hasSpecificServiceCommission) continue;

        for (const rule of patientRules) {
          if (rule.patientScope === 'new' && !appt.isFirstVisit) continue;
          if (!inSchedule(rule, appt) || !matchTarget(rule, performer, performerRole)) continue;
          const cfg = cfgDeRegla(rule, appt);
          detail.push({
            userId: String(performer._id), userName: performer.name, userRole: performerRole,
            ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
            amount: calcAmount(cfg, paidValue), date: appt.date,
            service: 'Paciente atendido', patient: patientName, source: 'paciente atendido', apptId: String(appt._id),
          });
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

    // ── Tarifa de DERIVACIÓN de Comisiones > Doctores: la del servicio derivado
    // si existe, si no la base del doctor. Sobre lo que pagó el paciente. ──
    if (isCompleted && appt.referral?.fromDoctor) {
      const fromDoc = appt.referral.fromDoctor;
      const propias = rules.filter((r) => esAlcance(r, 'referral')
        && String(r.doctorServiceDoctor) === String(fromDoc._id));
      const rule = propias.find((r) => r.appointmentService && agendaServices.some((svc) => matchesAppointmentService(r, svc)))
        || propias.find((r) => !r.appointmentService);
      if (rule) {
        detail.push({
          userId: String(fromDoc._id), userName: fromDoc.name, userRole: roleFor(fromDoc),
          ruleName: rule.name, ruleId: String(rule._id), ruleAccount: rule.account || null,
          amount: calcAmount(cfgDeRegla(rule, appt), paidValue), date: appt.date,
          service: appt.serviceName || appt.services?.[0]?.name || '—', patient: patientName, source: 'derivación', apptId: String(appt._id),
        });
      }
    }

    // ── Comisión por DERIVACIÓN: una vez por cita derivada completada ──
    if (isCompleted && appt.origin === 'referral' && appt.referral?.fromDoctor) {
      const fromDoc = appt.referral.fromDoctor;
      const fromRole = roleFor(fromDoc);
      for (const rule of rules) {
        if (!hasTrigger(rule, 'referral') || rule.managedFromDoctorCommissions) continue;
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
  /**
   * 'YYYY-MM-DD' SE LEE EN HORA LOCAL, no con `new Date(v)` a secas.
   *
   * Ese constructor parsea la fecha como medianoche UTC, y en Ecuador (UTC-5)
   * eso cae el DÍA ANTERIOR a las 19:00: al pedir del 7 al 12, el extremo
   * terminaba siendo el 11 a las 19:00 y el día 12 quedaba fuera del filtro.
   * Aquí se construye la fecha por PARTES en el calendario local, y luego se
   * lleva a los extremos del día local (00:00 / 23:59:59.999).
   */
  const dia = (v) => {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(v);
  };
  const startDate = dia(start) || new Date(Date.now() - 30 * 86400000);
  startDate.setHours(0, 0, 0, 0);
  const endDate = dia(end) || new Date();
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

// ─────────── Núcleo de Comisiones > Doctores ───────────
//
// FUENTE ÚNICA (sep-2026) de lo que gana cada doctor en el módulo del
// superadministrador: el resumen por doctor, el PDF y el registro de pagos
// salen de `calcularComisionesDoctores`. Antes el resumen y el PDF llevaban cada
// uno su propia copia del cálculo, y cualquier regla nueva (primera vez,
// derivaciones, pagado) habría tenido que escribirse dos veces.

const ESTADOS_ATENDIDA = ['asistida', 'completada'];
const esAtendida = (a) => ESTADOS_ATENDIDA.includes(a?.status);
const idDe = (v) => (v ? String(v._id || v) : '');
const nombrePaciente = (p) => (p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() || '—' : '—');
/**
 * El HORARIO de la regla en el que empieza la cita, o null (ver timeBands en el
 * modelo). Rango [inicio, fin): una cita de las 13:00 cae en «13:00–19:00», no en
 * «07:00–13:00». Si dos se solapan manda la primera (al guardar no se permite).
 */
const franjaDeRegla = (rule, appt) => {
  const hora = String(appt?.startTime || '').slice(0, 5);
  if (!hora || !rule?.timeBands?.length) return null;
  return rule.timeBands.find((b) => b.startTime && b.endTime && hora >= b.startTime && hora < b.endTime) || null;
};
const etiquetaFranja = (b) => (b ? `${b.startTime}–${b.endTime}` : '');

/** Tarifa que aplica: la del horario de la cita si cae en uno, si no la general. */
const cfgDeRegla = (rule, appt = null) => {
  const src = franjaDeRegla(rule, appt) || rule;
  return { amountType: src.amountType || 'fixed', amount: num(src.amount), percent: num(src.percent) };
};
const ordenCita = (x, y) =>
  (new Date(x.date) - new Date(y.date))
  || String(x.startTime || '').localeCompare(String(y.startTime || ''))
  || String(x._id).localeCompare(String(y._id));

/** Catálogo de servicios de agenda: nombre por id e id por nombre normalizado. */
async function catalogoServicios() {
  const items = await AppointmentServiceItem.find({}).select('name').lean();
  return {
    nombrePorId: new Map(items.map((s) => [String(s._id), s.name])),
    idPorNombre: new Map(items.map((s) => [normalizeServiceName(s.name), String(s._id)])),
  };
}

/**
 * Servicios de agenda de una cita, sin repetir: el principal, los adicionales y
 * los productos antiguos (por nombre). `key` es el nombre normalizado —con él se
 * compara entre sucursales, donde el mismo servicio tiene ids distintos— e `id`
 * el del catálogo cuando se puede saber (las citas viejas solo guardaron el
 * nombre y se vinculan por él).
 */
const serviciosDeCita = (appt, catalogo) => {
  const lista = [
    { id: appt.serviceItem ? idDe(appt.serviceItem) : null, name: appt.serviceName },
    ...(appt.additionalServices || []).map((s) => ({ id: s.serviceItem ? idDe(s.serviceItem) : null, name: s.name })),
    ...(appt.services || []).map((s) => ({ id: null, name: s.name })),
  ];
  const out = [];
  const vistos = new Set();
  for (const s of lista) {
    const name = s.name || (s.id && catalogo.nombrePorId.get(s.id)) || '';
    const key = normalizeServiceName(name);
    if (!key || vistos.has(key)) continue;
    vistos.add(key);
    out.push({ id: s.id || catalogo.idPorNombre.get(key) || null, name, key });
  }
  return out;
};

/**
 * ¿Es la PRIMERA VEZ que el paciente recibe este servicio en esta cita?
 *
 * Se mira TODO su historial atendido (asistida/completada) hasta la cita más
 * reciente que se consulta, en cualquier sucursal y con cualquier doctor: si ya
 * se hizo el servicio antes, esta cita no es la primera aunque cambie de sede o
 * de profesional. Las citas canceladas o a las que no vino no cuentan: no
 * recibió el tratamiento.
 */
async function detectorPrimeraVez(citas, catalogo) {
  const pacientes = [...new Set(citas.map((a) => idDe(a.patient)).filter(Boolean))];
  if (!pacientes.length) return () => true;
  const hasta = new Date(Math.max(...citas.map((a) => new Date(a.date).getTime())));
  const historial = await Appointment.find({
    patient: { $in: pacientes },
    status: { $in: ESTADOS_ATENDIDA },
    date: { $lte: hasta },
  })
    .select('patient date startTime serviceItem serviceName additionalServices services')
    .lean();
  historial.sort(ordenCita);
  const primera = new Map();
  for (const a of historial) {
    const pid = idDe(a.patient);
    for (const s of serviciosDeCita(a, catalogo)) {
      const k = `${pid}|${s.key}`;
      if (!primera.has(k)) primera.set(k, String(a._id));
    }
  }
  return (appt, key) => {
    const first = primera.get(`${idDe(appt.patient)}|${key}`);
    return !first || first === String(appt._id);
  };
}

const RANGO_DERIVADA = { completada: 5, asistida: 5, confirmada: 4, pendiente: 4, no_asistio: 2, cancelada: 1 };
const estadoDerivada = (cita) => {
  if (!cita) return 'sin_agendar';
  if (esAtendida(cita)) return 'realizada';
  if (cita.status === 'no_asistio') return 'no_asistio';
  if (cita.status === 'cancelada') return 'cancelada';
  return 'agendada';
};
// El vocabulario de la colección Referral, para las pantallas que ya lo usan.
const ESTADO_REFERRAL = { realizada: 'atendida', agendada: 'agendada', sin_agendar: 'pendiente', cancelada: 'cancelada', no_asistio: 'cancelada' };

/**
 * DERIVACIONES QUE INDICARON LOS DOCTORES en estas citas, y si el paciente se
 * las realizó.
 *
 * El doctor deriva desde su seguimiento escogiendo un servicio de la agenda
 * (recetaItems con `isService` + `serviceItem`); mostrador agenda después la cita
 * derivada, que guarda `derivationSource` = la cita donde se indicó. Hasta que
 * mostrador la agenda NO existe registro en Referral, así que la lista sale de
 * los seguimientos: es la única forma de ver las derivaciones que el paciente
 * nunca se hizo.
 *
 * Una fila por (cita de origen, servicio derivado) con la mejor cita derivada
 * encontrada: realizada > agendada > no asistió > cancelada.
 */
async function derivacionesIndicadas(appts, catalogo) {
  if (!appts.length) return [];
  const origenDe = new Map(); // followUp → { appt, user }
  for (const a of appts) {
    for (const t of a.turns || []) {
      if (t.followUp) origenDe.set(String(t.followUp), { appt: a, user: t.user || a.doctor });
    }
  }
  const followUpIds = [...origenDe.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const [partes, derivadas] = await Promise.all([
    followUpIds.length
      ? ClinicalRecord.aggregate([
          { $match: { 'followUps._id': { $in: followUpIds } } },
          { $unwind: '$followUps' },
          { $match: { 'followUps._id': { $in: followUpIds } } },
          {
            $project: {
              id: '$followUps._id',
              fecha: { $ifNull: ['$followUps.fecha', '$followUps.createdAt'] },
              items: {
                $filter: {
                  input: { $ifNull: ['$followUps.recetaItems', []] },
                  as: 'it',
                  cond: { $and: [{ $eq: ['$$it.isService', true] }, { $ne: [{ $ifNull: ['$$it.serviceItem', null] }, null] }] },
                },
              },
            },
          },
        ])
      : [],
    Appointment.find({ derivationSource: { $in: appts.map((a) => a._id) } })
      .select('derivationSource serviceItem serviceName status date startTime clinic doctor')
      .populate('doctor', 'name')
      .populate('clinic', 'name nombreComercial')
      .lean(),
  ]);

  const derivadasDe = new Map();
  for (const d of derivadas) {
    const k = String(d.derivationSource);
    if (!derivadasDe.has(k)) derivadasDe.set(k, []);
    derivadasDe.get(k).push(d);
  }
  const resumenCita = (c) => (c ? {
    id: String(c._id),
    date: c.date,
    startTime: c.startTime || '',
    status: c.status,
    doctor: c.doctor?.name || '',
    clinic: c.clinic?.nombreComercial || c.clinic?.name || '',
  } : null);

  const filas = [];
  const usadas = new Set();
  const fila = (origen, user, name, serviceItem, fecha, cita) => {
    const estado = estadoDerivada(cita);
    filas.push({
      id: `${origen._id}|${serviceItem || normalizeServiceName(name)}`,
      originAppointment: String(origen._id),
      originDate: origen.date,
      fromDoctorId: idDe(user),
      fromDoctor: user?.name || origen.doctor?.name || '',
      patientId: idDe(origen.patient),
      patient: nombrePaciente(origen.patient),
      serviceItem: serviceItem || null,
      service: name || '—',
      date: fecha || origen.date,
      estado,
      status: ESTADO_REFERRAL[estado],
      cita: resumenCita(cita),
    });
  };

  for (const p of partes) {
    const origen = origenDe.get(String(p.id));
    if (!origen) continue;
    const candidatas = derivadasDe.get(String(origen.appt._id)) || [];
    const vistos = new Set();
    for (const it of p.items || []) {
      const sid = String(it.serviceItem);
      if (vistos.has(sid)) continue;
      vistos.add(sid);
      const name = it.name || catalogo.nombrePorId.get(sid) || '';
      const key = normalizeServiceName(name);
      const mejor = candidatas
        .filter((c) => idDe(c.serviceItem) === sid || normalizeServiceName(c.serviceName) === key)
        .sort((a, b) => (RANGO_DERIVADA[b.status] || 0) - (RANGO_DERIVADA[a.status] || 0))[0] || null;
      candidatas
        .filter((c) => idDe(c.serviceItem) === sid || normalizeServiceName(c.serviceName) === key)
        .forEach((c) => usadas.add(String(c._id)));
      fila(origen.appt, origen.user, name, sid, p.fecha, mejor);
    }
  }
  // Citas derivadas cuya indicación no está en un seguimiento (o se borró de él):
  // también son derivaciones de esa cita y se enseñan.
  const apptPorId = new Map(appts.map((a) => [String(a._id), a]));
  for (const d of derivadas) {
    if (usadas.has(String(d._id))) continue;
    const origen = apptPorId.get(String(d.derivationSource));
    if (!origen) continue;
    fila(origen, origen.doctor, d.serviceName || catalogo.nombrePorId.get(idDe(d.serviceItem)) || '', idDe(d.serviceItem) || null, origen.date, d);
  }
  return filas;
}

/**
 * Calcula lo que ganó cada doctor con los filtros de la pantalla (`params` =
 * start/end/clinic/doctor/status/service, como en la query del resumen).
 *
 * Una LÍNEA por comisión:
 *   · servicio   → tarifa del doctor por un servicio de su cita (prioritaria);
 *                  con «solo primera vez», vale 0 cuando el paciente ya lo había
 *                  recibido antes (`repetida`).
 *   · paciente   → tarifa base por paciente, solo si la cita no pagó por servicio.
 *   · derivacion → el doctor DERIVÓ y la cita derivada se REALIZÓ en el período
 *                  (la fecha es la de la cita derivada: se gana cuando el
 *                  paciente se la hace, no cuando se indica).
 * Cada línea dice si ya está PAGADA (cae dentro de un pago del doctor).
 */
async function calcularComisionesDoctores(clinicIdSesion, params = {}) {
  const { query, estados, startDate, endDate } = await construirQueryResumen({ query: params, clinicId: clinicIdSesion });
  const catalogo = await catalogoServicios();
  const doctoresFiltro = parseList(params.doctor);

  const POP_DOCTOR = 'name specialty clinics worksInAllClinics active';
  const appts = await Appointment.find(query)
    .populate('doctor', POP_DOCTOR)
    .populate('clinic', 'name nombreComercial')
    .populate('patient', 'firstName lastName')
    .populate('turns.user', 'name')
    .populate('attendedByNurse', 'name')
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Citas DERIVADAS realizadas en el período. No se filtran por su doctor (el que
  // atendió es otro) sino por QUIEN DERIVÓ; los estados son siempre los de una
  // cita realizada, que es lo único que devenga una derivación.
  const qDerivadas = { ...query, status: { $in: ESTADOS_ATENDIDA }, referral: { $ne: null } };
  delete qDerivadas.doctor;
  const derivadas = (await Appointment.find(qDerivadas)
    .populate({ path: 'referral', select: 'fromDoctor', populate: { path: 'fromDoctor', select: POP_DOCTOR } })
    .populate('doctor', 'name')
    .populate('clinic', 'name nombreComercial')
    .populate('patient', 'firstName lastName')
    .sort({ date: 1, startTime: 1 })
    .lean())
    .filter((a) => a.referral?.fromDoctor?._id
      && (!doctoresFiltro.length || doctoresFiltro.includes(String(a.referral.fromDoctor._id))));

  const doctores = new Map();
  for (const a of appts) if (a.doctor?._id) doctores.set(String(a.doctor._id), a.doctor);
  for (const a of derivadas) {
    const d = a.referral.fromDoctor;
    if (!doctores.has(String(d._id))) doctores.set(String(d._id), d);
  }
  const doctorIds = [...doctores.keys()];
  const clinicIds = [...new Set([...appts, ...derivadas].map((a) => idDe(a.clinic)).filter(Boolean))];

  const [reglas, ajustes, pagos] = await Promise.all([
    doctorIds.length && clinicIds.length
      ? CommissionRule.find({
          managedFromDoctorCommissions: true,
          active: true,
          doctorServiceDoctor: { $in: doctorIds },
          clinic: { $in: clinicIds },
        }).lean()
      : [],
    // Ajustes manuales del período: comisiones que el sistema no contabilizó
    // correctamente y se corrigen a mano (valor + observación).
    CommissionAdjustment.find({ clinic: clinicIdSesion, start: { $lte: endDate }, end: { $gte: startDate } })
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    doctorIds.length
      ? CommissionPayout.find({ doctor: { $in: doctorIds }, start: { $lte: endDate }, end: { $gte: startDate } })
          .populate('createdBy', 'name')
          .sort({ start: 1 })
          .lean()
      : [],
  ]);

  const reglasDe = (doctorId, scope, clinicId) => reglas.filter((r) =>
    String(r.doctorServiceDoctor) === doctorId
    && (r.doctorCommissionScope || 'service') === scope
    && (!clinicId || String(r.clinic) === clinicId));
  // La tarifa de un servicio: por id exacto, o por nombre (el mismo servicio
  // tiene otro id en otra sucursal y las citas viejas solo guardaron el nombre).
  const reglaDeServicio = (lista, svc) =>
    lista.find((r) => r.appointmentService && svc.id && String(r.appointmentService) === svc.id)
    || lista.find((r) => r.appointmentService
      && normalizeServiceName(catalogo.nombrePorId.get(String(r.appointmentService))) === svc.key);

  const pagosPorDoctor = new Map();
  for (const p of pagos) {
    const did = String(p.doctor);
    if (!pagosPorDoctor.has(did)) pagosPorDoctor.set(did, []);
    pagosPorDoctor.get(did).push(p);
  }
  const pagoQueCubre = (doctorId, clinicId, date) => {
    const t = new Date(date).getTime();
    return (pagosPorDoctor.get(doctorId) || []).find((p) =>
      t >= new Date(p.start).getTime() && t <= new Date(p.end).getTime()
      && (!(p.clinics || []).length || p.clinics.map(String).includes(clinicId))) || null;
  };

  const hayPrimeraVez = reglas.some((r) => r.firstTimeOnly);
  const esPrimeraVez = hayPrimeraVez
    ? await detectorPrimeraVez(appts.filter(esAtendida), catalogo)
    : () => true;

  const lineas = [];
  const agregar = (l) => {
    const pago = pagoQueCubre(l.doctorId, l.clinicId, l.date);
    lineas.push({ ...l, amount: +num(l.amount).toFixed(2), pagada: !!pago, payoutId: pago ? String(pago._id) : null });
  };

  for (const appt of appts) {
    // Canje: no genera comisión, ni por servicio ni por paciente (un valor fijo
    // la habría pagado igual aunque la cita valga $0).
    if (!esAtendida(appt) || !appt.doctor?._id || appt.isCanje) continue;
    const doctorId = String(appt.doctor._id);
    const clinicId = idDe(appt.clinic);
    const pagado = appointmentPaymentValue(appt);
    const comun = {
      doctorId, apptId: String(appt._id), date: appt.date, clinicId,
      patient: nombrePaciente(appt.patient), base: pagado,
    };
    let cubierta = false;
    const reglasServicio = reglasDe(doctorId, 'service', clinicId);
    for (const svc of serviciosDeCita(appt, catalogo)) {
      const rule = reglaDeServicio(reglasServicio, svc);
      if (!rule) continue;
      cubierta = true;
      const repetida = !!rule.firstTimeOnly && !esPrimeraVez(appt, svc.key);
      agregar({
        ...comun, kind: 'servicio', ruleId: String(rule._id), serviceKey: svc.key, serviceName: svc.name,
        amount: repetida ? 0 : calcAmount(cfgDeRegla(rule, appt), pagado), repetida,
        franja: etiquetaFranja(franjaDeRegla(rule, appt)),
      });
    }
    // La base por paciente solo cuando ningún servicio de la cita paga por sí
    // mismo: una tarifa de servicio REEMPLAZA a la base, no se suma. Un servicio
    // de «solo primera vez» repetido también cubre la cita (paga cero): si no,
    // la base pagaría justo lo que la regla dice que ya no se paga.
    if (!cubierta) {
      const rule = reglasDe(doctorId, 'patient', clinicId)[0];
      if (rule) {
        agregar({
          ...comun, kind: 'paciente', ruleId: String(rule._id), serviceKey: '', serviceName: 'Paciente atendido',
          amount: calcAmount(cfgDeRegla(rule, appt), pagado),
          franja: etiquetaFranja(franjaDeRegla(rule, appt)),
        });
      }
    }
  }

  for (const cita of derivadas) {
    // Tampoco paga la derivación cuya cita derivada fue de canje.
    if (cita.isCanje) continue;
    const doctorId = String(cita.referral.fromDoctor._id);
    const clinicId = idDe(cita.clinic);
    const svcs = serviciosDeCita(cita, catalogo);
    const reglasDeriva = reglasDe(doctorId, 'referral', clinicId);
    let rule = null;
    let svc = svcs[0] || { key: '', name: cita.serviceName || '—' };
    for (const s of svcs) {
      const r = reglaDeServicio(reglasDeriva, s);
      if (r) { rule = r; svc = s; break; }
    }
    if (!rule) rule = reglasDeriva.find((r) => !r.appointmentService) || null;
    if (!rule) continue;
    const pagado = appointmentPaymentValue(cita);
    agregar({
      doctorId, apptId: String(cita._id), date: cita.date, clinicId,
      patient: nombrePaciente(cita.patient), base: pagado,
      kind: 'derivacion', ruleId: String(rule._id), porServicio: !!rule.appointmentService,
      serviceKey: svc.key, serviceName: svc.name, atendidaPor: cita.doctor?.name || '',
      amount: calcAmount(cfgDeRegla(rule, cita), pagado),
      franja: etiquetaFranja(franjaDeRegla(rule, cita)),
    });
  }

  // Un ajuste está pagado si su rango entero cae dentro de un pago del doctor.
  const ajustesPorDoctor = new Map();
  for (const aj of ajustes) {
    const did = idDe(aj.doctor);
    const inicio = new Date(aj.start).getTime();
    const fin = new Date(aj.end).getTime();
    const pago = (pagosPorDoctor.get(did) || []).find((p) =>
      inicio >= new Date(p.start).getTime() && fin <= new Date(p.end).getTime()) || null;
    if (!ajustesPorDoctor.has(did)) ajustesPorDoctor.set(did, []);
    ajustesPorDoctor.get(did).push({
      id: String(aj._id),
      amount: num(aj.amount),
      note: aj.note || '',
      start: aj.start,
      end: aj.end,
      createdBy: aj.createdBy?.name || '',
      createdAt: aj.createdAt,
      pagado: !!pago,
    });
  }

  return {
    query, estados, startDate, endDate, catalogo,
    appts, derivadas, doctores, reglas, reglasDe, reglaDeServicio,
    lineas, ajustesPorDoctor, pagosPorDoctor,
  };
}

/** Resumen de una tarifa configurada (igual en todas las sucursales o mezclada). */
const resumenTarifa = (configs, earned, totalClinics, extra = {}) => {
  if (!configs.length) return null;
  const bandas = (r) => (r.timeBands || []).map((b) => ({
    startTime: b.startTime,
    endTime: b.endTime,
    amountType: b.amountType || 'fixed',
    value: b.amountType === 'percent' ? num(b.percent) : num(b.amount),
  }));
  const firma = (r) => `${r.amountType}:${r.amountType === 'percent' ? num(r.percent) : num(r.amount)}:${!!r.firstTimeOnly}:${JSON.stringify(bandas(r))}`;
  const base = { earned: +num(earned).toFixed(2), configuredClinics: configs.length, totalClinics, ...extra };
  if (new Set(configs.map(firma)).size > 1) return { mixed: true, ...base };
  const first = configs[0];
  return {
    mixed: false,
    amountType: first.amountType || 'fixed',
    value: first.amountType === 'percent' ? num(first.percent) : num(first.amount),
    firstTimeOnly: !!first.firstTimeOnly,
    timeBands: bandas(first),
    partial: configs.length < totalClinics,
    ...base,
  };
};

const sumar = (lista) => +lista.reduce((t, l) => t + num(l.amount), 0).toFixed(2);

exports.doctorSummary = async (req, res) => {
  try {
    const calc = await calcularComisionesDoctores(req.clinicId, req.query);
    const { appts, derivadas, doctores, reglas, reglaDeServicio, lineas, ajustesPorDoctor, pagosPorDoctor, catalogo, estados } = calc;
    const ESTADOS = ESTADOS_CITA;

    const byDoctor = new Map();
    const filaDe = (doc) => {
      const id = String(doc._id);
      if (!byDoctor.has(id)) {
        byDoctor.set(id, {
          doctorId: id,
          name: doc.name,
          specialty: doc.specialty || '',
          active: doc.active !== false,
          roles: new Set(),
          clinics: new Set(),
          clinicIds: new Set(),
          referralClinicIds: new Set(),
          total: 0,
          byStatus: Object.fromEntries(ESTADOS.map((s) => [s, 0])),
          services: [],
          referralServices: [],
          generated: 0,
          referralRealizadas: 0,
        });
      }
      return byDoctor.get(id);
    };
    const rolDe = (doc, clinicId) => (doc.clinics || []).find((c) => String(c.clinic?._id || c.clinic) === clinicId)?.role
      || (doc.worksInAllClinics ? doc.clinics?.[0]?.role : null);

    for (const appt of appts) {
      const doc = appt.doctor;
      if (!doc || !doc.name) continue;
      const fila = filaDe(doc);
      fila.total += 1;
      const clinicId = idDe(appt.clinic);
      const nombreSucursal = appt.clinic?.nombreComercial || appt.clinic?.name;
      if (nombreSucursal) fila.clinics.add(nombreSucursal);
      if (clinicId) { fila.clinicIds.add(clinicId); fila.referralClinicIds.add(clinicId); }
      const roleInClinic = rolDe(doc, clinicId);
      if (roleInClinic) fila.roles.add(roleInClinic);
      if (fila.byStatus[appt.status] != null) fila.byStatus[appt.status] += 1;
      // GENERADO: lo que pagaron los pacientes por las citas que el doctor atendió.
      if (esAtendida(appt)) fila.generated += appointmentPaymentValue(appt);

      for (const s of serviciosDeCita(appt, catalogo)) {
        let svc = fila.services.find((x) => x.key === s.key);
        if (!svc) {
          svc = { name: s.name, key: s.key, serviceId: s.id, count: 0, byStatus: {}, clinicIds: new Set() };
          fila.services.push(svc);
        }
        if (!svc.serviceId && s.id) svc.serviceId = s.id;
        if (clinicId) svc.clinicIds.add(clinicId);
        svc.count += 1;
        svc.byStatus[appt.status] = (svc.byStatus[appt.status] || 0) + 1;
      }
    }

    // Derivaciones REALIZADAS en el período, agrupadas por el servicio derivado.
    for (const cita of derivadas) {
      const fila = filaDe(cita.referral.fromDoctor);
      const clinicId = idDe(cita.clinic);
      if (clinicId) fila.referralClinicIds.add(clinicId);
      fila.referralRealizadas += 1;
      const s = serviciosDeCita(cita, catalogo)[0];
      if (!s) continue;
      let svc = fila.referralServices.find((x) => x.key === s.key);
      if (!svc) {
        svc = { name: s.name, key: s.key, serviceId: s.id, realizadas: 0, clinicIds: new Set() };
        fila.referralServices.push(svc);
      }
      if (!svc.serviceId && s.id) svc.serviceId = s.id;
      if (clinicId) svc.clinicIds.add(clinicId);
      svc.realizadas += 1;
    }

    // Derivaciones INDICADAS en las citas del filtro y si se realizaron.
    const indicadas = await derivacionesIndicadas(appts.filter(esAtendida), catalogo);
    const indicadasPorDoctor = new Map();
    for (const d of indicadas) {
      if (!indicadasPorDoctor.has(d.fromDoctorId)) indicadasPorDoctor.set(d.fromDoctorId, []);
      indicadasPorDoctor.get(d.fromDoctorId).push(d);
    }
    // Un servicio que el doctor derivó aparece para poder ponerle tarifa aunque
    // la derivación aún no se haya realizado.
    for (const d of indicadas) {
      const fila = byDoctor.get(d.fromDoctorId);
      if (!fila) continue;
      const key = normalizeServiceName(d.service);
      if (!key || fila.referralServices.some((x) => x.key === key)) continue;
      fila.referralServices.push({
        name: d.service, key, serviceId: d.serviceItem || catalogo.idPorNombre.get(key) || null,
        realizadas: 0, clinicIds: new Set([...fila.clinicIds]),
      });
    }

    const doctors = [...byDoctor.values()].map((f) => {
      const doctorId = f.doctorId;
      const misLineas = lineas.filter((l) => l.doctorId === doctorId);
      const misReglas = reglas.filter((r) => String(r.doctorServiceDoctor) === doctorId);
      const deAlcance = (scope, clinicSet) => misReglas.filter((r) =>
        (r.doctorCommissionScope || 'service') === scope && clinicSet.has(String(r.clinic)));

      const services = f.services.map((s) => {
        const clinicSet = new Set(s.clinicIds);
        const configs = deAlcance('service', clinicSet).filter((r) => reglaDeServicio([r], { id: s.serviceId, key: s.key }));
        const suyas = misLineas.filter((l) => l.kind === 'servicio' && l.serviceKey === s.key);
        return {
          name: s.name,
          serviceId: s.serviceId,
          count: s.count,
          byStatus: s.byStatus,
          clinicIds: [...s.clinicIds],
          commission: s.serviceId
            ? resumenTarifa(configs, sumar(suyas), clinicSet.size, { repeated: suyas.filter((l) => l.repetida).length })
            : null,
        };
      });

      const clinicSet = new Set(f.clinicIds);
      const patientCommission = resumenTarifa(
        deAlcance('patient', clinicSet).filter((r) => !r.appointmentService),
        sumar(misLineas.filter((l) => l.kind === 'paciente')),
        clinicSet.size
      );

      const referralClinicSet = new Set(f.referralClinicIds);
      const derivLineas = misLineas.filter((l) => l.kind === 'derivacion');
      const referralCommission = resumenTarifa(
        deAlcance('referral', referralClinicSet).filter((r) => !r.appointmentService),
        sumar(derivLineas.filter((l) => !l.porServicio)),
        referralClinicSet.size
      );
      const referralServices = f.referralServices.map((s) => {
        const set = new Set(s.clinicIds.size ? s.clinicIds : f.referralClinicIds);
        const configs = deAlcance('referral', set)
          .filter((r) => r.appointmentService && reglaDeServicio([r], { id: s.serviceId, key: s.key }));
        return {
          name: s.name,
          serviceId: s.serviceId,
          realizadas: s.realizadas,
          clinicIds: [...set],
          commission: s.serviceId
            ? resumenTarifa(configs, sumar(derivLineas.filter((l) => l.porServicio && l.serviceKey === s.key)), set.size)
            : null,
        };
      });
      const misIndicadas = indicadasPorDoctor.get(doctorId) || [];
      const cuenta = (estado) => misIndicadas.filter((d) => d.estado === estado).length;

      const adjustments = ajustesPorDoctor.get(doctorId) || [];
      const adjustmentTotal = sumar(adjustments);
      const commissionTotal = sumar(misLineas);
      const commissionTotalWithAdjustments = +(commissionTotal + adjustmentTotal).toFixed(2);
      const paidTotal = +(sumar(misLineas.filter((l) => l.pagada)) + sumar(adjustments.filter((a) => a.pagado))).toFixed(2);
      const payouts = (pagosPorDoctor.get(doctorId) || []).map((p) => ({
        id: String(p._id),
        start: p.start,
        end: p.end,
        amount: num(p.amount),
        count: p.count || 0,
        note: p.note || '',
        allClinics: !(p.clinics || []).length,
        createdBy: p.createdBy?.name || '',
        createdAt: p.createdAt,
      }));

      return {
        doctorId,
        name: f.name,
        specialty: f.specialty,
        active: f.active,
        clinics: [...f.clinics],
        clinicIds: [...f.clinicIds],
        referralClinicIds: [...f.referralClinicIds],
        roles: [...f.roles],
        roleInClinic: [...f.roles][0] || null,
        total: f.total,
        byStatus: f.byStatus,
        services,
        patientCommission,
        referralCommission,
        referralServices,
        referrals: {
          realizadasEnPeriodo: f.referralRealizadas,
          earned: sumar(derivLineas),
          indicadas: misIndicadas.length,
          realizadas: cuenta('realizada'),
          agendadas: cuenta('agendada'),
          sinAgendar: cuenta('sin_agendar'),
          noRealizadas: cuenta('no_asistio') + cuenta('cancelada'),
        },
        generated: +f.generated.toFixed(2),
        adjustments,
        adjustmentTotal,
        commissionTotal,
        commissionTotalWithAdjustments,
        paidTotal,
        pendingTotal: +(commissionTotalWithAdjustments - paidTotal).toFixed(2),
        payouts,
        hasConfiguredCommissions: services.some((s) => !!s.commission) || !!patientCommission
          || !!referralCommission || referralServices.some((s) => !!s.commission),
      };
    }).sort((a, b) => b.total - a.total || b.commissionTotal - a.commissionTotal);

    const totals = Object.fromEntries(ESTADOS.map((s) => [s, 0]));
    for (const fila of doctors) {
      for (const s of ESTADOS) totals[s] += fila.byStatus[s] || 0;
    }
    const suma = (k) => +doctors.reduce((t, d) => t + num(d[k]), 0).toFixed(2);

    res.json({
      start: calc.startDate,
      end: calc.endDate,
      statuses: estados.length ? estados : ESTADOS,
      doctors,
      totals: {
        total: appts.length,
        byStatus: totals,
        generated: suma('generated'),
        commissions: suma('commissionTotalWithAdjustments'),
        paid: suma('paidTotal'),
        pending: suma('pendingTotal'),
      },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular el resumen por doctor', error: e.message });
  }
};

/**
 * Doctores para los filtros de Comisiones: todos los que tienen rol de doctor
 * (general o especialidad) en la sucursal pedida, o en cualquiera con
 * `clinic=all`. Incluye a los inactivos —sus comisiones pasadas siguen
 * existiendo— y dice el rol de cada uno para que el filtro lo enseñe.
 */
exports.doctorOptions = async (req, res) => {
  try {
    const { clinic } = req.query;
    const porSucursal = clinic && clinic !== 'all' && mongoose.isValidObjectId(clinic);
    const users = await User.find(porSucursal
      ? User.enSucursal(clinic, DOCTOR_LIKE_ROLES)
      : { 'clinics.role': { $in: DOCTOR_LIKE_ROLES } })
      .select('name specialty clinics worksInAllClinics active')
      .sort({ name: 1 })
      .lean();
    res.json(users.map((u) => {
      const filas = (u.clinics || []).filter((c) => DOCTOR_LIKE_ROLES.includes(c.role));
      const propias = porSucursal && !u.worksInAllClinics
        ? filas.filter((c) => String(c.clinic) === String(clinic))
        : filas;
      const roles = [...new Set((propias.length ? propias : filas).map((c) => c.role))];
      return {
        _id: String(u._id),
        name: u.name,
        specialty: u.specialty || '',
        active: u.active !== false,
        roles,
        roleInClinic: roles[0] || null,
      };
    }));
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener los doctores', error: e.message });
  }
};

/**
 * DETALLE de las citas del resumen: una fila por cita con paciente, quién atendió
 * (turnos: puede ser más de un doctor), valor/pago (canje, abono, venta), lo que
 * el doctor escribió en seguimientos (sueros y demás receta) y las DERIVACIONES
 * que indicó en esa cita con su estado (realizada, agendada, sin agendar…).
 * Mismos filtros que `doctorSummary` (start/end/clinic/doctor/status/service).
 */
exports.doctorAppointments = async (req, res) => {
  try {
    const { query, startDate, endDate } = await construirQueryResumen(req);
    const catalogo = await catalogoServicios();

    /**
     * PAGINADO (sep-2026): con todos los doctores de un mes salían miles de
     * filas y la página tardaba en cargar. Primero se leen TODAS las citas del
     * filtro con los campos justos para el total de pagos y el nº de visita
     * (que deben contar el filtro entero, no la página); después solo las de la
     * página cargan paciente, turnos, ventas, seguimientos y derivaciones, que
     * es lo caro. `limit` 0 (o ausente) = todas, como antes.
     */
    const ORDEN = { date: 1, startTime: 1, _id: 1 };
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 1000);
    const todas = await Appointment.find(query)
      .select('patient doctor date startTime agreedValue isCanje advancePayment advanceAmount')
      .sort(ORDEN)
      .lean();
    const total = todas.length;
    const pages = limit ? Math.max(Math.ceil(total / limit), 1) : 1;
    const page = limit ? Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages) : 1;
    const idsPagina = limit ? todas.slice((page - 1) * limit, page * limit).map((a) => a._id) : null;

    const appts = await Appointment.find(idsPagina ? { _id: { $in: idsPagina } } : query)
      .populate('patient', 'firstName lastName')
      .populate('doctor', 'name')
      .populate('turns.user', 'name')
      .populate('attendedByNurse', 'name')
      .populate('clinic', 'name nombreComercial')
      .sort(ORDEN)
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
                      // Las derivaciones van en su propia columna.
                      cond: { $and: [{ $ne: ['$$it.isSerum', true] }, { $ne: ['$$it.isService', true] }] },
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
    // Se cuenta DENTRO del resultado (las citas que pasaron los filtros, todas
    // las páginas: la visita 3/5 lo es aunque las otras estén en otra página).
    const visitasPaciente = new Map();
    for (const a of todas) {
      const pid = a.patient ? String(a.patient) : null;
      const did = a.doctor ? String(a.doctor) : null;
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

    // DERIVACIONES que los doctores indicaron en estas citas (desde su
    // seguimiento), con su estado. Es lo que dice si el paciente se la hizo.
    const indicadas = await derivacionesIndicadas(appts, catalogo);
    const indicadasDeCita = new Map();
    for (const d of indicadas) {
      if (!indicadasDeCita.has(d.originAppointment)) indicadasDeCita.set(d.originAppointment, []);
      indicadasDeCita.get(d.originAppointment).push(d);
    }

    // Más las derivaciones registradas a mano (página Derivaciones) por los
    // doctores del resultado en el rango, que no vienen de un seguimiento. No
    // cuelgan de una cita de la página, así que van solo en la PRIMERA página
    // (en las demás se repetirían).
    const doctorIds = [...new Set(todas.filter((a) => a.doctor).map((a) => String(a.doctor)))];
    let manuales = [];
    if (doctorIds.length && page === 1) {
      const filtroDeriva = { fromDoctor: { $in: doctorIds }, date: { $gte: startDate, $lte: endDate } };
      if (query.clinic) filtroDeriva.clinic = query.clinic;
      manuales = await Referral.find(filtroDeriva)
        .populate('patient', 'firstName lastName')
        .populate('fromDoctor', 'name')
        .populate('toDoctor', 'name')
        .populate({ path: 'appointment', select: 'date startTime status doctor clinic derivationSource', populate: [{ path: 'doctor', select: 'name' }, { path: 'clinic', select: 'name nombreComercial' }] })
        .select('fromDoctor patient toDoctor specialty status date reason appointment')
        .lean();
    }
    const citasYaListadas = new Set(indicadas.map((d) => d.cita?.id).filter(Boolean));
    const derivacionesPorDoctor = new Map();
    const agregarDeriva = (did, fila) => {
      if (!derivacionesPorDoctor.has(did)) derivacionesPorDoctor.set(did, []);
      derivacionesPorDoctor.get(did).push(fila);
    };
    for (const d of indicadas) {
      agregarDeriva(d.fromDoctorId, {
        id: d.id,
        patient: d.patient,
        fromDoctor: d.fromDoctor,
        toDoctor: d.cita?.doctor || '',
        specialty: d.service,
        service: d.service,
        status: d.status,
        estado: d.estado,
        date: d.date,
        reason: '',
        cita: d.cita,
        source: 'seguimiento',
      });
    }
    for (const r of manuales) {
      if (r.appointment?._id && citasYaListadas.has(String(r.appointment._id))) continue;
      const cita = r.appointment?._id ? r.appointment : null;
      const estado = cita ? estadoDerivada(cita)
        : r.status === 'atendida' ? 'realizada'
        : r.status === 'agendada' ? 'agendada'
        : r.status === 'cancelada' ? 'cancelada'
        : 'sin_agendar';
      agregarDeriva(String(r.fromDoctor?._id || r.fromDoctor), {
        id: String(r._id),
        patient: nombrePaciente(r.patient),
        // Quien derivó: en el detalle GENERAL —de todos los doctores— la tabla
        // tiene que decir de qué doctor fue cada derivación.
        fromDoctor: r.fromDoctor?.name || '',
        toDoctor: r.toDoctor?.name || cita?.doctor?.name || '',
        specialty: r.specialty || '',
        service: r.specialty || '',
        status: r.status,
        estado,
        date: r.date,
        reason: r.reason || '',
        cita: cita ? {
          id: String(cita._id), date: cita.date, startTime: cita.startTime || '', status: cita.status,
          doctor: cita.doctor?.name || '', clinic: cita.clinic?.nombreComercial || cita.clinic?.name || '',
        } : null,
        source: 'manual',
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
        patient: nombrePaciente(a.patient),
        status: a.status,
        clinic: a.clinic?.nombreComercial || a.clinic?.name || '',
        // El doctor de la CITA (el espejo). En el detalle general —todas las
        // citas de todos los doctores— es lo que dice de quién era cada fila.
        doctorId: did,
        doctorName: a.doctor?.name || '',
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
          totalValue: appointmentPaymentValue(a),
        },
        venta: venta
          ? { number: venta.saleNumber || '', total: venta.total, date: venta.createdAt }
          : null,
        seguimientos,
        derivaciones: (indicadasDeCita.get(String(a._id)) || []).map((d) => ({
          id: d.id, service: d.service, estado: d.estado, fromDoctor: d.fromDoctor, cita: d.cita,
        })),
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
      totals: {
        // Del filtro ENTERO, no de la página.
        appointments: total,
        payments: +todas.reduce((sum, a) => sum + num(appointmentPaymentValue(a)), 0).toFixed(2),
        pagePayments: +appointments.reduce((sum, a) => sum + num(a.payment?.totalValue), 0).toFixed(2),
      },
      pagination: { page, limit, total, pages },
      doctorNames,
      referralsByDoctor: Object.fromEntries(derivacionesPorDoctor),
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener el detalle de citas', error: e.message });
  }
};

/**
 * Por qué fecha se filtra el apartado de marketing: la de la CITA (lo de
 * siempre, y lo que usa el resumen por doctor) o el día en que se AGENDÓ.
 */
const FECHA_CALLCENTER = { cita: 'date', agendada: 'createdAt' };

/**
 * LAS CITAS QUE AGENDÓ EL CALL CENTER, incluidas las de agentes DESACTIVADOS.
 *
 * El resumen buscaba a los agentes con `active: true` y después sus citas. Al
 * desactivar a una asesora que se iba, sus agendamientos desaparecían de la
 * pantalla justo cuando hacía falta calcular lo que se le quedaba debiendo. Lo
 * que agendó no deja de haber ocurrido porque se le cierre la cuenta.
 *
 * Cuenta como del call center la cita que:
 *   · creó (o se le acreditó a) un usuario con rol call_center en alguna sede,
 *     esté activo o no; o
 *   · lleva el sello `createdByRole: 'call_center'`, aunque esa persona haya
 *     cambiado de rol después.
 *
 * La sucursal filtra las CITAS, no a los agentes: el call center es único para
 * toda la organización y agenda en sedes en las que no figura.
 */
async function agendamientosCallCenter(req, { select, extra = {} }) {
  const { start, end, clinic } = req.query;
  const { startDate, endDate } = parseRange(start, end);
  const campo = FECHA_CALLCENTER[req.query.fecha] || 'date';

  const usuariosCC = await User.find({ 'clinics.role': 'call_center' })
    .select('name active clinics worksInAllClinics')
    .lean();

  const query = {
    [campo]: { $gte: startDate, $lte: endDate },
    $or: [
      { createdBy: { $in: usuariosCC.map((u) => u._id) } },
      { createdByRole: 'call_center' },
    ],
    ...extra,
  };
  if (clinic !== 'all') query.clinic = clinic || req.clinicId;

  const appts = await Appointment.find(query)
    .populate('clinic', 'name nombreComercial')
    .select(select)
    .lean();

  // Quien agendó por el sello de rol y ya no es call center no está en la
  // lista: se le busca aparte para tener su nombre y si sigue activo.
  const conocidos = new Set(usuariosCC.map((u) => String(u._id)));
  const faltan = [...new Set(appts.map((a) => String(a.createdBy || '')).filter((id) => id && !conocidos.has(id)))];
  const otros = faltan.length
    ? await User.find({ _id: { $in: faltan } }).select('name active').lean()
    : [];
  const usuarios = new Map([...usuariosCC, ...otros].map((u) => [String(u._id), u]));

  return { startDate, endDate, campo, appts, usuariosCC, usuarios };
}

/**
 * ¿NUEVO, NUEVO SIN ASISTIR O RECURRENTE? Lo que cuenta para marketing.
 *
 * Nuevo es el paciente que se agendó por PRIMERA VEZ (`isFirstVisit`, congelada
 * al agendar) y además:
 *   · esa cita quedó ASISTIDA o COMPLETADA. Si está pendiente, confirmada, no
 *     asistió o se canceló, todavía no hay captación que pagar: sale aparte como
 *     «nuevo sin asistir» y no suma a los nuevos;
 *   · en su historia no había ya una consulta ANTERIOR a esa cita ni ficha física
 *     escaneada. La marca se tomó al agendar y la ficha de papel puede haberse
 *     subido después: se vuelve a mirar aquí (ver `citasConHistoriaPrevia`).
 *
 * Lo que no es primera vez —o resultó tener historia— es recurrente.
 * Necesita de cada cita: patient, date, status, isFirstVisit, turns y autoSerumFollowUp.
 */
const CAMPOS_CLASIFICACION = 'patient date status isFirstVisit turns.followUp turns.serumFollowUp autoSerumFollowUp';
async function clasificarAgendamientos(appts) {
  const candidatas = appts.filter((a) => a.isFirstVisit);
  const conHistoria = await citasConHistoriaPrevia(candidatas);
  const tipo = new Map();
  for (const a of appts) {
    const id = String(a._id);
    if (!a.isFirstVisit || conHistoria.has(id)) tipo.set(id, 'recurrente');
    else tipo.set(id, esAtendida(a) ? 'nuevo' : 'nuevoSinAsistir');
  }
  return tipo;
}

/**
 * El chat de cada paciente, para el botón «Chat» del listado. Primero el que
 * está vinculado al paciente; si no hay, el de su teléfono (la conversación se
 * identifica por el número). El teléfono NO sale en la respuesta: marketing no
 * lo ve, solo recibe el id del chat al que saltar.
 */
async function chatsDePacientes(patientIds) {
  const ids = [...new Set(patientIds.filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const vinculados = await Conversation.find({ patient: { $in: ids } })
    .select('_id patient lastMessageAt')
    .sort({ lastMessageAt: -1 })
    .lean();
  for (const c of vinculados) {
    const pid = String(c.patient);
    if (!out.has(pid)) out.set(pid, String(c._id));
  }
  const faltan = ids.filter((id) => !out.has(id));
  if (!faltan.length) return out;
  const pacientes = await Patient.find({ _id: { $in: faltan } }).select('phone whatsapp').lean();
  const telDe = new Map();
  for (const pac of pacientes) {
    for (const t of [pac.whatsapp, pac.phone]) {
      const n = normalizePhone(t);
      if (n.ok && !telDe.has(n.phone)) telDe.set(n.phone, String(pac._id));
    }
  }
  if (!telDe.size) return out;
  const porTelefono = await Conversation.find({ phone: { $in: [...telDe.keys()] } })
    .select('_id phone lastMessageAt')
    .sort({ lastMessageAt: -1 })
    .lean();
  for (const c of porTelefono) {
    const pid = telDe.get(String(c.phone));
    if (pid && !out.has(pid)) out.set(pid, String(c._id));
  }
  return out;
}

/** Nombre del agente de una cita: el usuario, o el nombre sellado si ya no existe. */
const nombreAgente = (usuarios, a) =>
  usuarios.get(String(a.createdBy || ''))?.name || a.createdByName || 'Sin agente';

/**
 * Resumen de AGENDAMIENTOS por agente de call center: cuántas citas agendó cada
 * uno y de esas cuántas fueron para pacientes NUEVOS (ya asistidos), NUEVOS SIN
 * ASISTIR (no suman) y RECURRENTES —ver `clasificarAgendamientos`—. Mismo
 * alcance de fechas/sucursal que el resumen por doctor.
 *
 * Los agentes ACTIVOS salen siempre (aunque no agendaran nada, para ver quién
 * está en cero); los desactivados solo si agendaron en el período.
 */
exports.callCenterSummary = async (req, res) => {
  try {
    const { clinic } = req.query;
    const {
      startDate, endDate, campo, appts, usuariosCC, usuarios,
    } = await agendamientosCallCenter(req, { select: `createdBy createdByName clinic ${CAMPOS_CLASIFICACION}` });
    const tipo = await clasificarAgendamientos(appts);

    const filaVacia = (name) => ({ name, total: 0, nuevos: 0, nuevosSinAsistir: 0, recurrentes: 0, clinics: new Set() });
    const porAgente = new Map();
    for (const a of appts) {
      const id = String(a.createdBy || `nombre:${a.createdByName || ''}`);
      let fila = porAgente.get(id);
      if (!fila) {
        fila = filaVacia(nombreAgente(usuarios, a));
        porAgente.set(id, fila);
      }
      fila.total += 1;
      const t = tipo.get(String(a._id));
      if (t === 'nuevo') fila.nuevos += 1;
      else if (t === 'nuevoSinAsistir') fila.nuevosSinAsistir += 1;
      else fila.recurrentes += 1;
      const nombreSucursal = a.clinic?.nombreComercial || a.clinic?.name;
      if (nombreSucursal) fila.clinics.add(nombreSucursal);
    }

    // Activos de la sede elegida (o de todas) que no agendaron: van en cero.
    const sede = clinic === 'all' ? null : String(clinic || req.clinicId);
    for (const u of usuariosCC) {
      const id = String(u._id);
      if (!u.active || porAgente.has(id)) continue;
      const trabajaAqui = !sede || u.worksInAllClinics ||
        (u.clinics || []).some((c) => c.role === 'call_center' && String(c.clinic) === sede);
      if (trabajaAqui) porAgente.set(id, filaVacia(u.name));
    }

    const agents = [...porAgente.entries()]
      .map(([id, f]) => {
        const usuario = usuarios.get(id);
        return {
          userId: id,
          name: f.name,
          // Desactivado = su cuenta está cerrada; sus agendamientos siguen contando.
          inactive: usuario ? usuario.active === false : true,
          clinics: [...f.clinics],
          total: f.total,
          nuevos: f.nuevos,
          nuevosSinAsistir: f.nuevosSinAsistir,
          recurrentes: f.recurrentes,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    res.json({
      start: startDate,
      end: endDate,
      fecha: campo === 'createdAt' ? 'agendada' : 'cita',
      agents,
      totals: {
        total: appts.length,
        nuevos: agents.reduce((t, a) => t + a.nuevos, 0),
        nuevosSinAsistir: agents.reduce((t, a) => t + a.nuevosSinAsistir, 0),
        recurrentes: agents.reduce((t, a) => t + a.recurrentes, 0),
      },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al calcular el resumen de call center', error: e.message });
  }
};

/**
 * LOS PACIENTES NUEVOS QUE AGENDÓ EL CALL CENTER, uno por uno.
 *
 * El resumen decía «Nuevos 12» y nada más: para pagar la captación había que
 * saber QUIÉNES eran, cuándo se agendaron y cuándo los dio el sistema por
 * nuevos. Solo salen los que cuentan como nuevos para la comisión (ver
 * `clasificarAgendamientos`): primera cita, ASISTIDA o COMPLETADA, y sin
 * consulta previa ni ficha física. Se da por nuevo cuando asistió.
 *
 * Filtros: los mismos del resumen (fechas, sucursal, `fecha=cita|agendada`) y
 * `agent` para ver los de una sola persona.
 *
 * PAGINADO DE 200 EN 200 (`page`, `limit`): con un mes entero de call center
 * salían cientos de filas de golpe y la pantalla tardaba en cargar. La historia
 * previa no se puede preguntar en la consulta a Mongo, así que se filtra sobre
 * las candidatas (livianas) y se pide completa solo la página que se enseña.
 */
const NUEVOS_POR_PAGINA = 200;
exports.callCenterNewPatients = async (req, res) => {
  try {
    const extra = { isFirstVisit: true, status: { $in: ESTADOS_ATENDIDA } };
    if (req.query.agent) {
      if (!mongoose.Types.ObjectId.isValid(req.query.agent)) {
        return res.status(400).json({ message: 'Agente no válido' });
      }
      extra.createdBy = new mongoose.Types.ObjectId(req.query.agent);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || NUEVOS_POR_PAGINA, 1), 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const { appts: candidatas, usuarios } = await agendamientosCallCenter(req, {
      select: `createdAt createdBy ${CAMPOS_CLASIFICACION}`,
      extra,
    });
    const tipo = await clasificarAgendamientos(candidatas);
    // Lo último agendado primero.
    const nuevas = candidatas
      .filter((a) => tipo.get(String(a._id)) === 'nuevo')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b._id).localeCompare(String(a._id)));
    const total = nuevas.length;
    const idsPagina = nuevas.slice((page - 1) * limit, page * limit).map((a) => a._id);
    const orden = new Map(idsPagina.map((id, i) => [String(id), i]));
    const appts = (await Appointment.find({ _id: { $in: idsPagina } })
      .populate('clinic', 'name nombreComercial')
      .populate('patient', 'firstName lastName createdAt')
      .select('patient date startTime createdAt createdBy createdByName status clinic serviceName services arrivedAt completedAt')
      .lean())
      .sort((a, b) => orden.get(String(a._id)) - orden.get(String(b._id)));
    const chatDe = await chatsDePacientes(appts.map((a) => a.patient?._id));

    const patients = appts
      .map((a) => {
        const agente = usuarios.get(String(a.createdBy || ''));
        return {
          appointmentId: String(a._id),
          patientId: a.patient?._id ? String(a.patient._id) : null,
          patient: nombrePaciente(a.patient),
          patientRegisteredAt: a.patient?.createdAt || null,
          // Para los botones de la fila: su chat (si tiene) y la cita.
          chatId: a.patient?._id ? chatDe.get(String(a.patient._id)) || null : null,
          agentId: a.createdBy ? String(a.createdBy) : null,
          agent: nombreAgente(usuarios, a),
          agentInactive: agente ? agente.active === false : true,
          scheduledAt: a.createdAt,
          // Cuenta como nuevo desde que asistió a esa primera cita.
          markedNewAt: a.arrivedAt || a.completedAt || a.date,
          appointmentDate: a.date,
          startTime: a.startTime || '',
          status: a.status,
          attendedAt: a.completedAt || a.arrivedAt || null,
          clinic: a.clinic?.nombreComercial || a.clinic?.name || '',
          services: [a.serviceName, ...(a.services || []).map((s) => s.name)].filter(Boolean),
        };
      });

    res.json({
      patients,
      total,
      pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al listar los pacientes nuevos del call center', error: e.message });
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

// ─────────── Ajustes manuales de comisión por doctor ───────────

/**
 * Agrega un ajuste al total de comisiones de un doctor: valor (positivo o
 * negativo) + observación de por qué no se contabilizó correctamente.
 */
exports.saveDoctorAdjustment = async (req, res) => {
  try {
    const { doctor, amount, note = '', start, end } = req.body || {};
    const value = Number(amount);
    if (!mongoose.isValidObjectId(doctor)) return res.status(400).json({ message: 'Doctor no válido' });
    if (!Number.isFinite(value) || value === 0) {
      return res.status(400).json({ message: 'Ingresa un valor distinto de cero' });
    }
    const { startDate, endDate } = parseRange(start, end);
    const doctorDoc = await User.findById(doctor).select('name').lean();
    if (!doctorDoc) return res.status(404).json({ message: 'Doctor no encontrado' });

    const adj = await CommissionAdjustment.create({
      clinic: req.clinicId,
      doctor,
      start: startDate,
      end: endDate,
      amount: +value.toFixed(2),
      note: String(note || '').trim(),
      createdBy: req.user._id,
    });
    res.status(201).json(adj);
  } catch (e) {
    res.status(500).json({ message: 'Error al guardar el ajuste', error: e.message });
  }
};

/** Elimina un ajuste manual. */
exports.deleteDoctorAdjustment = async (req, res) => {
  try {
    const adj = await CommissionAdjustment.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!adj) return res.status(404).json({ message: 'Ajuste no encontrado' });
    res.json({ message: 'Ajuste eliminado' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar el ajuste', error: e.message });
  }
};

// ─────────── Pagos de comisiones por período (solo super-admin) ───────────

const fmtDia = (d) => new Date(d).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' });

/**
 * MARCA COMO PAGADO lo que ganaron uno o varios doctores en un período.
 *
 * Por cada doctor se toma lo PENDIENTE del período (comisiones cuya cita cae
 * dentro, en las sucursales del pago, más los ajustes cuyo rango entero cae
 * dentro) y se registra un CommissionPayout con esa foto. Desde ese momento esas
 * comisiones salen de «Por pagar». Un pago que se solape con otro del mismo
 * doctor en la misma sucursal se rechaza: una cita no puede pagarse dos veces.
 */
exports.createPayouts = async (req, res) => {
  try {
    const { start, end, clinic = 'all', note = '' } = req.body || {};
    const doctors = [...new Set((Array.isArray(req.body?.doctors) ? req.body.doctors : [req.body?.doctor])
      .filter((d) => mongoose.isValidObjectId(d)).map(String))];
    if (!doctors.length) return res.status(400).json({ message: 'Selecciona al menos un doctor' });
    if (!start || !end) return res.status(400).json({ message: 'Indica el período (desde y hasta)' });
    const { startDate, endDate } = parseRange(start, end);
    if (startDate > endDate) return res.status(400).json({ message: 'La fecha «desde» es posterior a «hasta»' });
    const porSucursal = clinic && clinic !== 'all' && mongoose.isValidObjectId(clinic);
    const clinics = porSucursal ? [String(clinic)] : [];

    const solapes = await CommissionPayout.find({
      doctor: { $in: doctors },
      start: { $lte: endDate },
      end: { $gte: startDate },
      ...(porSucursal ? { $or: [{ clinics: { $size: 0 } }, { clinics: clinic }] } : {}),
    }).populate('doctor', 'name').lean();
    if (solapes.length) {
      const s = solapes[0];
      return res.status(409).json({
        message: `${s.doctor?.name || 'El doctor'} ya tiene un pago registrado del ${fmtDia(s.start)} al ${fmtDia(s.end)} que se cruza con este período. Elimínalo o ajusta las fechas.`,
      });
    }

    const calc = await calcularComisionesDoctores(req.clinicId, {
      start, end, clinic: porSucursal ? String(clinic) : 'all', doctor: doctors.join(','),
    });

    const creados = [];
    const sinPendiente = [];
    for (const doctorId of doctors) {
      const lineas = calc.lineas.filter((l) => l.doctorId === doctorId && !l.pagada && l.amount);
      const ajustes = (calc.ajustesPorDoctor.get(doctorId) || []).filter((a) =>
        !a.pagado && new Date(a.start) >= startDate && new Date(a.end) <= endDate);
      const nombre = calc.doctores.get(doctorId)?.name
        || (await User.findById(doctorId).select('name').lean())?.name || 'Doctor';
      if (!lineas.length && !ajustes.length) {
        sinPendiente.push(nombre);
        continue;
      }
      const amount = +(sumar(lineas) + sumar(ajustes)).toFixed(2);
      // eslint-disable-next-line no-await-in-loop
      const payout = await CommissionPayout.create({
        clinic: req.clinicId,
        doctor: doctorId,
        clinics,
        start: startDate,
        end: endDate,
        amount,
        count: lineas.length,
        lines: [
          ...lineas.map((l) => ({
            appointment: l.apptId,
            kind: l.kind,
            concept: `${fmtDia(l.date)} · ${l.patient} · ${l.serviceName}`,
            amount: l.amount,
          })),
          ...ajustes.map((a) => ({ appointment: null, kind: 'ajuste', concept: a.note || 'Ajuste manual', amount: a.amount })),
        ],
        note: String(note || '').trim(),
        createdBy: req.user._id,
      });
      creados.push({ id: String(payout._id), doctorId, name: nombre, amount, count: lineas.length });
    }

    if (!creados.length) {
      return res.status(400).json({ message: 'No hay comisiones pendientes de pago en ese período', sinPendiente });
    }
    res.status(201).json({ created: creados, sinPendiente });
  } catch (e) {
    res.status(500).json({ message: 'Error al registrar el pago', error: e.message });
  }
};

/** Deshace un pago: sus comisiones vuelven a «Por pagar». */
exports.deletePayout = async (req, res) => {
  try {
    const p = await CommissionPayout.findByIdAndDelete(req.params.id);
    if (!p) return res.status(404).json({ message: 'Pago no encontrado' });
    res.json({ message: 'Pago eliminado' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar el pago', error: e.message });
  }
};

// ─────────── PDF por doctor (solo super-admin) ───────────

const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const CONCEPTO_LINEA = { servicio: 'Servicio', paciente: 'Paciente atendido', derivacion: 'Derivación' };

/**
 * Reporte PDF de comisiones de un doctor en el período: una fila por comisión
 * (servicio, paciente atendido o derivación realizada) con fecha, paciente,
 * concepto, valor y si ya está pagada; los ajustes manuales y los totales
 * (ganado, ya pagado y pendiente por pagar). Sale del mismo cálculo que el
 * resumen, así que el PDF y la pantalla no pueden decir cifras distintas.
 */
exports.doctorReportPdf = async (req, res) => {
  try {
    const calc = await calcularComisionesDoctores(req.clinicId, req.query);
    const { estados, startDate, endDate, appts } = calc;
    const doctorId = parseList(req.query.doctor)[0] || '';
    const doctorName = calc.doctores.get(doctorId)?.name || appts.find((a) => a.doctor?.name)?.doctor?.name || 'Doctor';

    const lineas = calc.lineas
      .filter((l) => !doctorId || l.doctorId === doctorId)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const ajustes = [...calc.ajustesPorDoctor.entries()]
      .filter(([did]) => !doctorId || did === doctorId)
      .flatMap(([, lista]) => lista);

    const totalComisiones = sumar(lineas);
    const totalAjustes = sumar(ajustes);
    const totalGanado = +(totalComisiones + totalAjustes).toFixed(2);
    const totalPagado = +(sumar(lineas.filter((l) => l.pagada)) + sumar(ajustes.filter((a) => a.pagado))).toFixed(2);
    const totalPendiente = +(totalGanado - totalPagado).toFixed(2);
    const citasDoctor = appts.filter((a) => !doctorId || idDe(a.doctor) === doctorId).length;

    const fmtMoney = (v) => `$${Number(v || 0).toFixed(2)}`;
    const fechaCorta = (d) => new Date(d).toISOString().slice(0, 10).split('-').reverse().join('/');
    const filasDetalle = lineas.length
      ? lineas.map((l) => {
          const base = l.kind === 'derivacion'
            ? `Derivación: ${l.serviceName}${l.atendidaPor ? ` (atendió ${l.atendidaPor})` : ''}`
            : l.kind === 'paciente' ? 'Paciente atendido'
            : `${l.serviceName}${l.repetida ? ' — ya lo había recibido (solo paga la primera vez)' : ''}`;
          const concepto = l.franja ? `${base} · horario ${l.franja}` : base;
          return `
            <tr>
              <td>${escapeHtml(fechaCorta(l.date))}</td>
              <td>${escapeHtml(l.patient)}</td>
              <td>${escapeHtml(concepto)}</td>
              <td class="num">${fmtMoney(l.amount)}</td>
            </tr>`;
        }).join('')
      : '<tr><td colspan="4" class="vacio">Sin comisiones en el período.</td></tr>';

    const filasAjustes = ajustes.map((a) => `
            <tr>
              <td>${fechaCorta(a.start)} — ${fechaCorta(a.end)}</td>
              <td>${escapeHtml(a.note || '—')}</td>
              <td class="num">${fmtMoney(a.amount)}</td>
            </tr>`).join('');

    const rango = `${fechaCorta(startDate)} — ${fechaCorta(endDate)}`;
    const estadosLabel = (estados.length ? estados : ESTADOS_ATENDIDA).join(', ');

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Reporte de comisiones - ${escapeHtml(doctorName)}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 26px; font-size: 12px; }
  h1 { color: #047857; margin: 0 0 4px 0; font-size: 20px; }
  .header { border-bottom: 2px solid #10b981; padding-bottom: 10px; margin-bottom: 14px; }
  .meta { margin-bottom: 14px; color: #475569; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { background: #ecfdf5; text-align: left; padding: 6px 8px; border: 1px solid #e2e8f0; font-size: 11px; }
  td { padding: 5px 8px; border: 1px solid #e2e8f0; }
  .num { text-align: right; white-space: nowrap; }
  .vacio { text-align: center; color: #94a3b8; padding: 14px; }
  .totales { margin-top: 14px; width: 50%; margin-left: auto; }
  .totales td { border: none; padding: 3px 8px; }
  .totales .lbl { text-align: right; color: #475569; }
  .totales .val { text-align: right; font-weight: bold; white-space: nowrap; }
  .totales .final .lbl, .totales .final .val { font-size: 13px; color: #047857; border-top: 2px solid #10b981; padding-top: 6px; }
  .subtitulo { font-size: 13px; font-weight: bold; color: #047857; margin-top: 16px; text-transform: uppercase; letter-spacing: 0.4px; }
  .footer { margin-top: 26px; font-size: 10px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>Reporte de comisiones</h1>
    <div>Doctor: <b>${escapeHtml(doctorName)}</b></div>
  </div>

  <div class="meta">
    Período: <b>${rango}</b> &nbsp;·&nbsp; Estados considerados: ${escapeHtml(estadosLabel)} &nbsp;·&nbsp; Citas en el filtro: ${citasDoctor}
  </div>

  <div class="subtitulo">Detalle de comisiones</div>
  <table>
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Paciente</th>
        <th>Concepto</th>
        <th class="num">Comisión</th>
      </tr>
    </thead>
    <tbody>${filasDetalle}</tbody>
  </table>

  ${ajustes.length ? `
  <div class="subtitulo">Ajustes manuales</div>
  <table>
    <thead>
      <tr>
        <th>Período</th>
        <th>Observación</th>
        <th class="num">Valor</th>
      </tr>
    </thead>
    <tbody>${filasAjustes}</tbody>
  </table>` : ''}

  <table class="totales">
    <tr><td class="lbl">Comisiones del período:</td><td class="val">${fmtMoney(totalComisiones)}</td></tr>
    ${ajustes.length ? `<tr><td class="lbl">Ajustes manuales:</td><td class="val">${fmtMoney(totalAjustes)}</td></tr>` : ''}
    <tr><td class="lbl">Total ganado:</td><td class="val">${fmtMoney(totalGanado)}</td></tr>
    <tr><td class="lbl">Ya pagado:</td><td class="val">${fmtMoney(totalPagado)}</td></tr>
    <tr class="final"><td class="lbl">Pendiente por pagar:</td><td class="val">${fmtMoney(totalPendiente)}</td></tr>
  </table>

  <div class="footer">
    Generado el ${new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })} · Sistema de gestión clínica
  </div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    const slug = doctorName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'doctor';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="comisiones_${slug}_${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}.pdf"`
    );
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generando PDF de comisiones:', error);
    res.status(500).json({ message: 'Error al generar el PDF de comisiones', error: error.message });
  }
};
