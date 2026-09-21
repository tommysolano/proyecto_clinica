/**
 * LOS BLOQUEOS DE HORARIO QUE APLICAN A UNA CITA, en un solo sitio.
 *
 * Lo usan TODAS las puertas donde una cita nace: crear (con sucursal destino)
 * y editar en la agenda, la tanda de citas del chat/CRM y la reserva pública.
 * Replicado en cada puerta, una decía «bloqueado» y otra dejaba pasar la misma
 * cita — el bloqueo del día 20 «no hacía nada» según quien lo probaba desde el
 * CRM. Ver también appointmentController (que delega aquí) y utils/booking.js
 * (que recibe los rangos ya resueltos).
 *
 * SEMÁNTICA (sep-2026): un bloqueo declara cero o más dimensiones —servicio,
 * doctor, consultorio— y aplica a la cita cuando TODAS las que declara
 * coinciden. Un bloqueo sin nada declarado es GENERAL: bloquea todo en su
 * sucursal. El servicio se declara con el catálogo de la agenda
 * (AppointmentServiceItem) y casa también con el legado del inventario
 * (`services[].product`), igual que el filtro de servicio de la agenda.
 */

/** 'Mujer Sana 360 ' → 'mujer sana 360' (para casar bloqueo y cita por nombre). */
const normalizaNombre = (v) => String(v || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Bloqueos de la sucursal que tocan a la fecha de la cita.
 * @param {object} p
 * @param {string} p.clinicId sucursal destino de la cita
 * @param {Date|string} p.date fecha de la cita (día calendario)
 * @param {Array} p.serviceIds ids del servicio de la cita (catálogo de la agenda
 *   y/o productos legados del inventario)
 * @param {Array} [p.serviceNames] nombres de los servicios de la cita. El
 *   bloqueo guarda un AppointmentServiceItem, pero la cita puede venir agendada
 *   con el Product/programa homónimo (ids de colecciones distintas que NUNCA
 *   van a casar): con los nombres se cruza igual que el filtro de la agenda.
 * @param {string|null} p.doctor doctor asignado
 * @param {string|null} p.room consultorio
 */
async function bloqueosQueAplican({ clinicId, date, serviceIds = [], serviceNames = [], doctor = null, room = null }) {
  const TimeBlock = require('../models/TimeBlock');
  const blocks = await TimeBlock.find({
    clinic: clinicId,
    startDate: { $lte: date },
    endDate: { $gte: date },
  }).lean();
  const servicios = new Set((serviceIds || []).filter(Boolean).map(String));
  const nombresCita = new Set((serviceNames || []).map(normalizaNombre).filter(Boolean));
  const doc = doctor ? String(doctor) : null;
  const sala = room ? String(room) : null;

  // Nombres de los servicios de los bloqueos (una sola consulta para todos).
  const idsBloqueo = [...new Set(blocks.filter((b) => b.service).map((b) => String(b.service)))];
  let nombreDeBloqueo = new Map();
  if (idsBloqueo.length && nombresCita.size) {
    const AppointmentServiceItem = require('../models/AppointmentServiceItem');
    const docs = await AppointmentServiceItem.find({ _id: { $in: idsBloqueo } }).select('name').lean();
    nombreDeBloqueo = new Map(docs.map((d) => [String(d._id), normalizaNombre(d.name)]));
  }

  return blocks.filter((b) => {
    if (b.service) {
      const casaPorId = servicios.has(String(b.service));
      const casaPorNombre = nombresCita.has(nombreDeBloqueo.get(String(b.service)));
      if (!casaPorId && !casaPorNombre) return false;
    }
    if (b.doctor && String(b.doctor) !== doc) return false;
    if (b.room && String(b.room) !== sala) return false;
    return true;
  });
}

/** ¿El horario de la cita cae dentro del bloqueo? (allDay o sin horas = todo el día) */
function bloqueaElHorario(block, start, end) {
  if (block.allDay || !block.startTime || !block.endTime) return true;
  // `>=` abajo: una cita que empieza justo cuando empieza el bloqueo, cae.
  return start < block.endTime && (end || start) >= block.startTime;
}

function mensajeBloqueo(block) {
  return `Horario bloqueado por administración${block.reason ? `: ${block.reason}` : ''}`;
}

/**
 * Convenience: el PRIMER bloqueo que impide esta cita, o null si ninguna.
 * Es lo que cada puerta de agendamiento necesita contestar de una vez.
 */
async function bloqueoQueRechaza({ clinicId, date, startTime, endTime, serviceIds, serviceNames, doctor, room }) {
  const bloqueos = await bloqueosQueAplican({ clinicId, date, serviceIds, serviceNames, doctor, room });
  return bloqueos.find((b) => bloqueaElHorario(b, startTime, endTime)) || null;
}

module.exports = {
  bloqueosQueAplican,
  bloqueaElHorario,
  mensajeBloqueo,
  bloqueoQueRechaza,
};
