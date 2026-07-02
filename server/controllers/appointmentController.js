const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Patient = require('../models/Patient');
const { emitToClinic, emitToUser } = require('../realtime');
const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');

// Construye el payload de evento de dominio para una cita (para workflows).
function appointmentEventPayload(appt) {
  const patientId = appt.patient?._id || appt.patient;
  return {
    clinicId: String(appt.clinic),
    patientId: patientId ? String(patientId) : null,
    appointmentId: String(appt._id),
    appointmentDate: appt.date,
    isFirstVisit: !!appt.isFirstVisit,
    services: (appt.services || []).map((s) => String(s.product?._id || s.product)).filter(Boolean),
  };
}

const POPULATE_PATIENT = 'firstName lastName cedula phone whatsapp email birthDate age gender';
const POPULATE_DOCTOR = 'name specialty';
const POPULATE_CREATOR = 'name email';

// Convierte 'YYYY-MM-DD' (o ISO) a Date en zona local, fijando 12:00 para evitar
// que el cambio de zona horaria mueva el día al guardar/leer.
const parseLocalDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0);
  }
  return new Date(str);
};

// Valida 'HH:MM' (24h) y devuelve minutos desde medianoche, o null si inválido.
const toMinutes = (hhmm) => {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
};

exports.getAppointments = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      doctor,
      status,
      createdBy,
      isFirstVisit,
      service,
      fromTime,
      toTime,
      room,
      patient,
      origin,
      q,
      clinic: clinicParam,
    } = req.query;
    // Conjunto de sucursales a consultar:
    //  - `clinic=all` → VISTA UNIFICADA: todas las sucursales a las que el usuario
    //    tiene acceso (superadmin = todas). Así ninguna cita queda "escondida" por
    //    la sucursal activa (p.ej. una cita creada con "sucursal destino" distinta).
    //  - `clinic=<id>` (distinto al activo, con acceso) → esa sucursal (call center
    //    agendando para otra sede).
    //  - por defecto → la sucursal activa del usuario.
    const accessibleClinicIds = (req.user.clinics || []).map((c) => c.clinic);
    let clinicScope; // valor para query.clinic; null = sin filtro (todas, solo superadmin)
    if (clinicParam === 'all') {
      clinicScope = req.user.isSuperAdmin ? null : { $in: accessibleClinicIds };
    } else if (clinicParam && String(clinicParam) !== String(req.clinicId)) {
      const allowed =
        req.user.isSuperAdmin ||
        accessibleClinicIds.some((c) => String(c) === String(clinicParam));
      clinicScope = allowed ? clinicParam : req.clinicId;
    } else {
      clinicScope = req.clinicId;
    }
    const query = {};
    if (clinicScope !== null) query.clinic = clinicScope;

    if (startDate && endDate) {
      const start = parseLocalDate(startDate);
      const end = parseLocalDate(endDate);
      if (end) end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }
    if (doctor) query.doctor = doctor;
    if (status) query.status = status;
    if (createdBy) query.createdBy = createdBy;
    if (isFirstVisit === 'true') query.isFirstVisit = true;
    else if (isFirstVisit === 'false') query.isFirstVisit = { $ne: true };
    if (service) query['services.product'] = service;
    if (room) query.room = room;
    if (patient) query.patient = patient;
    if (origin) query.origin = origin;
    // Filtro por rango de horario (HH:MM)
    if (fromTime && toTime) {
      query.startTime = { $gte: fromTime, $lte: toTime };
    } else if (fromTime) {
      query.startTime = { $gte: fromTime };
    } else if (toTime) {
      query.startTime = { $lte: toTime };
    }

    if (req.role === 'doctor' || req.role === 'optica') {
      query.doctor = req.user._id;
    }
    // El call center puede ver TODAS las citas agendadas (no solo las suyas).
    if (req.role === 'enfermero') {
      // Enfermería ve las citas asistidas/completadas que tengan al menos un
      // servicio marcado como `nursingService` (p.ej. sueroterapia). La cita
      // aparece para TODOS los enfermeros del consultorio hasta que uno la
      // reclame con POST /:id/nurse-claim.
      // Catálogo compartido: los servicios de enfermería se identifican en toda la
      // organización (no por sucursal dueña); la cita ya está acotada a la sucursal.
      const nursingProductIds = await Product.find({
        nursingService: true,
      }).distinct('_id');
      query['services.product'] = { $in: nursingProductIds };
      query.status = query.status || { $in: ['asistida', 'completada'] };
      // Una cita reclamada por un enfermero desaparece para los demás: cada
      // enfermero solo ve las libres (sin reclamar) y las que él mismo reclamó.
      query.$or = [{ attendedByNurse: null }, { attendedByNurse: req.user._id }];
    }

    // Búsqueda libre por paciente (nombre, apellido, cédula o teléfono)
    if (q && String(q).trim()) {
      const term = String(q).trim();
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const matched = await Patient.find({
        ...(clinicScope !== null ? { clinic: clinicScope } : {}),
        $or: [
          { firstName: regex },
          { lastName: regex },
          { cedula: regex },
          { phone: regex },
          { whatsapp: regex },
        ],
      }).select('_id');
      const ids = matched.map((p) => p._id);
      if (query.patient) {
        // Si ya filtró por paciente concreto, lo respetamos.
      } else {
        query.patient = { $in: ids };
      }
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('room', 'name code')
      .populate('clinic', 'name nombreComercial')
      .populate('services.product', 'name code salePrice category nursingService')
      .sort({ date: 1, startTime: 1 });

    res.json(appointments);
  } catch (error) {
    console.error('[getAppointments] ERROR:', error);
    res.status(500).json({ message: 'Error al obtener citas', error: error.message, stack: error.stack });
  }
};

