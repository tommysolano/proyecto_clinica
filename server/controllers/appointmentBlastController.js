/**
 * ENVÍO MASIVO A LAS CITAS DE LA AGENDA ("Recordatorios de citas").
 *
 * Sustituye al rodeo que se hacía antes: exportar la agenda a Excel, importarla
 * como contactos y lanzar el flujo desde ahí. La audiencia sale directamente de
 * las citas agendadas, así que el archivo —y los errores que traía escritos a
 * mano— desaparece. La importación de contactos SIGUE existiendo: es la buena
 * para gente que no está en el sistema (ferias, listas, bases antiguas).
 *
 * El orden es el mismo que el del asistente de importación:
 *   1. POST /appointment-blasts/preview → resuelve el filtro y devuelve las citas
 *      con quién SÍ y quién NO va a recibir el mensaje (y por qué). No crea nada.
 *   2. POST /appointment-blasts         → congela esa lista y encola el lote.
 *   3. Un job lo procesa e inscribe las citas de forma escalonada (goteo).
 *
 * ALCANCE DE SUCURSALES: estas rutas NO pasan por `callCenterScope` a propósito.
 * Las citas viven en su sucursal real y el usuario elige de cuáles quiere enviar;
 * la clínica ANCLA del CRM (donde viven workflows y chats) se resuelve aparte y
 * es la que se guarda en el lote.
 */
const mongoose = require('mongoose');
const AppointmentBlast = require('../models/AppointmentBlast');
const Appointment = require('../models/Appointment');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const { sucursalesVisibles } = require('../utils/clinicScope');
const { parseLocalDate } = require('../utils/appointmentDate');
const { resolveCallCenterClinicId } = require('../utils/callCenterClinic');
const { canReq } = require('../utils/permissions');
const { runBlast, MAX_APPOINTMENTS } = require('../utils/appointmentBlastRunner');

// Por defecto, las citas que SIGUEN EN PIE: a una cancelada o a una ya atendida
// no se le manda un recordatorio.
const DEFAULT_STATUSES = ['pendiente', 'confirmada'];
const ALL_STATUSES = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'];
const HHMM_RE = /^\d{1,2}:\d{2}$/;

/** ¿A este paciente se le puede escribir? (mismo criterio que el runner) */
const enviable = (p) => p?.marketing?.whatsappOptIn !== false && !p?.marketing?.optOutAt;
const phoneOf = (p) => String(p?.whatsapp || p?.phone || '').trim();

/**
 * Traduce el filtro del asistente a una consulta de citas, respetando SIEMPRE las
 * sucursales que esta persona alcanza. Una sede pedida a la que no llega se
 * ignora en silencio (no se puede enviar a lo que no se puede ver).
 */
function buildAppointmentQuery(req, filters = {}) {
  const query = {};

  const visibles = sucursalesVisibles(req); // null = todas
  const pedidas = (Array.isArray(filters.clinics) ? filters.clinics : [])
    .filter((c) => mongoose.isValidObjectId(c))
    .map(String);
  const permitidas = visibles === null ? pedidas : pedidas.filter((c) => visibles.some((v) => String(v) === c));
  if (permitidas.length) query.clinic = { $in: permitidas };
  else if (visibles !== null) query.clinic = { $in: visibles };

  // El rango es de DÍAS ENTEROS por las dos puntas (mismo criterio que la agenda:
  // `date` se guarda a las 12:00, pero una atención registrada por la mañana cae
  // por debajo de ese corte y desaparecía del rango).
  const start = parseLocalDate(filters.startDate);
  const end = parseLocalDate(filters.endDate || filters.startDate);
  if (start && end) {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    query.date = { $gte: start, $lte: end };
  }

  const statuses = (Array.isArray(filters.statuses) ? filters.statuses : []).filter((s) => ALL_STATUSES.includes(s));
  query.status = { $in: statuses.length ? statuses : DEFAULT_STATUSES };

  // HORARIO DENTRO de cada día elegido (opcional). `startTime` se guarda como
  // 'HH:MM' con ceros a la izquierda, así que el orden alfabético es también el
  // cronológico y alcanza con comparar la cadena. Sin rango, no se filtra.
  const pad = (s) => String(s).padStart(5, '0');
  const timeRange = {};
  if (HHMM_RE.test(String(filters.startTimeFrom || ''))) timeRange.$gte = pad(filters.startTimeFrom);
  if (HHMM_RE.test(String(filters.startTimeTo || ''))) timeRange.$lte = pad(filters.startTimeTo);
  if (timeRange.$gte || timeRange.$lte) query.startTime = timeRange;

  if (mongoose.isValidObjectId(filters.doctor)) query.doctor = filters.doctor;
  if (mongoose.isValidObjectId(filters.serviceItem)) query.serviceItem = filters.serviceItem;
  if (filters.isFirstVisit === 'true') query.isFirstVisit = true;
  else if (filters.isFirstVisit === 'false') query.isFirstVisit = { $ne: true };

  return query;
}

