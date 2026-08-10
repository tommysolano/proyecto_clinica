const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WorkflowFolder = require('../models/WorkflowFolder');
const { makeFolderCrud, normFolderPath } = require('../utils/folderCrud');
const { moveToTrash } = require('../utils/trashBin');

/**
 * Normaliza el payload de un workflow antes de guardarlo. Los selects del
 * frontend envían cadenas vacías ('') para campos ObjectId opcionales
 * (step.assignUser, trigger.serviceFilter); Mongoose no puede castear '' a
 * ObjectId y lanza CastError → 500. Aquí los convertimos a null.
 */
function sanitizeTrigger(tr = {}) {
  const t = { ...tr };
  if (!t.serviceFilter) t.serviceFilter = null;
  if (!t.clinicFilter) t.clinicFilter = null;
  return t;
}

function sanitizeWorkflowPayload(body = {}) {
  const out = { ...body };
  // Normaliza la lista de disparadores (lógica OR). Mantiene `trigger` (legacy)
  // sincronizado con triggers[0] para no romper el motor ni los workflows viejos.
  let triggers = Array.isArray(out.triggers) ? out.triggers : null;
  if (!triggers && out.trigger?.type) triggers = [out.trigger];
  if (triggers) {
    out.triggers = triggers.filter((t) => t && t.type).map(sanitizeTrigger);
    out.trigger = out.triggers[0] || undefined;
  } else if (out.trigger) {
    out.trigger = sanitizeTrigger(out.trigger);
  }
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((s) => {
      const step = { ...s };
      if (!step.assignUser) step.assignUser = null;
      return step;
    });
  }
  return out;
}

function workflowButtonsError(body = {}) {
  const steps = [
    ...(Array.isArray(body.nodes)
      ? body.nodes
        .filter((node) => ['send_message', 'send_template'].includes(node?.type))
        .map((node) => ({ type: node.type, data: node.data || {} }))
      : []),
    ...(Array.isArray(body.steps)
      ? body.steps
        .filter((step) => ['send_message', 'send_template'].includes(step?.type))
        .map((step) => ({ type: step.type, data: step }))
      : []),
  ];
  for (const step of steps) {
    const buttons = Array.isArray(step.data.buttons) ? step.data.buttons : [];
    if (buttons.length > 3) return 'Cada mensaje admite un máximo de 3 botones.';
    const ids = buttons.map((button) => String(button?.id || '').trim());
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return 'Los botones necesitan identificadores únicos.';
    const maxTextLength = step.type === 'send_template' ? 25 : 20;
    for (const button of buttons) {
      if (!['quick_reply', 'url', 'phone'].includes(button.type)) return 'Hay un tipo de botón no permitido.';
      const text = String(button.text || '').trim();
      if (!text || text.length > maxTextLength) {
        return `El texto de cada botón debe tener entre 1 y ${maxTextLength} caracteres.`;
      }
      if (button.type === 'url' && !/^https?:\/\//i.test(String(button.url || '').trim())) {
        return 'Los botones de enlace necesitan una URL http:// o https:// válida.';
      }
      if (button.type === 'phone' && String(button.url || '').replace(/\D/g, '').length < 7) {
        return 'Los botones de llamada necesitan un número con prefijo internacional.';
      }
    }
  }
  return '';
}

// ─────────── Carpetas (anidadas, tipo Windows) ───────────
// Rutas con '/' ("Citas/Recordatorios"): carpetas dentro de carpetas. El registro
// persiste la carpeta aunque esté vacía. Lógica compartida en utils/folderCrud.
const wfFolders = makeFolderCrud({
  FolderModel: WorkflowFolder,
  ItemModel: Workflow,
  folderField: 'folder',
  // Al borrar una carpeta CON sus automatizaciones dentro hay que cancelar las
  // inscripciones vivas, igual que al borrar una automatización sola: si no, el
  // motor seguiría intentando avanzar inscripciones de un workflow que ya no está.
  onItemsDeleted: async (ids) => {
    await WorkflowEnrollment.updateMany(
      { workflow: { $in: ids }, status: { $in: ['active', 'waiting'] } },
      { status: 'cancelled' }
    );
  },
});
exports.listFolders = wfFolders.list;
exports.createFolder = wfFolders.create;
exports.deleteFolder = wfFolders.remove; // DELETE /folders?path=...&mode=empty|move|purge
exports.renameFolder = wfFolders.rename; // PUT /folders { path, name }

exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.folder) filter.folder = req.query.folder;
    const list = await Workflow.find(filter).sort({ updatedAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar workflows', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const wf = await Workflow.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!wf) return res.status(404).json({ message: 'Workflow no encontrado' });
    res.json(wf);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    if (!req.body.name?.trim()) return res.status(400).json({ message: 'El nombre es requerido' });
    const hasTrigger = req.body.trigger?.type || (Array.isArray(req.body.triggers) && req.body.triggers.some((t) => t?.type));
    if (!hasTrigger) return res.status(400).json({ message: 'Falta al menos un disparador' });
    const buttonError = workflowButtonsError(req.body);
    if (buttonError) return res.status(400).json({ message: buttonError });
    const payload = sanitizeWorkflowPayload(req.body);
    const wf = await Workflow.create({
      ...payload,
      folder: normFolderPath(req.body.folder) || 'General',
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    res.status(201).json(wf);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear workflow', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const buttonError = workflowButtonsError(req.body);
    if (buttonError) return res.status(400).json({ message: buttonError });
    const update = sanitizeWorkflowPayload(req.body);
    delete update.clinic;
    delete update._id;
    delete update.stats;
    // Mover de carpeta: normaliza la ruta (tipo Windows) y nunca la deja vacía.
    if (update.folder !== undefined) update.folder = normFolderPath(update.folder) || 'General';
    const wf = await Workflow.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    );
    if (!wf) return res.status(404).json({ message: 'Workflow no encontrado' });
    res.json(wf);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar workflow', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const wf = await Workflow.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!wf) return res.status(404).json({ message: 'Workflow no encontrado' });
    await moveToTrash({ entityType: 'Workflow', doc: wf, clinic: req.clinicId, user: req.user });
    await wf.deleteOne();
    // Cancela inscripciones vivas del workflow eliminado.
    await WorkflowEnrollment.updateMany(
      { workflow: req.params.id, status: { $in: ['active', 'waiting'] } },
      { status: 'cancelled' }
    );
    res.json({ message: 'Workflow movido a la papelera de reciclaje' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// Plantillas de automatización listas para instalar (casos de clínica).
// Se crean PAUSADAS para que el usuario las revise (y cambie send_message por una
// plantilla aprobada cuando el envío caiga fuera de la ventana de 24h) antes de activar.
const PRESETS = {
  reminder_24h: {
    name: 'Recordatorio de cita 24h (con confirmación)',
    trigger: { type: 'appointment_created', audience: 'all', serviceFilter: null },
    steps: [
      { type: 'wait_until', waitEvent: 'appointment_date', offsetMinutes: -1440 },
      { type: 'send_message', body: 'Hola {{nombre}}, te recordamos tu cita de mañana. ¿Confirmas tu asistencia? Responde SÍ o NO.' },
      { type: 'wait_reply', timeoutMinutes: 720 },
      { type: 'condition', field: 'lastReply', op: 'eq', value: 'yes', onFailGoTo: 5 },
      { type: 'set_appointment_status', appointmentStatus: 'confirmada' },
      { type: 'condition', field: 'lastReply', op: 'eq', value: 'no', onFailGoTo: null },
      { type: 'set_appointment_status', appointmentStatus: 'cancelada' },
    ],
  },
  recall_6m: {
    name: 'Recordatorio de control (6 meses)',
    trigger: { type: 'appointment_attended', audience: 'all', serviceFilter: null },
    steps: [
      { type: 'wait_until', waitEvent: 'appointment_date', offsetMinutes: 180 * 24 * 60 },
      { type: 'send_message', body: 'Hola {{nombre}}, ya pasaron 6 meses de tu última visita. ¿Agendamos tu control? Escríbenos para reservar.' },
    ],
  },
  reactivation: {
    name: 'Reactivación de tratamiento abandonado',
    trigger: { type: 'treatment_abandoned', audience: 'all', serviceFilter: null },
    steps: [
      { type: 'send_message', body: 'Hola {{nombre}}, notamos que dejaste tu tratamiento en pausa. Nos encantaría ayudarte a completarlo. ¿Coordinamos una cita?' },
      { type: 'add_tag', tag: 'reactivacion' },
    ],
  },
  birthday: {
    name: 'Saludo de cumpleaños',
    trigger: { type: 'patient_birthday', audience: 'all', serviceFilter: null },
    steps: [
      { type: 'send_message', body: '¡Feliz cumpleaños, {{nombre}}! 🎉 Todo el equipo te desea un día maravilloso.' },
    ],
  },
  postvisit_review: {
    name: 'Post-visita: solicitar reseña',
    trigger: { type: 'appointment_attended', audience: 'all', serviceFilter: null },
    steps: [
      { type: 'wait', waitMinutes: 180 }, // ~3h después de asistir
      { type: 'request_review', body: '¡Gracias por tu visita, {{nombre}}! ¿Cómo fue tu experiencia? Califícanos:' },
    ],
  },
};

exports.listPresets = (_req, res) => {
  res.json(Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name, trigger: p.trigger.type, steps: p.steps.length })));
};

exports.installPreset = async (req, res) => {
  try {
    const preset = PRESETS[req.params.key];
    if (!preset) return res.status(404).json({ message: 'Preset no encontrado' });
    const wf = await Workflow.create({
      clinic: req.clinicId,
      folder: 'Clínica',
      name: preset.name,
      active: false, // se instala pausado para revisión
      trigger: preset.trigger,
      triggers: [preset.trigger],
      steps: preset.steps,
      createdBy: req.user._id,
    });
    res.status(201).json(wf);
  } catch (err) {
    res.status(500).json({ message: 'Error al instalar preset', error: err.message });
  }
};

// Inscripciones de un workflow (para depurar/monitorear).
exports.enrollments = async (req, res) => {
  try {
    const filter = { workflow: req.params.id, clinic: req.clinicId };
    if (req.query.status) filter.status = req.query.status;
    const list = await WorkflowEnrollment.find(filter)
      .populate('patient', 'firstName lastName phone whatsapp')
      .sort({ updatedAt: -1 })
      .limit(200);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * POST /workflows/:id/enrollments/:enrollId/cancel — cancela una inscripción viva
 * (waiting/active). Sirve para desbloquear a un contacto: mientras tiene una
 * inscripción viva en el flujo, el dedup no lo vuelve a inscribir (reimportar lo
 * salta). Cancelarla lo libera para el próximo envío. No revive lo ya enviado.
 */
exports.cancelEnrollment = async (req, res) => {
  try {
    const enroll = await WorkflowEnrollment.findOne({
      _id: req.params.enrollId,
      workflow: req.params.id,
      clinic: req.clinicId,
    });
    if (!enroll) return res.status(404).json({ message: 'Inscripción no encontrada' });
    if (!['waiting', 'active'].includes(enroll.status)) {
      return res.status(400).json({ message: `La inscripción está "${enroll.status}": no hay nada que cancelar.` });
    }
    enroll.status = 'cancelled';
    enroll.nextRunAt = null;
    await enroll.save();
    res.json({ ok: true, enrollment: enroll });
  } catch (err) {
    res.status(500).json({ message: 'Error al cancelar la inscripción', error: err.message });
  }
};

/**
 * GET /workflows/:id/activity — rastro del disparador: por cada evento de
 * dominio, si este workflow inscribió al paciente o por qué NO (duplicado,
 * audiencia/filtro sin coincidir). Responde "agendé una cita y no pasó nada".
 */
exports.activity = async (req, res) => {
  try {
    const WorkflowTriggerEvent = require('../models/WorkflowTriggerEvent');
    // Se busca por las DOS formas de fila: la individual (`workflow`), que usan
    // "inscrito" y "saltado por duplicado", y la AGRUPADA (`workflows[]`), donde
    // un solo documento recoge todos los workflows que no coincidieron con el
    // mismo evento. Sin el segundo término, los "no coincidió" desaparecerían de
    // esta pantalla. Ver el comentario del modelo WorkflowTriggerEvent.
    const list = await WorkflowTriggerEvent.find({
      clinic: req.clinicId,
      $or: [{ workflow: req.params.id }, { 'workflows.workflow': req.params.id }],
    })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * GET /workflows/tags — etiquetas EN USO en el sistema, agrupadas por dónde
 * viven, para que el nodo Condición ofrezca un DESPLEGABLE en vez de pedirlas
 * escritas a mano (una etiqueta mal escrita hace que la condición nunca se
 * cumpla). Se devuelven las tres familias que sabe leer el motor:
 *  - patient      → Patient.tags (más las de los contactos del CRM: mismo vocabulario)
 *  - chat         → Conversation.tags
 *  - opportunity  → tags de las oportunidades del chat (canónicas + espejo legacy)
 * Los pacientes NO se filtran por sucursal: el CRM es global (un flujo puede
 * inscribir a un paciente de cualquier sede).
 */
exports.listTags = async (req, res) => {
  try {
    const Patient = require('../models/Patient');
    const Conversation = require('../models/Conversation');
    const Contact = require('../models/Contact');
    const clean = (...lists) => [
      ...new Set(lists.flat().map((t) => String(t || '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, 'es'));
    const byClinic = { clinic: req.clinicId };
    const [patientTags, contactTags, chatTags, oppTags, oppTagsLegacy] = await Promise.all([
      Patient.distinct('tags'),
      Contact.distinct('tags', byClinic).catch(() => []),
      Conversation.distinct('tags', byClinic),
      Conversation.distinct('opportunities.tags', byClinic),
      Conversation.distinct('opportunity.tags', byClinic),
    ]);
    res.json({
      patient: clean(patientTags, contactTags),
      chat: clean(chatTags),
      opportunity: clean(oppTags, oppTagsLegacy),
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar etiquetas', error: err.message, patient: [], chat: [], opportunity: [] });
  }
};

/**
 * Lista los Públicos Personalizados definidos en Meta/Facebook (Marketing API),
 * para que el nodo "Añadir/Quitar de público" ofrezca un selector en vez de
 * pedir el ID a mano. Devuelve { ok, audiences:[{id,name,count}], reason? }.
 */
exports.listMetaCustomAudiences = async (req, res) => {
  try {
    const { listAudiences } = require('../utils/metaCustomAudience');
    res.json(await listAudiences());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, audiences: [] });
  }
};

/** Anuncios visibles para el token de Marketing API (selector del disparador). */
exports.listMetaAds = async (req, res) => {
  try {
    const { listAds } = require('../utils/metaAds');
    res.json(await listAds());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ads: [] });
  }
};