exports.getAppointment = async (req, res) => {
  try {
    // Vista unificada: la cita puede pertenecer a cualquier sucursal del usuario.
    const appointment = await Appointment.findOne({ _id: req.params.id })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('clinic', 'name nombreComercial')
      .populate('rescheduleHistory.rescheduledBy', 'name email')
      .populate('referral', 'fromDoctor toDoctor specialty reason status')
      .populate('treatmentRef', 'name status')
      .populate('services.product', 'name code salePrice category nursingService');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    // Verificar acceso: la sucursal de la cita debe estar entre las del usuario.
    const apptClinicId = String(appointment.clinic?._id || appointment.clinic);
    const canAccess =
      req.user.isSuperAdmin ||
      (req.user.clinics || []).some((c) => String(c.clinic) === apptClinicId);
    if (!canAccess) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener cita' });
  }
};

const buildServicesSnapshot = async (clinicId, items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const ids = items
    .map((s) => (typeof s === 'string' ? s : s.product))
    .filter(Boolean);
  if (ids.length === 0) return [];
  // Catálogo compartido entre sucursales: se resuelve el servicio por _id, no por la
  // sucursal dueña. La disponibilidad por sucursal (availableInClinics) se valida
  // aparte en createAppointment.
  const products = await Product.find({ _id: { $in: ids } }).select(
    'name salePrice'
  );
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((p) => ({ product: p._id, name: p.name, price: p.salePrice }));
};