/** Filtros saneados tal como se van a guardar en el lote. */
function cleanFilters(filters = {}) {
  const startTimeFrom = HHMM_RE.test(String(filters.startTimeFrom || '')) ? String(filters.startTimeFrom) : '';
  const startTimeTo = HHMM_RE.test(String(filters.startTimeTo || '')) ? String(filters.startTimeTo) : '';
  return {
    startDate: String(filters.startDate || ''),
    endDate: String(filters.endDate || filters.startDate || ''),
    // Horario dentro del día (opcional): si "hasta" es menor que "desde", el
    // filtro no devuelve nada y la pantalla lo muestra; no se corrige a ciegas.
    startTimeFrom,
    startTimeTo,
    clinics: (Array.isArray(filters.clinics) ? filters.clinics : []).filter((c) => mongoose.isValidObjectId(c)),
    statuses: (Array.isArray(filters.statuses) ? filters.statuses : []).filter((s) => ALL_STATUSES.includes(s)),
    doctor: mongoose.isValidObjectId(filters.doctor) ? filters.doctor : null,
    serviceItem: mongoose.isValidObjectId(filters.serviceItem) ? filters.serviceItem : null,
    isFirstVisit: ['true', 'false'].includes(String(filters.isFirstVisit)) ? String(filters.isFirstVisit) : '',
  };
}

/**
 * Resuelve el filtro y clasifica cada cita: quién recibe el mensaje y quién no.
 *
 * La clasificación es la MITAD del valor de esta pantalla. Un envío que dice
 * "listo" mientras media lista se queda fuera en silencio es justo lo que hubo
 * que arreglar en la importación de contactos; aquí se ve antes de enviar.
 */
async function resolveAudience(req, filters) {
  const query = buildAppointmentQuery(req, filters);
  const citas = await Appointment.find(query)
    .populate('patient', 'firstName lastName phone whatsapp marketing')
    .populate('clinic', 'name')
    .populate('doctor', 'name')
    .populate('serviceItem', 'name')
    .select('_id clinic date startTime patient status serviceItem serviceName doctor isFirstVisit')
    .sort({ date: 1, startTime: 1 })
    .limit(MAX_APPOINTMENTS + 1)
    .lean();

  const truncated = citas.length > MAX_APPOINTMENTS;
  const lista = truncated ? citas.slice(0, MAX_APPOINTMENTS) : citas;

  // El teléfono solo se DEVUELVE a quien puede verlo (ver CONTACT_FIELDS en
  // patientController): censurar en React no es un permiso. Para decidir el envío
  // basta con saber si lo hay, y eso sí se puede contar sin enseñar el número.
  const puedeVerTelefono = canReq(req, 'patients.contactData') || canReq(req, 'patients.phone');

  const vistos = new Set(); // teléfonos ya incluidos: un mensaje por número
  const rows = lista.map((apt) => {
    const p = apt.patient;
    const phone = phoneOf(p);
    let reason = '';
    if (!p?._id) reason = 'sin_paciente';
    else if (!enviable(p)) reason = 'baja';
    else if (!phone) reason = 'sin_telefono';
    else if (vistos.has(phone)) reason = 'repetido';
    if (!reason) vistos.add(phone);

    return {
      _id: String(apt._id),
      date: apt.date,
      startTime: apt.startTime || '',
      status: apt.status,
      clinicName: apt.clinic?.name || '',
      doctorName: apt.doctor?.name || '',
      serviceName: apt.serviceItem?.name || apt.serviceName || '',
      patientName: p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : '',
      isFirstVisit: !!apt.isFirstVisit,
      hasPhone: !!phone,
      phone: puedeVerTelefono ? phone : '',
      eligible: !reason,
      reason,
    };
  });

  const counts = rows.reduce(
    (acc, r) => {
      if (r.eligible) acc.eligible++;
      else acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    },
    { eligible: 0 }
  );

  return { rows, counts, truncated, total: rows.length };
}

