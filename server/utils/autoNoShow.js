const Appointment = require('../models/Appointment');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');
const { appointmentDateTime } = require('./appointmentDate');

// Ecuador no tiene horario de verano (UTC-5 todo el año).
const EC_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * EL NO-SHOW SE DECIDE AL CERRAR EL DÍA, NO AL PASAR LA HORA.
 *
 * Antes bastaba con que pasara un minuto de la hora de inicio: la cita de las
 * 9:00 quedaba «no asistió» a las 9:01. Eso no es lo que ocurre en la clínica —
 * el paciente llega tarde, la consulta anterior se alargó, o entra por la puerta
 * mientras recepción atiende a otro— y tenía consecuencias que no se deshacían
 * solas: la agenda daba por ausente a alguien que estaba en la sala de espera,
 * el reporte lo contaba como falta, y la automatización de no-show le mandaba
 * un «lamentamos que no hayas podido venir» al móvil estando en recepción.
 *
 * Ahora una cita solo se da por perdida cuando su día ya terminó (medianoche en
 * Ecuador) y nadie la cerró. Durante todo el día sigue 'pendiente', que es la
 * verdad: todavía puede llegar. Marcarla antes sigue siendo posible a mano,
 * desde el mostrador, que es quien sabe si el paciente vino o no.
 */

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
 * Marca como 'no_asistio' las citas de días YA TERMINADOS que siguen en
 * 'pendiente'/'confirmada' — nadie las cerró y el día en que podían atenderse
 * se acabó.
 *
 * Las de HOY no se tocan, sea cual sea la hora: mientras el día siga corriendo
 * el paciente todavía puede llegar (ver la nota de arriba).
 */
async function runAutoNoShow() {
  try {
    const cutoff = ecTodayUtcMidnight();
    const vencidas = await Appointment.find({
      status: { $in: ['pendiente', 'confirmada'] },
      date: { $lt: cutoff },
    })
      .select(SELECT)
      .lean();

    const modified = await markNoShows(vencidas);
    if (modified > 0) {
      console.log(`[autoNoShow] ${modified} cita(s) de días anteriores marcadas como "no asistió".`);
    }
    return modified;
  } catch (err) {
    console.error('[autoNoShow] error:', err.message);
    return 0;
  }
}

/**
 * Arranca el job: corre una vez al inicio y luego cada 5 minutos.
 *
 * El intervalo corto ya no es para pillar las citas de hoy (esas esperan a que
 * termine el día), sino para que el barrido de medianoche ocurra a los pocos
 * minutos de cambiar el día y no cuando alguien reinicie el servidor.
 */
function startAutoNoShowJob() {
  runAutoNoShow();
  setInterval(runAutoNoShow, 5 * 60 * 1000);
}

module.exports = { runAutoNoShow, startAutoNoShowJob };
