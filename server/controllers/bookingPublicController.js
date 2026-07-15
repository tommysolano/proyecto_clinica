const BookingConfig = require('../models/BookingConfig');
const Clinic = require('../models/Clinic');
const Appointment = require('../models/Appointment');
const TimeBlock = require('../models/TimeBlock');
const Patient = require('../models/Patient');
const { emitToClinic } = require('../realtime');
const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
const {
  generateSlots,
  filterAvailable,
  ecNowHHMM,
  parseLocalDate,
  addMinutesHHMM,
} = require('../utils/booking');
const { lookupTaxId } = require('../utils/cedulaLookup');
const { checkEmail } = require('../utils/emailValidation');

async function loadEnabledConfig(token) {
  if (!token) return null;
  const cfg = await BookingConfig.findOne({ token });
  if (!cfg || !cfg.enabled) return null;
  return cfg;
}

// Busca un producto reservable (servicio o programa) por su id de Product.
// Devuelve { product, name, durationMinutes } o null.
function findBookable(cfg, productId) {
  const svc = (cfg.services || []).find((s) => String(s.product) === String(productId));
  if (svc) return { product: svc.product, name: svc.name, durationMinutes: svc.durationMinutes };
  const prog = (cfg.programs || []).find((p) => String(p.product) === String(productId));
  if (prog) return { product: prog.product, name: prog.name || 'Programa', durationMinutes: prog.durationMinutes };
  return null;
}

// GET /api/public/booking/:token/lookup/:id → autocompletar nombre por cédula/RUC.
// Gated por un token de agenda válido; solo devuelve el nombre (no dirección ni
// clasificación tributaria) para no exponer datos de más en una página pública.
exports.lookup = async (req, res) => {
  const id = (req.params.id || '').trim();
  try {
    const cfg = await loadEnabledConfig(req.params.token);
    if (!cfg) return res.status(404).json({ message: 'Agenda no disponible' });
    const result = await lookupTaxId(id);
    res.json({
      found: result.found,
      firstName: result.firstName || '',
      lastName: result.lastName || '',
      fullName: result.fullName || '',
      isCompany: !!result.isCompany,
    });
  } catch (error) {
    if (error.code === 'INVALID_CEDULA') {
      const isRuc = id.length === 13;
      return res.status(400).json({ message: isRuc ? 'RUC inválido' : 'Cédula inválida' });
    }
    res.status(500).json({ message: 'Error al consultar el SRI' });
  }
};

// GET /api/public/booking/:token/email?email=... → validación de correo (gated).
exports.emailLookup = async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ message: 'Falta el correo' });
  try {
    const cfg = await loadEnabledConfig(req.params.token);
    if (!cfg) return res.status(404).json({ message: 'Agenda no disponible' });
    res.json(await checkEmail(email));
  } catch (error) {
    res.status(500).json({ message: 'Error al validar el correo' });
  }
};

