const Notification = require('../models/Notification');
const { resolveCallCenterClinicId } = require('../utils/callCenterClinic');
const { VALID_ROLES, DOCTOR_LIKE_ROLES } = require('../constants/roles');

/**
 * Bandeja de notificaciones del header (la campana). Es la vista GENÉRICA de
 * `Notification`: hoy la llenan los cambios de categoría/estado de plantillas de
 * WhatsApp y la calidad del número, pero cualquier módulo puede crear una
 * notificación y aparecerá aquí sin tocar este controlador.
 *
 * Qué tipos puede VER cada rol. La campana está en el header de TODA la app, así
 * que el filtro va por tipo y no por ruta: quien no tenga tipos visibles ve la
 * bandeja vacía en vez de un 403 que rompería el header.
 *
 * Regla: las notificaciones de MARKETING (plantillas de WhatsApp, calidad del
 * número) son solo para admin y marketing — nadie más las ve. Coincide con quién
 * puede entrar a las páginas donde se actúa sobre ellas (/message-templates y
 * /call-center-config son admin+marketing): mandar ahí a otro rol sería mandarlo
 * a una pantalla que no puede abrir.
 */
const MARKETING_ROLES = ['admin', 'marketing'];

const TYPE_ROLES = {
  template_category_changed: MARKETING_ROLES,
  template_status_changed: MARKETING_ROLES,
  template_check_failed: MARKETING_ROLES,
  whatsapp_quality_changed: MARKETING_ROLES,
  // Un número QR caído deja a la clínica sin recibir ni responder mensajes: hasta
  // ahora solo se notaba al entrar a mirar. Va a la campana para enterarse en el
  // momento, y apunta a la pantalla donde se reconecta.
  whatsapp_qr_disconnected: MARKETING_ROLES,
  // Atención de citas. Van dirigidas a UNA persona (ver el campo `user`), así
  // que aquí solo se declara qué roles pueden verlas en su campana.
  // Sale de DOCTOR_LIKE_ROLES: una especialidad nueva la hereda sin tocar esta
  // lista, que es justo lo que no pasó con las anteriores.
  appointment_assigned: ['admin', ...DOCTOR_LIKE_ROLES],
  appointment_nursing: ['admin', 'enfermero'],
  // El aviso de prueba lo pide uno mismo desde la campana: lo ve cualquiera.
  push_test: VALID_ROLES,
};

function visibleTypes(req) {
  if (req.user?.isSuperAdmin) return Object.keys(TYPE_ROLES);
  return Object.keys(TYPE_ROLES).filter((t) => TYPE_ROLES[t].includes(req.role));
}

/**
 * Ámbito de clínicas: la sucursal activa MÁS la clínica ancla del CRM. Las
 * alertas de plantillas/WhatsApp se guardan bajo la ancla (el call center es
 * único para toda la organización), así que sin esto un usuario con otra
 * sucursal activa no vería nunca una notificación de plantillas.
 */
async function scopeClinics(req) {
  const ids = [String(req.clinicId)];
  const anchor = await resolveCallCenterClinicId();
  if (anchor && !ids.includes(anchor)) ids.push(anchor);
  return ids;
}

/** Filtro base (clínicas + tipos visibles), o `null` si el rol no ve ninguno. */
async function baseFilter(req) {
  const types = visibleTypes(req);
  if (types.length === 0) return null;
  return {
    clinic: { $in: await scopeClinics(req) },
    // Las dirigidas a UNA persona solo las ve esa persona; las de clínica
    // (plantillas de WhatsApp, calidad del número) siguen filtrándose por tipo.
    $or: [{ user: null }, { user: req.user._id }],
    type: { $in: types },
  };
}

/**
 * LOS AVISOS DE ATENCIÓN SOLO SUENAN MIENTRAS LA CITA ESPERA.
 *
 * La campana acumulaba avisos de citas de días pasados —atendidas, canceladas,
 * marcadas no-show— porque casi nada en el sistema los apagaba: el único
 * deleteMany vivía en `nurseClaim`, y media clínica no pasa por ahí. El
 * resultado: decenas de notificaciones muertas que aturden a quien las recibe.
 *
 * La regla es la de la propia agenda (ver `bandejaDe` en el cliente): el aviso
 * vive SOLO mientras su cita sigue esperando a quien la atiende —
 *   · la cita está pendiente/confirmada/asistida (no completada, cancelada ni
 *     ausente);
 *
 * AVISO DE ENFERMERÍA (`appointment_nursing`):
 *   · el turno vigente es de ENFERMERÍA (si le toca al doctor, el aviso aún no
 *     va);
 *   · el turno está ABIERTO (para todos) o nombrado a quien mira, y todavía
 *     sin reclamar (startedAt): en cuanto alguien lo toma, ya no es noticia.
 *
 * AVISO DE CITA ASIGNADA (`appointment_assigned`):
 *   · el turno de doctor nombrado a quien mira sigue PENDIENTE — en cuanto lo
 *     atiende (su turno pasa a 'completado'), la cita ya no le debe nada y el
 *     aviso sobra; en citas viejas sin turnos manda el espejo `doctor`.
 *
 * Se aplica EN LECTURA, no solo al crear: así las notificaciones huérfanas que
 * ya están en Mongo dejan de sonar sin necesidad de migración, y el contador
 * de no leídas coincide con lo que la bandeja enseña. Los avisos de atención
 * que NO llevan la cita en `meta.appointment` (los anteriores a ese sello) se
 * dan por muertos: eran avisos de tarea pendiente y nada los apagaba.
 */