exports.createAppointment = async (req, res) => {
  try {
    const { doctor, date, startTime, endTime, patient, services } = req.body;

    // El servicio es obligatorio para toda cita nueva (regla de negocio).
    const incomingServiceIds = (Array.isArray(services) ? services : [])
      .map((s) => (typeof s === 'string' ? s : s?.product))
      .filter(Boolean);
    if (incomingServiceIds.length === 0) {
      return res
        .status(400)
        .json({ message: 'Debes seleccionar al menos un servicio para la cita.' });
    }

    // El call_center puede operar para cualquiera de las clínicas a las que tiene acceso.
    // Si envía un `clinic` distinto al activo, validamos que sea una clínica donde tiene rol.
    let targetClinicId = req.clinicId;
    if (req.body.clinic && String(req.body.clinic) !== String(req.clinicId)) {
      const allowedClinic = (req.user.clinics || []).find(
        (c) => String(c.clinic) === String(req.body.clinic)
      );
      if (!allowedClinic && !req.user.isSuperAdmin) {
        return res
          .status(403)
          .json({ message: 'No tienes acceso a esa clínica para crear citas.' });
      }
      targetClinicId = req.body.clinic;
    }

    // --- Validaciones de fecha y horario ---
    const localDate = parseLocalDate(date);
    if (!localDate || Number.isNaN(localDate.getTime())) {
      return res.status(400).json({ message: 'Fecha inválida' });
    }
    const startMin = toMinutes(startTime);
    const endMin = endTime ? toMinutes(endTime) : null;
    if (startMin === null) {
      return res
        .status(400)
        .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
    }
    if (endMin !== null && endMin <= startMin) {
      return res
        .status(400)
        .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
    }

    // NOTA: Antes se rechazaba si el doctor tenía otra cita en el mismo horario.
    // Por requerimiento del negocio se permite que un mismo doctor atienda a
    // varios pacientes en la misma fecha y horario. Solo verificamos bloqueos
    // de horario (TimeBlock) creados por el administrador.
    const TimeBlock = require('../models/TimeBlock');
    const blocks = await TimeBlock.find({
      clinic: targetClinicId,
      $or: [
        { doctor: null, room: null },
        ...(doctor ? [{ doctor }] : []),
        ...(req.body.room ? [{ room: req.body.room }] : []),
      ],
      startDate: { $lte: localDate },
      endDate: { $gte: localDate },
    });
    for (const block of blocks) {
      // Determinar si el rango de la cita se solapa con el bloqueo.
      // Caso allDay o sin horario explícito → bloqueo aplica a todo el día.
      // De lo contrario: startTime < block.endTime && (endTime || startTime) >= block.startTime
      // Se usa >= en el límite inferior para incluir el caso "cita inicia justo cuando inicia el bloqueo".
      const inHours =
        block.allDay ||
        (!block.startTime || !block.endTime) ||
        (startTime < block.endTime && (endTime || startTime) >= block.startTime);
      if (inHours) {
        return res.status(400).json({
          message: `Horario bloqueado por administración${block.reason ? `: ${block.reason}` : ''}`,
        });
      }
    }

    // Validar que los servicios elegidos estén disponibles en la clínica destino.
    // Si un servicio está restringido (availableInClinics) a otra clínica, se rechaza.
    const serviceIds = (Array.isArray(services) ? services : [])
      .map((s) => (typeof s === 'string' ? s : s.product))
      .filter(Boolean);
    if (serviceIds.length > 0) {
      const restricted = await Product.find({
        _id: { $in: serviceIds },
        availableInClinics: { $exists: true, $not: { $size: 0 } },
      }).select('name availableInClinics');
      for (const p of restricted) {
        const allowed = (p.availableInClinics || []).some(
          (c) => String(c) === String(targetClinicId)
        );
        if (!allowed) {
          return res.status(400).json({
            message: `El servicio "${p.name}" no está disponible en este consultorio médico.`,
          });
        }
      }
    }

    // Validar límite de citas por horario para servicios con cupo.
    // Aplica únicamente a productos de categoría 'servicio' o 'programa'.
    // El cupo limita cuántas citas pueden coincidir en el mismo día + hora de inicio.
    if (serviceIds.length > 0) {
      const limited = await Product.find({
        _id: { $in: serviceIds },
        clinic: targetClinicId,
        category: { $in: ['servicio', 'programa'] },
        maxAppointmentsPerDay: { $gt: 0 },
      }).select('name maxAppointmentsPerDay');
      for (const prod of limited) {
        const used = await Appointment.countDocuments({
          clinic: targetClinicId,
          date: localDate,
          startTime,
          'services.product': prod._id,
        });
        if (used >= prod.maxAppointmentsPerDay) {
          return res.status(400).json({
            message: `Cupo agotado para el servicio "${prod.name}" en este horario (${startTime}). Máx. ${prod.maxAppointmentsPerDay} cita(s) simultáneas.`,
          });
        }
      }
    }

    // ¿Es primera cita del paciente?
    // Solo se considera "nuevo" si tiene servicios que NO estén marcados como
    // excludeFromFirstVisit. Si todos los servicios son recurrentes, no es nuevo.
    let isFirstVisit = false;
    const previousCount = await Appointment.countDocuments({
      clinic: targetClinicId,
      patient,
    });
    if (previousCount === 0) {
      if (serviceIds.length === 0) {
        isFirstVisit = true;
      } else {
        const counted = await Product.countDocuments({
          _id: { $in: serviceIds },
          clinic: targetClinicId,
          excludeFromFirstVisit: { $ne: true },
        });
        isFirstVisit = counted > 0;
      }
    }

    const servicesSnapshot = await buildServicesSnapshot(targetClinicId, services);

    // Normalizar ObjectId opcionales: convertir "" a undefined para evitar CastError
    const cleanBody = { ...req.body };
    if (cleanBody.doctor === '') delete cleanBody.doctor;
    if (cleanBody.room === '') delete cleanBody.room;
    if (cleanBody.referral === '') delete cleanBody.referral;
    if (cleanBody.treatmentRef === '') delete cleanBody.treatmentRef;

    const appointment = await Appointment.create({
      ...cleanBody,
      date: localDate,
      services: servicesSnapshot,
      isFirstVisit,
      clinic: targetClinicId,
      createdBy: req.user._id,
      createdByRole: req.role || null,
    });

    // Si la cita proviene de una derivación, sincronizar la derivación
    if (req.body.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: req.body.referral, clinic: targetClinicId },
          { appointment: appointment._id, status: 'agendada' }
        );
      } catch (e) {
        console.warn('No se pudo sincronizar derivación al crear cita:', e.message);
      }
    }

    const populated = await appointment
      .populate('patient', POPULATE_PATIENT)
      .then((doc) => doc.populate('doctor', POPULATE_DOCTOR))
      .then((doc) => doc.populate('createdBy', POPULATE_CREATOR))
      .then((doc) => doc.populate('services.product', 'name code salePrice category'));

    emitToClinic(targetClinicId, 'appointment:created', populated);
    if (populated.doctor?._id) {
      emitToUser(populated.doctor._id, 'appointment:created', populated);
    }
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, appointmentEventPayload(populated));

    res.status(201).json(populated);
  } catch (error) {
    console.error('[createAppointment] ERROR:', error);
    res.status(500).json({ message: 'Error al crear cita', error: error.message, stack: error.stack });
  }
};