// GET /api/public/booking/:token  → info para renderizar la página de reserva.
exports.info = async (req, res) => {
  try {
    const cfg = await loadEnabledConfig(req.params.token);
    if (!cfg) return res.status(404).json({ message: 'Agenda no disponible' });
    const clinic = await Clinic.findById(cfg.clinic).select('name nombreComercial address phone');
    res.json({
      clinicName: clinic?.nombreComercial || clinic?.name || 'Clínica',
      address: cfg.addressText || clinic?.address || '',
      phone: cfg.phoneText || clinic?.phone || '',
      days: cfg.days,
      horizonDays: cfg.horizonDays,
      slotMinutes: cfg.slotMinutes,
      services: (cfg.services || []).map((s) => ({
        product: s.product,
        name: s.name,
        durationMinutes: s.durationMinutes,
      })),
      // Contenido de la landing pública.
      tagline: cfg.tagline || '',
      coverImageUrl: cfg.coverImageUrl || '',
      logoUrl: cfg.logoUrl || '',
      primaryColor: cfg.primaryColor || '#059669',
      aboutTitle: cfg.aboutTitle || '',
      about: cfg.about || '',
      highlights: cfg.highlights || [],
      gallery: cfg.gallery || [],
      programsTitle: cfg.programsTitle || '',
      programs: (cfg.programs || []).map((p) => ({
        product: p.product,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        priceLabel: p.priceLabel,
        durationMinutes: p.durationMinutes,
      })),
      instagram: cfg.instagram || '',
    });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
}

// Calcula los slots libres de un día para un servicio.
async function computeSlots(cfg, dateStr, service) {
  const date = parseLocalDate(dateStr);
  if (!date) return { error: 'Fecha inválida' };

  const weekday = date.getDay();
  if (!cfg.days.includes(weekday)) return { slots: [] };

  // Dentro del horizonte y no en el pasado (a nivel de día).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + cfg.horizonDays);
  if (day < today || day > horizon) return { slots: [] };

  const svc = findBookable(cfg, service);
  if (!svc) return { error: 'Servicio no disponible' };

  // Citas ya agendadas ese día (cualquier hora), no canceladas.
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  const appts = await Appointment.find({
    clinic: cfg.clinic,
    date: { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['cancelada'] },
  }).select('startTime');
  const takenCounts = {};
  appts.forEach((a) => { takenCounts[a.startTime] = (takenCounts[a.startTime] || 0) + 1; });

  // Bloqueos de horario a nivel de clínica (sin doctor/sala específicos).
  const blocks = await TimeBlock.find({
    clinic: cfg.clinic,
    doctor: null,
    room: null,
    startDate: { $lte: dayEnd },
    endDate: { $gte: dayStart },
  }).select('allDay startTime endTime');
  const blockedRanges = blocks.map((b) =>
    b.allDay ? { from: '00:00', to: '23:59' } : { from: b.startTime || '00:00', to: b.endTime || '23:59' }
  );

  const slots = generateSlots({ hourFrom: cfg.hourFrom, hourTo: cfg.hourTo, slotMinutes: cfg.slotMinutes });
  const available = filterAvailable(slots, {
    takenCounts,
    maxPerSlot: cfg.maxPerSlot,
    durationMin: svc.durationMinutes,
    blockedRanges,
    isToday: day.getTime() === today.getTime(),
    nowHHMM: ecNowHHMM(),
  });
  return { slots: available, durationMinutes: svc.durationMinutes };
}

// GET /api/public/booking/:token/slots?date=YYYY-MM-DD&service=<id>
exports.slots = async (req, res) => {
  try {
    const cfg = await loadEnabledConfig(req.params.token);
    if (!cfg) return res.status(404).json({ message: 'Agenda no disponible' });
    const { date, service } = req.query;
    if (!date || !service) return res.status(400).json({ message: 'Falta fecha o servicio' });
    const result = await computeSlots(cfg, date, service);
    if (result.error) return res.status(400).json({ message: result.error });
    res.json({ date, slots: result.slots });
  } catch (err) {
    res.status(500).json({ message: 'Error al calcular disponibilidad', error: err.message });
  }
};

// POST /api/public/booking/:token  → crea la cita.
exports.book = async (req, res) => {
  try {
    const cfg = await loadEnabledConfig(req.params.token);
    if (!cfg) return res.status(404).json({ message: 'Agenda no disponible' });

    const { date, startTime, service, firstName, lastName, phone, cedula, email } = req.body;
    if (!date || !startTime || !service) return res.status(400).json({ message: 'Fecha, hora y servicio son obligatorios' });
    if (!firstName || !lastName) return res.status(400).json({ message: 'Nombre y apellido son obligatorios' });
    if (!phone) return res.status(400).json({ message: 'El teléfono es obligatorio' });

    const svc = findBookable(cfg, service);
    if (!svc) return res.status(400).json({ message: 'Servicio no disponible' });

    // Re-validar disponibilidad del slot (evita carreras / manipulación).
    const result = await computeSlots(cfg, date, service);
    if (result.error) return res.status(400).json({ message: result.error });
    if (!result.slots.includes(startTime)) {
      return res.status(409).json({ message: 'Ese horario ya no está disponible. Elige otro.' });
    }

    const localDate = parseLocalDate(date);
    const cleanPhone = String(phone).replace(/[^\d]/g, '');

    // Buscar/crear paciente por cédula o teléfono.
    let patient = null;
    if (cedula) patient = await Patient.findOne({ clinic: cfg.clinic, cedula });
    if (!patient && cleanPhone) {
      patient = await Patient.findOne({ clinic: cfg.clinic, phone: { $regex: cleanPhone.slice(-9) + '$' } });
    }
    if (!patient) {
      patient = await Patient.create({
        clinic: cfg.clinic,
        firstName,
        lastName,
        cedula: cedula || '',
        phone: cleanPhone,
        whatsapp: cleanPhone,
        email: email || '',
        source: 'organico',
      });
    }

    const previousCount = await Appointment.countDocuments({ clinic: cfg.clinic, patient: patient._id });
    const appointment = await Appointment.create({
      clinic: cfg.clinic,
      patient: patient._id,
      date: localDate,
      startTime,
      endTime: addMinutesHHMM(startTime, svc.durationMinutes),
      services: [{ product: svc.product, name: svc.name }],
      status: 'pendiente',
      isFirstVisit: previousCount === 0,
      createdByRole: 'online',
      reason: `Reserva online: ${svc.name}`,
    });

    emitToClinic(cfg.clinic, 'appointment:created', { id: appointment._id });
    // Dispara workflows (p.ej. recordatorio de cita con confirmación).
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, {
      clinicId: String(cfg.clinic),
      patientId: String(patient._id),
      appointmentId: String(appointment._id),
      appointmentDate: require('../utils/appointmentDate').appointmentDateTime(localDate, startTime),
      isFirstVisit: appointment.isFirstVisit,
      services: [String(svc.product)],
    });

    res.status(201).json({
      ok: true,
      message: cfg.confirmationMessage,
      appointment: { date, startTime, service: svc.name },
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al agendar', error: err.message });
  }
};