/** Paso 1 del asistente: a cuántas citas alcanza este filtro y quién queda fuera. */
exports.preview = async (req, res) => {
  try {
    const filters = cleanFilters(req.body?.filters || req.body || {});
    if (!filters.startDate) {
      return res.status(400).json({ message: 'Elige al menos la fecha de las citas.' });
    }
    const audience = await resolveAudience(req, filters);

    const warnings = [];
    if (audience.truncated) {
      warnings.push(
        `El filtro devuelve más de ${MAX_APPOINTMENTS} citas: se tomarán las primeras. Acota el rango de fechas.`
      );
    }
    // Un recordatorio de una cita que ya pasó es peor que no mandar nada.
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const finRango = parseLocalDate(filters.endDate || filters.startDate);
    if (finRango && finRango < hoy) {
      warnings.push('El rango que elegiste ya pasó: estarías recordando citas que ya ocurrieron.');
    }
    if (!audience.counts.eligible) {
      warnings.push('Ninguna cita del filtro puede recibir el mensaje: revisa los descartados.');
    }
    res.json({ ...audience, warnings });
  } catch (err) {
    res.status(500).json({ message: 'Error al calcular el envío', error: err.message });
  }
};

/** Paso 3: confirma, congela la lista de citas y encola el lote. */
exports.create = async (req, res) => {
  try {
    const filters = cleanFilters(req.body?.filters || {});
    if (!filters.startDate) {
      return res.status(400).json({ message: 'Elige al menos la fecha de las citas.' });
    }

    // Los workflows y las conversaciones viven en la clínica ANCLA del CRM, no en
    // la sucursal activa: el lote se guarda ahí para que el motor los encuentre.
    const anchorClinic = (await resolveCallCenterClinicId()) || req.clinicId;

    const workflowIds = (Array.isArray(req.body.workflows) ? req.body.workflows : [])
      .filter((w) => mongoose.isValidObjectId(w));
    if (!workflowIds.length) {
      return res.status(400).json({ message: 'Elige la automatización que va a enviar el recordatorio.' });
    }

    // Se valida AQUÍ y no en el runner: si no, el usuario elige una automatización
    // que nunca inscribe a nadie y parece que "el sistema no envía".
    const { matchingFlows } = require('../utils/workflowEngine');
    const docs = await Workflow.find({ _id: { $in: workflowIds }, clinic: anchorClinic });
    if (docs.length !== workflowIds.length) {
      return res.status(400).json({ message: 'Alguna automatización elegida no existe.' });
    }
    for (const wf of docs) {
      if (!wf.active) {
        return res.status(400).json({ message: `La automatización "${wf.name}" está desactivada: actívala antes de enviar.` });
      }
      if (!matchingFlows(wf, (tr) => tr?.type === 'appointment_bulk').length) {
        return res.status(400).json({
          message: `La automatización "${wf.name}" no tiene el disparador "Citas de la agenda" con pasos conectados.`,
        });
      }
    }

    const sendMode = ['now', 'at', 'flow'].includes(req.body.sendMode) ? req.body.sendMode : 'now';
    const sendAt = HHMM_RE.test(String(req.body.sendAt || '')) ? String(req.body.sendAt) : '';
    if (sendMode === 'at' && !sendAt) {
      return res.status(400).json({ message: 'Elegiste "enviar a una hora" pero no indicaste la hora (HH:MM).' });
    }

    // LA LISTA SE CONGELA AQUÍ. El asistente manda las citas que el usuario vio y
    // dejó marcadas; si no manda ninguna se resuelve el filtro. Entre confirmar y
    // que el job arranque se pueden agendar más citas de ese día, y esas no las
    // aprobó nadie: no deben colarse en el envío.
    const pedidas = (Array.isArray(req.body.appointments) ? req.body.appointments : [])
      .filter((a) => mongoose.isValidObjectId(a))
      .map(String);
    const audience = await resolveAudience(req, filters);
    const elegibles = audience.rows.filter((r) => r.eligible).map((r) => r._id);
    const ids = pedidas.length ? elegibles.filter((id) => pedidas.includes(id)) : elegibles;

    if (!ids.length) {
      return res.status(400).json({
        message: 'No hay ninguna cita a la que enviar: todas quedaron descartadas (sin teléfono, dadas de baja o repetidas).',
      });
    }

    const etiquetaFecha = filters.endDate && filters.endDate !== filters.startDate
      ? `${filters.startDate} a ${filters.endDate}`
      : filters.startDate;
    const etiquetaHorario = filters.startTimeFrom || filters.startTimeTo
      ? ` ${filters.startTimeFrom || '00:00'}-${filters.startTimeTo || '23:59'}`
      : '';

    const blast = await AppointmentBlast.create({
      clinic: anchorClinic,
      name: `Citas del ${etiquetaFecha}${etiquetaHorario} — ${ids.length} cita(s)`,
      filters,
      appointments: ids,
      workflows: workflowIds,
      dripSeconds: Math.min(3600, Math.max(1, Number(req.body.dripSeconds) || 20)),
      sendMode,
      sendAt,
      whatsappAccount: mongoose.isValidObjectId(req.body.whatsappAccount) ? req.body.whatsappAccount : null,
      cancelPending: req.body.cancelPending !== false,
      status: 'pending',
      total: ids.length,
      createdBy: req.user._id,
      createdByName: req.user.name,
    });

    // Se arranca sin esperar (como el goteo de campañas) para que la pantalla lo
    // vea moverse; el reclamo atómico del runner evita que el job lo duplique.
    runBlast(blast._id).catch(() => {});
    res.status(201).json(blast);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear el envío', error: err.message });
  }
};

