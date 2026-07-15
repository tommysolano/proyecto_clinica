const Appointment = require('../models/Appointment');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');
const { appointmentDateTime } = require('./appointmentDate');

// Ecuador no tiene horario de verano (UTC-5 todo el año).
const EC_OFFSET_MS = 5 * 60 * 60 * 1000;

// Margen mínimo tras la hora de INICIO antes de marcar no-show. Regla de
// negocio: pasada la hora de la cita sin que recepción la marque 'asistida',
// es no-show (dispara la automatización de inmediato). Si el paciente llega
// tarde, recepción puede marcarla 'asistida' igual después.
const GRACE_MS = 60 * 1000;

/**
 * Devuelve la medianoche (UTC) del día calendario actual en Ecuador.
 * Las fechas de cita se guardan ancladas al día calendario (12:00 local hoy;
 * medianoche UTC en registros viejos): ambas caen dentro de [cutoff, cutoff+24h)
 * de su día, así que comparar contra este valor separa días pasados/hoy.
 */
function ecTodayUtcMidnight() {
  const ec = new Date(Date.now() - EC_OFFSET_MS);
  return new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate()));
}

/**
 * ¿Una cita de HOY ya venció sin que nadie la atienda? PURO y testeable.
 * Vence apenas pasa su hora de INICIO (margen de 1 min): el paciente no llegó.
 * La hora de fin no cuenta: si nadie la recibió al empezar, es no-show.
 * Sin hora de inicio válida no se puede saber: se marca recién al día siguiente.
 */
function isNoShowDue(appt, now = new Date()) {
  if (!/^\d{1,2}:\d{2}$/.test(String(appt?.startTime || ''))) return false;
  const start = appointmentDateTime(appt.date, appt.startTime);
  if (!start) return false;
  return now.getTime() > start.getTime() + GRACE_MS;
}

/** Marca las citas dadas como no_asistio y emite el evento de dominio por cada una. */
async function markNoShows(appointments) {
  if (!appointments.length) return 0;
  await Appointment.updateMany(
    { _id: { $in: appointments.map((a) => a._id) } },
    { $set: { status: 'no_asistio' } }
  );
  for (const appt of appointments) {
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_NO_SHOW, {
      clinicId: String(appt.clinic),
      patientId: appt.patient ? String(appt.patient) : null,
      appointmentId: String(appt._id),
      appointmentDate: appointmentDateTime(appt.date, appt.startTime),
      isFirstVisit: !!appt.isFirstVisit,
      services: (appt.services || []).map((s) => String(s.product)).filter(Boolean),
    });
    // Refresco en vivo del calendario/lista de citas.
    try {
      require('../realtime').emitToClinic(appt.clinic, 'appointment:updated', { _id: appt._id, status: 'no_asistio' });
    } catch {
      /* realtime opcional */
    }
  }
  return appointments.length;
}

const SELECT = 'clinic patient date startTime endTime isFirstVisit services';

/**
 * Marca como 'no_asistio' las citas que quedaron en 'pendiente'/'confirmada':
 *  1) TODAS las de días anteriores a hoy (nadie las cerró), y
 *  2) las de HOY cuya hora de inicio ya pasó — antes seguían "pendientes"
 *     toda la tarde.
 */
async function runAutoNoShow() {
  try {
    const cutoff = ecTodayUtcMidnight();
    const OPEN = { status: { $in: ['pendiente', 'confirmada'] } };

    // 1) Días anteriores: vencidas sin importar la hora.
    const pastDays = await Appointment.find({ ...OPEN, date: { $lt: cutoff } })
      .select(SELECT)
      .lean();

    // 2) Hoy: las que ya pasaron de su hora de inicio.
    const todayEnd = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
    const todays = await Appointment.find({ ...OPEN, date: { $gte: cutoff, $lt: todayEnd } })
      .select(SELECT)
      .lean();
    const now = new Date();
    const dueToday = todays.filter((a) => isNoShowDue(a, now));

    const modified = await markNoShows([...pastDays, ...dueToday]);
    if (modified > 0) {
      console.log(`[autoNoShow] ${modified} cita(s) marcadas como "no asistió" (${dueToday.length} de hoy).`);
    }
    return modified;
  } catch (err) {
    console.error('[autoNoShow] error:', err.message);
    return 0;
  }
}

/**
 * Arranca el job: corre una vez al inicio y luego cada 5 minutos (una cita
 * vencida debe reflejar el no-show a los pocos minutos, no al día siguiente).
 */
function startAutoNoShowJob() {
  runAutoNoShow();
  setInterval(runAutoNoShow, 5 * 60 * 1000);
}

module.exports = { runAutoNoShow, startAutoNoShowJob, isNoShowDue };