exports.updateAppointment = async (req, res) => {
  try {
    // Permisos: solo admin puede editar cualquier cita.
    // Otros roles solo pueden editar las citas que ellos mismos crearon.
    // El doctor puede actualizar las suyas (diagnóstico, tratamiento, cronómetro, completar).
    const existing = await Appointment.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!existing) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isCreator = String(existing.createdBy || '') === String(req.user._id);
    const isAssignedDoctor =
      (req.role === 'doctor' || req.role === 'optica') && String(existing.doctor || '') === String(req.user._id);
    // Recepción (cajero/call_center) puede reagendar/editar cualquier cita.
    // La comisión NO cambia: queda con el creador original (createdBy se preserva).
    const isFrontDesk = ['cajero', 'call_center'].includes(req.role);
    if (!isAdmin && !isCreator && !isAssignedDoctor && !isFrontDesk) {
      return res.status(403).json({
        message:
          'Solo los administradores o el creador de la cita pueden editarla.',
      });
    }

    // Una cita completada solo puede ser editada por administradores
    if (existing.status === 'completada' && !isAdmin) {
      return res.status(403).json({
        message: 'Una cita completada no puede editarse. Contacta a un administrador.',
      });
    }

    const update = { ...req.body };
    // No permitir alterar isFirstVisit ni createdBy en updates
    delete update.isFirstVisit;
    delete update.createdBy;
    delete update.createdByRole;

    if (update.date !== undefined) {
      const localDate = parseLocalDate(update.date);
      if (!localDate || Number.isNaN(localDate.getTime())) {
        return res.status(400).json({ message: 'Fecha inválida' });
      }
      update.date = localDate;
    }

    if (update.startTime !== undefined || update.endTime !== undefined) {
      const startMin = toMinutes(update.startTime);
      const endMin = update.endTime ? toMinutes(update.endTime) : null;
      if (update.startTime !== undefined && startMin === null) {
        return res
          .status(400)
          .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
      }
      if (endMin !== null && startMin !== null && endMin <= startMin) {
        return res
          .status(400)
          .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
      }
    }

    if (Array.isArray(update.services)) {
      update.services = await buildServicesSnapshot(req.clinicId, update.services);
    }

    // Verificar bloqueos de horario si la fecha u hora cambió (no admin).
    const finalDate = update.date instanceof Date ? update.date : existing.date;
    const finalStart = update.startTime !== undefined ? update.startTime : existing.startTime;
    const finalEnd = update.endTime !== undefined ? update.endTime : existing.endTime;
    const finalDoctor = update.doctor !== undefined ? update.doctor : existing.doctor;
    const finalRoom = update.room !== undefined ? update.room : existing.room;
    if (!isAdmin && finalDate && finalStart) {
      const TimeBlock = require('../models/TimeBlock');
      const blocks = await TimeBlock.find({
        clinic: req.clinicId,
        $or: [
          { doctor: null, room: null },
          ...(finalDoctor ? [{ doctor: finalDoctor }] : []),
          ...(finalRoom ? [{ room: finalRoom }] : []),
        ],
        startDate: { $lte: finalDate },
        endDate: { $gte: finalDate },
      });
      for (const block of blocks) {
        const inHours =
          block.allDay ||
          (!block.startTime || !block.endTime) ||
          (finalStart < block.endTime && (finalEnd || finalStart) >= block.startTime);
        if (inHours) {
          return res.status(400).json({
            message: `Horario bloqueado por administración${block.reason ? `: ${block.reason}` : ''}`,
          });
        }
      }
    }

    // Detectar reagendamiento: si cambia la fecha o el horario respecto al
    // documento existente, registrar entrada en rescheduleHistory.
    const newDate = update.date instanceof Date ? update.date : null;
    const oldDateIso = existing.date instanceof Date ? existing.date.toISOString().slice(0, 10) : null;
    const newDateIso = newDate ? newDate.toISOString().slice(0, 10) : null;
    const dateChanged = newDateIso && oldDateIso && newDateIso !== oldDateIso;
    const startChanged =
      typeof update.startTime === 'string' && update.startTime !== existing.startTime;
    const endChanged =
      typeof update.endTime === 'string' && update.endTime !== existing.endTime;

    if (dateChanged || startChanged || endChanged) {
      const entry = {
        previousDate: existing.date,
        previousStartTime: existing.startTime,
        previousEndTime: existing.endTime,
        newDate: newDate || existing.date,
        newStartTime: update.startTime || existing.startTime,
        newEndTime: update.endTime || existing.endTime,
        rescheduledBy: req.user._id,
        rescheduledByName: req.user.name,
        rescheduledByRole: req.role || null,
        reason: req.body.rescheduleReason || req.body.reason || '',
        at: new Date(),
      };
      update.$push = { ...(update.$push || {}), rescheduleHistory: entry };
      // Si estaba completada/cancelada/no_asistio y se reagenda, volvemos a pendiente
      // (a menos que el cliente envíe un status explícito).
      if (!update.status && ['cancelada', 'no_asistio'].includes(existing.status)) {
        update.status = 'pendiente';
      }
    }

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    )
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('services.product', 'name code salePrice category');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    emitToClinic(req.clinicId, 'appointment:updated', appointment);
    if (appointment.doctor?._id) emitToUser(appointment.doctor._id, 'appointment:updated', appointment);
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cita', error: error.message });
  }
};

exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isCreator = String(appointment.createdBy || '') === String(req.user._id);
    if (!isAdmin && !isCreator) {
      return res.status(403).json({
        message:
          'Solo los administradores o el creador de la cita pueden eliminarla.',
      });
    }

    // Cancelar = marcar como 'cancelada' (preserva historial para reportes de marketing).
    // Solo el admin puede borrarla físicamente (con ?hard=true).
    if (req.query.hard === 'true' && (req.user.isSuperAdmin || req.role === 'admin')) {
      await Appointment.deleteOne({ _id: appointment._id });
      return res.json({ message: 'Cita eliminada' });
    }
    appointment.status = 'cancelada';
    await appointment.save();
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CANCELLED, appointmentEventPayload(appointment));
    res.json({ message: 'Cita cancelada', appointment });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar cita' });
  }
};

/**
 * Inicia el cronómetro de la cita (uso del doctor).
 */
exports.startConsultation = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isAssignedDoctor =
      (req.role === 'doctor' || req.role === 'optica') && String(appointment.doctor) === String(req.user._id);
    if (!isAdmin && !isAssignedDoctor) {
      return res.status(403).json({
        message: 'Solo el doctor asignado puede iniciar la consulta.',
      });
    }

    appointment.consultationStartedAt = new Date();
    appointment.consultationEndedAt = undefined;
    await appointment.save();
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al iniciar consulta', error: error.message });
  }
};

/**
 * Finaliza la consulta y la marca como completada.
 */
exports.endConsultation = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isAssignedDoctor =
      (req.role === 'doctor' || req.role === 'optica') && String(appointment.doctor) === String(req.user._id);
    if (!isAdmin && !isAssignedDoctor) {
      return res.status(403).json({
        message: 'Solo el doctor asignado puede finalizar la consulta.',
      });
    }

    appointment.consultationEndedAt = new Date();
    appointment.status = 'completada';
    await appointment.save();
    emitToClinic(req.clinicId, 'appointment:updated', appointment);
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(appointment));

    // Sincronizar derivación asociada
    if (appointment.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: appointment.referral, clinic: req.clinicId },
          { status: 'atendida' }
        );
      } catch (e) {
        console.warn('No se pudo sincronizar derivación al completar cita:', e.message);
      }
    }

    // Avance automático de tratamientos: si la cita tenía servicios y existe
    // un tratamiento activo del paciente que los incluya, sumar avance.
    try {
      const Treatment = require('../models/Treatment');
      const services = (appointment.services || []).map((s) => String(s.product));
      if (services.length && appointment.patient) {
        const treatments = await Treatment.find({
          clinic: req.clinicId,
          patient: appointment.patient,
          status: 'activo',
        });
        for (const t of treatments) {
          let changed = false;
          for (const svcId of services) {
            const idx = t.items.findIndex(
              (it) => String(it.product) === svcId && (it.completed || 0) < it.quantity
            );
            if (idx >= 0) {
              t.items[idx].completed += 1;
              t.items[idx].completionRefs.push({
                type: 'appointment',
                ref: appointment._id,
                date: new Date(),
              });
              changed = true;
            }
          }
          if (changed) {
            t.lastActivityAt = new Date();
            if (t.status === 'abandonado') {
              t.status = 'activo';
              t.abandonedAt = undefined;
            }
            if (t.progress >= 100) t.status = 'completado';
            await t.save();
          }
        }
      }
    } catch (e) {
      console.warn('No se pudo actualizar tratamientos por cita', e.message);
    }

    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al finalizar consulta', error: error.message });
  }
};