/** Historial de envíos (con sus contadores). */
exports.list = async (req, res) => {
  try {
    const anchorClinic = (await resolveCallCenterClinicId()) || req.clinicId;
    const list = await AppointmentBlast.find({ clinic: anchorClinic })
      .populate('workflows', 'name')
      .select('-appointments') // no hacen falta cientos de ids en el listado
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const anchorClinic = (await resolveCallCenterClinicId()) || req.clinicId;
    const blast = await AppointmentBlast.findOne({ _id: req.params.id, clinic: anchorClinic })
      .populate('workflows', 'name')
      .select('-appointments');
    if (!blast) return res.status(404).json({ message: 'Envío no encontrado' });
    res.json(blast);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Envíos de tandas ANTERIORES de este flujo que todavía no han salido. Es lo que
 * explica que a un paciente le llegue el recordatorio de la fecha equivocada: un
 * goteo tarda horas en vaciarse y se solapa con el de hoy.
 */
exports.pendingEnrollments = async (req, res) => {
  try {
    const workflow = String(req.query.workflow || '');
    if (!mongoose.isValidObjectId(workflow)) return res.json({ pending: 0, nextAt: null });
    const match = {
      workflow: new mongoose.Types.ObjectId(workflow),
      status: { $in: ['active', 'waiting'] },
      'context.eventType': 'appointment_bulk',
    };
    const [pending, next] = await Promise.all([
      WorkflowEnrollment.countDocuments(match),
      WorkflowEnrollment.findOne(match).sort({ nextRunAt: 1 }).select('nextRunAt').lean(),
    ]);
    res.json({ pending, nextAt: next?.nextRunAt || null });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Automatizaciones activas con el disparador "Citas de la agenda". */
exports.listWorkflows = async (req, res) => {
  try {
    const anchorClinic = (await resolveCallCenterClinicId()) || req.clinicId;
    const { matchingFlows } = require('../utils/workflowEngine');
    const all = await Workflow.find({ clinic: anchorClinic, active: true })
      .select('name folder trigger triggers nodes edges')
      .lean();
    const usables = all
      .filter((wf) => matchingFlows(wf, (tr) => tr?.type === 'appointment_bulk').length)
      // `nodes`/`edges` pesan y el selector solo necesita el nombre y la hora de
      // envío que trae el disparador (la lee el asistente con flowSendHourOf).
      .map((wf) => ({ _id: wf._id, name: wf.name, folder: wf.folder, trigger: wf.trigger, triggers: wf.triggers, nodes: (wf.nodes || []).filter((n) => n.type === 'trigger') }));
    res.json(usables);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
