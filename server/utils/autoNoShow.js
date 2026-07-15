const Appointment = require('../models/Appointment');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');
const { appointmentDateTime } = require('./appointmentDate');

// Ecuador no tiene horario de verano (UTC-5 todo el año).
const EC_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Devuelve la medianoche (UTC) del día calendario actual en Ecuador.
 * Las fechas de cita se guardan como medianoche UTC del día calendario, así que
 * comparar contra este valor permite detectar las citas de días YA pasados.
 */
function ecTodayUtcMidnight() {
  const ec = new Date(Date.now() - EC_OFFSET_MS);
  return new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate()));
}

/**
 * Marca como 'no_asistio' todas las citas de días anteriores a hoy que quedaron
 * en estado 'pendiente' o 'confirmada' (el paciente no asistió y nadie la cerró).
 */
async function runAutoNoShow() {
  try {
    const cutoff = ecTodayUtcMidnight();
    const filter = { date: { $lt: cutoff }, status: { $in: ['pendiente', 'confirmada'] } };
    // Tomamos los datos ANTES de actualizar para poder disparar workflows por cita.
    const affected = await Appointment.find(filter)
      .select('clinic patient date startTime isFirstVisit services')
      .lean();
    const res = await Appointment.updateMany(filter, { $set: { status: 'no_asistio' } });
    const modified = res.modifiedCount ?? res.nModified ?? 0;
    if (modified > 0) {
      console.log(`[autoNoShow] ${modified} cita(s) marcadas como "no asistió".`);
      for (const appt of affected) {
        emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_NO_SHOW, {
          clinicId: String(appt.clinic),
          patientId: appt.patient ? String(appt.patient) : null,
          appointmentId: String(appt._id),
          appointmentDate: appointmentDateTime(appt.date, appt.startTime),
          isFirstVisit: !!appt.isFirstVisit,
          services: (appt.services || []).map((s) => String(s.product)).filter(Boolean),
        });
      }
    }
    return modified;
  } catch (err) {
    console.error('[autoNoShow] error:', err.message);
    return 0;
  }
}

/**
 * Arranca el job: corre una vez al inicio y luego cada 30 minutos.
 */
function startAutoNoShowJob() {
  runAutoNoShow();
  setInterval(runAutoNoShow, 30 * 60 * 1000);
}

module.exports = { runAutoNoShow, startAutoNoShowJob };