exports.getTodayAppointments = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      clinic: req.clinicId,
      date: { $gte: today, $lt: tomorrow },
    };

    if (req.role === 'doctor' || req.role === 'optica') {
      query.doctor = req.user._id;
    }
    // El call center puede ver TODAS las citas del día.
    if (req.role === 'enfermero') {
      // Catálogo compartido: los servicios de enfermería se identifican en toda la
      // organización (no por sucursal dueña); la cita ya está acotada a la sucursal.
      const nursingProductIds = await Product.find({
        nursingService: true,
      }).distinct('_id');
      query['services.product'] = { $in: nursingProductIds };
      query.status = { $in: ['asistida', 'completada'] };
      // Solo citas libres o reclamadas por este enfermero.
      query.$or = [{ attendedByNurse: null }, { attendedByNurse: req.user._id }];
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('services.product', 'name code salePrice category nursingService')
      .sort({ startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas del día' });
  }
};

/**
 * Genera un PDF imprimible de la cita.
 * Usa puppeteer (ya disponible en el proyecto para RIDE de facturas).
 */
exports.getAppointmentPdf = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR);

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const isoDate = appointment.date instanceof Date
      ? appointment.date.toISOString()
      : String(appointment.date || '');
    const dateMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const fmtDate = dateMatch
      ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`
      : new Date(appointment.date).toLocaleDateString('es-EC');
    const created = new Date(appointment.createdAt).toLocaleString('es-EC');
    const services = (appointment.services || [])
      .map(
        (s) =>
          `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0">${s.name || '—'}</td>` +
          `<td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">$${Number(
            s.price || 0
          ).toFixed(2)}</td></tr>`
      )
      .join('');

    const statusLabels = {
      pendiente: 'Pendiente',
      completada: 'Completada',
      // Compatibilidad con datos legacy
      programada: 'Pendiente',
      confirmada: 'Pendiente',
      en_curso: 'Pendiente',
      cancelada: 'Cancelada',
      no_asistio: 'No asistió',
    };

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Cita ${appointment._id}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 30px; }
  h1 { color: #047857; margin: 0 0 4px 0; }
  .header { border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .box { background: #f0fdf4; border-radius: 8px; padding: 10px 12px; }
  .label { font-size: 11px; color: #047857; text-transform: uppercase; font-weight: 600; }
  .val { font-size: 13px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { background: #ecfdf5; text-align: left; padding: 6px 8px; border: 1px solid #e2e8f0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #fef3c7; color: #92400e; }
  .footer { margin-top: 28px; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${clinic?.nombreComercial || clinic?.name || 'Clínica'}</h1>
    <div style="font-size:12px;color:#64748b">Comprobante de Cita Médica</div>
  </div>

  <div class="grid">
    <div class="box"><div class="label">Paciente</div><div class="val">${appointment.patient?.firstName || ''} ${appointment.patient?.lastName || ''}${
      appointment.isFirstVisit ? ' <span class="badge">PACIENTE NUEVO</span>' : ''
    }</div></div>
    <div class="box"><div class="label">Cédula</div><div class="val">${appointment.patient?.cedula || '—'}</div></div>
    <div class="box"><div class="label">Doctor</div><div class="val">Dr. ${appointment.doctor?.name || '—'} ${appointment.doctor?.specialty ? '— ' + appointment.doctor.specialty : ''}</div></div>
    <div class="box"><div class="label">Estado</div><div class="val">${statusLabels[appointment.status] || appointment.status}</div></div>
    <div class="box"><div class="label">Fecha</div><div class="val">${fmtDate}</div></div>
    <div class="box"><div class="label">Horario</div><div class="val">${appointment.startTime} — ${appointment.endTime}</div></div>
    <div class="box"><div class="label">Teléfono</div><div class="val">${appointment.patient?.phone || '—'}</div></div>
    <div class="box"><div class="label">Email</div><div class="val">${appointment.patient?.email || '—'}</div></div>
  </div>

  ${appointment.reason ? `<div class="box" style="margin-bottom:12px"><div class="label">Motivo</div><div class="val">${appointment.reason}</div></div>` : ''}

  ${services ? `<div class="label" style="margin-top:14px">Servicios</div><table><thead><tr><th>Servicio</th><th style="text-align:right">Precio</th></tr></thead><tbody>${services}</tbody></table>` : ''}

  ${appointment.diagnosis ? `<div class="box" style="margin-top:12px"><div class="label">Diagnóstico</div><div class="val">${appointment.diagnosis}</div></div>` : ''}
  ${appointment.treatment ? `<div class="box" style="margin-top:8px"><div class="label">Tratamiento</div><div class="val">${appointment.treatment}</div></div>` : ''}
  ${appointment.notes ? `<div class="box" style="margin-top:8px"><div class="label">Notas</div><div class="val">${appointment.notes}</div></div>` : ''}

  <div class="footer">
    Registrado por: ${appointment.createdBy?.name || '—'}${appointment.createdByRole ? ' (' + appointment.createdByRole + ')' : ''} &nbsp;|&nbsp; Creada: ${created}
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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="cita_${appointment._id}.pdf"`
    );
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generando PDF de cita:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};

/**
 * Estadísticas agregadas: total citas y porcentaje de asistencia.
 * Retorna { total, byStatus, attendanceRate } o por paciente si llega ?patient.
 */
exports.getStats = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinic: clinicObjId };
    const { startDate, endDate, patient, doctor, service } = req.query;
    if (startDate && endDate) {
      match.date = { $gte: parseLocalDate(startDate), $lte: parseLocalDate(endDate) };
      if (match.date.$lte) match.date.$lte.setHours(23, 59, 59, 999);
    }
    if (patient) match.patient = new mongoose.Types.ObjectId(patient);
    if (doctor) match.doctor = new mongoose.Types.ObjectId(doctor);
    if (service) match['services.product'] = new mongoose.Types.ObjectId(service);

    const grouped = await Appointment.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = grouped.reduce((acc, g) => {
      acc[g._id || 'pendiente'] = g.count;
      return acc;
    }, {});
    const total = grouped.reduce((s, g) => s + g.count, 0);

    // Asistencia: asistida + completada / (asistida + completada + no_asistio + cancelada)
    const attended = (byStatus.asistida || 0) + (byStatus.completada || 0);
    const missed = (byStatus.no_asistio || 0) + (byStatus.cancelada || 0);
    const denom = attended + missed;
    const attendanceRate = denom === 0 ? null : Math.round((attended / denom) * 100);

    // Desglose por rol que creó la cita (agendado vs. call_center)
    const byCreator = await Appointment.aggregate([
      { $match: match },
      { $group: { _id: '$createdByRole', count: { $sum: 1 } } },
    ]);
    const createdByRole = byCreator.reduce((acc, g) => {
      acc[g._id || 'desconocido'] = g.count;
      return acc;
    }, {});

    // Desglose por doctor que atendió (status asistida o completada)
    const byDoctor = await Appointment.aggregate([
      { $match: { ...match, status: { $in: ['asistida', 'completada'] } } },
      { $group: { _id: '$doctor', count: { $sum: 1 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'doctor',
        },
      },
      { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          count: 1,
          name: '$doctor.name',
          specialty: '$doctor.specialty',
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      total,
      byStatus,
      attended,
      missed,
      attendanceRate,
      createdByRole,
      byDoctor,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estadísticas', error: error.message });
  }
};

/**
 * Marca asistencia (uso del enfermero/recepción): pendiente/confirmada → asistida.
 * Puede recibir `doctorId` en el body para asignar al doctor al mismo tiempo,
 * que es el flujo nuevo (la cita se crea sin doctor y al llegar el paciente,
 * recepción lo asigna según disponibilidad).
 */
exports.markAttended = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    apt.status = 'asistida';
    if (req.body.doctorId) {
      apt.doctor = req.body.doctorId;
      apt.doctorAssignedAt = new Date();
      apt.doctorAssignedBy = req.user._id;
    }
    await apt.save();
    if (apt.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: apt.referral, clinic: req.clinicId },
          { status: 'atendida' }
        );
      } catch (_) {}
    }
    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category');
    emitToClinic(req.clinicId, 'appointment:updated', populated);
    if (populated.doctor?._id) emitToUser(populated.doctor._id, 'appointment:updated', populated);
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(populated));
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al marcar asistencia' });
  }
};

/**
 * Asigna o reasigna un doctor a la cita (recepción/admin).
 * No cambia el estado por sí mismo.
 */
exports.assignDoctor = async (req, res) => {
  try {
    const { doctorId } = req.body;
    if (!doctorId) return res.status(400).json({ message: 'doctorId requerido' });
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    apt.doctor = doctorId;
    apt.doctorAssignedAt = new Date();
    apt.doctorAssignedBy = req.user._id;
    await apt.save();
    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category');
    emitToClinic(req.clinicId, 'appointment:updated', populated);
    emitToUser(doctorId, 'appointment:assigned', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al asignar doctor', error: error.message });
  }
};

/**
 * Marca no asistencia.
 */
exports.markNoShow = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    apt.status = 'no_asistio';
    await apt.save();
    emitToClinic(req.clinicId, 'appointment:updated', apt);
    res.json(apt);
  } catch (error) {
    res.status(500).json({ message: 'Error al marcar no asistencia' });
  }
};

/**
 * Confirma una cita (paciente confirmó asistencia).
 */
exports.markConfirmed = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    apt.status = 'confirmada';
    await apt.save();
    emitToClinic(req.clinicId, 'appointment:updated', apt);
    res.json(apt);
  } catch (error) {
    res.status(500).json({ message: 'Error al confirmar cita' });
  }
};

/** Avanza los tratamientos del paciente al completar una cita de enfermería. */
const advanceTreatmentsForAppointment = async (clinicId, apt) => {
  try {
    const Treatment = require('../models/Treatment');
    const services = (apt.services || []).map((s) => String(s.product));
    if (!services.length || !apt.patient) return;
    const treatments = await Treatment.find({
      clinic: clinicId,
      patient: apt.patient,
      status: { $in: ['activo', 'abandonado'] },
    });
    for (const t of treatments) {
      let changed = false;
      for (const svcId of services) {
        const idx = t.items.findIndex(
          (it) => String(it.product) === svcId && (it.completed || 0) < it.quantity
        );
        if (idx >= 0) {
          t.items[idx].completed += 1;
          t.items[idx].completionRefs.push({ type: 'appointment', ref: apt._id, date: new Date() });
          changed = true;
        }
      }
      if (changed) {
        t.lastActivityAt = new Date();
        if (t.status === 'abandonado') { t.status = 'activo'; t.abandonedAt = undefined; }
        if (t.progress >= 100) t.status = 'completado';
        await t.save();
      }
    }
  } catch (e) {
    console.warn('No se pudo actualizar tratamientos (enfermería):', e.message);
  }
};

/**
 * Enfermero/a RECLAMA una cita de servicios de enfermería (p.ej. sueroterapia).
 * Cualquier enfermero puede reclamarla mientras `attendedByNurse` esté vacío.
 * Al reclamarla queda asignada a ese enfermero y desaparece para los demás; la
 * cita sigue en 'asistida' (en atención) hasta que el enfermero la finalice.
 */
exports.nurseClaim = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    if (apt.attendedByNurse && String(apt.attendedByNurse) !== String(req.user._id)) {
      return res.status(409).json({ message: 'Esta cita ya fue reclamada por otro enfermero/a.' });
    }
    if (apt.status !== 'asistida') {
      return res.status(400).json({ message: 'La cita debe estar en estado "asistida" para ser atendida por enfermería.' });
    }
    apt.attendedByNurse = req.user._id;
    if (!apt.consultationStartedAt) apt.consultationStartedAt = new Date();
    await apt.save();
    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category nursingService');
    emitToClinic(req.clinicId, 'appointment:updated', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al reclamar la cita', error: error.message });
  }
};

/**
 * Enfermero/a FINALIZA la cita que reclamó: pasa a 'completada' y registra
 * automáticamente en el seguimiento del paciente que se aplicó el servicio,
 * con el enfermero y los signos vitales (sin que el enfermero llene el formulario).
 */
exports.nurseComplete = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    if (!apt.attendedByNurse) {
      return res.status(400).json({ message: 'Primero reclama la cita para poder finalizarla.' });
    }
    if (String(apt.attendedByNurse) !== String(req.user._id) && !isAdmin) {
      return res.status(403).json({ message: 'Solo el enfermero/a que reclamó la cita puede finalizarla.' });
    }
    apt.status = 'completada';
    apt.nurseAttendedAt = new Date();
    if (!apt.consultationStartedAt) apt.consultationStartedAt = new Date();
    apt.consultationEndedAt = new Date();
    await apt.save();

    await advanceTreatmentsForAppointment(req.clinicId, apt);

    // Auto-registro en el seguimiento del paciente (no lo llena el enfermero).
    try {
      const ClinicalRecord = require('../models/ClinicalRecord');
      const serviceNames = (apt.services || []).map((s) => s.name).filter(Boolean).join(', ') || 'Servicio de enfermería';
      let record = await ClinicalRecord.findOne({ clinic: req.clinicId, patient: apt.patient });
      if (!record) {
        record = await ClinicalRecord.create({ clinic: req.clinicId, patient: apt.patient, createdBy: req.user._id });
      }
      const vs = req.body.vitalSigns || {};
      record.followUps.push({
        fecha: new Date(),
        kind: 'enfermeria',
        motivoConsulta: `Aplicación de enfermería: ${serviceNames}`,
        observaciones: req.body.note || `Servicio aplicado por enfermería.`,
        vitalSigns: {
          temperature: vs.temperature ?? null,
          bloodPressure: vs.bloodPressure || '',
          heartRate: vs.heartRate ?? null,
          respiratoryRate: vs.respiratoryRate ?? null,
          oxygenSaturation: vs.oxygenSaturation ?? null,
          weight: vs.weight ?? null,
          height: vs.height ?? null,
          glucose: vs.glucose ?? null,
        },
        createdBy: req.user._id,
      });
      record.updatedBy = req.user._id;
      await record.save();
    } catch (e) {
      console.warn('No se pudo registrar el seguimiento automático de enfermería:', e.message);
    }

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category nursingService');
    emitToClinic(req.clinicId, 'appointment:updated', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al finalizar la cita', error: error.message });
  }
};