async function filtroDeAvisosVivos(req, filter) {
  const citaIds = await Notification.distinct('meta.appointment', {
    ...filter,
    type: { $in: ['appointment_nursing', 'appointment_assigned'] },
    'meta.appointment': { $ne: null },
  });
  if (!citaIds.length) return filter;

  const citas = await require('../models/Appointment')
    .find({ _id: { $in: citaIds } })
    .select('status doctor currentTurnKind currentTurnUser turns')
    .lean();
  const miId = String(req.user._id);
  const vivasNursing = [];
  const vivasAsignada = [];
  for (const a of citas) {
    if (!['pendiente', 'confirmada', 'asistida'].includes(a.status)) continue;

    // «Cita asignada» al doctor: sigue viva mientras su turno siga pendiente.
    // Atenderla (su turno pasa a 'completado'), cerrarla o pasarla a otro la
    // apaga — es el aviso de una tarea que ya no existe.
    const conTurnos = (a.turns || []).length > 0;
    const miTurnoDoctor =
      conTurnos && (a.turns || []).some(
        (t) => t.kind === 'doctor' && t.status === 'pendiente' && String(t.user) === miId
      );
    // Citas viejas, sin turnos: manda el espejo `doctor` (se completa y muere).
    if (miTurnoDoctor || (!conTurnos && String(a.doctor) === miId)) {
      vivasAsignada.push(a._id);
    }

    if (a.currentTurnKind !== 'enfermeria') continue;
    const dueño = a.currentTurnUser ? String(a.currentTurnUser) : null;
    // Nombrada a OTRO: no es noticia para quien mira.
    if (dueño && dueño !== miId) continue;
    if (dueño) {
      // Reclamada (ya hay quien la atiende): el aviso ya cumplió su trabajo.
      const turno = (a.turns || []).find((t) => t.kind === 'enfermeria' && t.status === 'pendiente');
      if (turno?.startedAt) continue;
    }
    vivasNursing.push(a._id);
  }

  return {
    ...filter,
    $and: [
      ...(filter.$and || []),
      {
        $or: [
          { type: { $nin: ['appointment_nursing', 'appointment_assigned'] } },
          { type: 'appointment_nursing', 'meta.appointment': { $in: vivasNursing } },
          { type: 'appointment_assigned', 'meta.appointment': { $in: vivasAsignada } },
        ],
      },
    ],
  };
}

// GET /notifications?unread=true&limit=30 → { items, unread }
// Devuelve la lista Y el contador de no leídas en una sola petición: la campana
// necesita las dos cosas y así no se piden por separado en cada sondeo.
exports.list = async (req, res) => {
  try {
    const base = await baseFilter(req);
    if (!base) return res.json({ items: [], unread: 0 });
    const filter = await filtroDeAvisosVivos(req, base);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const [items, unread] = await Promise.all([
      Notification.find(req.query.unread === 'true' ? { ...filter, read: false } : filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      Notification.countDocuments({ ...filter, read: false }),
    ]);
    res.json({ items, unread });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar notificaciones', error: err.message });
  }
};

// GET /notifications/unread-count → { unread }
exports.unreadCount = async (req, res) => {
  try {
    const base = await baseFilter(req);
    if (!base) return res.json({ unread: 0 });
    const filter = await filtroDeAvisosVivos(req, base);
    res.json({ unread: await Notification.countDocuments({ ...filter, read: false }) });
  } catch (err) {
    res.status(500).json({ message: 'Error al contar notificaciones', error: err.message });
  }
};

// POST /notifications/:id/read
exports.markRead = async (req, res) => {
  try {
    const filter = await baseFilter(req);
    if (!filter) return res.status(404).json({ message: 'No encontrada' });
    const notif = await Notification.findOneAndUpdate(
      { ...filter, _id: req.params.id },
      { read: true, readAt: new Date() },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: 'No encontrada' });
    res.json(notif);
  } catch (err) {
    res.status(500).json({ message: 'Error al marcar como leída', error: err.message });
  }
};

// POST /notifications/read-all
exports.markAllRead = async (req, res) => {
  try {
    const filter = await baseFilter(req);
    if (!filter) return res.json({ updated: 0 });
    const r = await Notification.updateMany(
      { ...filter, read: false },
      { read: true, readAt: new Date() }
    );
    res.json({ updated: r.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ message: 'Error al marcar como leídas', error: err.message });
  }
};

exports.TYPE_ROLES = TYPE_ROLES;
