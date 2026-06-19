const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WorkflowFolder = require('../models/WorkflowFolder');

/**
 * Normaliza el payload de un workflow antes de guardarlo. Los selects del
 * frontend envían cadenas vacías ('') para campos ObjectId opcionales
 * (step.assignUser, trigger.serviceFilter); Mongoose no puede castear '' a
 * ObjectId y lanza CastError → 500. Aquí los convertimos a null.
 */
function sanitizeWorkflowPayload(body = {}) {
  const out = { ...body };
  if (out.trigger) {
    out.trigger = { ...out.trigger };
    if (!out.trigger.serviceFilter) out.trigger.serviceFilter = null;
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

// ─────────── Carpetas ───────────
exports.listFolders = async (req, res) => {
  try {
    const folders = await WorkflowFolder.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();
    res.json(folders);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar carpetas', error: e.message });
  }
};

exports.createFolder = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'El nombre de la carpeta es requerido' });
    const exists = await WorkflowFolder.findOne({ clinic: req.clinicId, name });
    if (exists) return res.status(400).json({ message: 'Ya existe una carpeta con ese nombre' });
    const folder = await WorkflowFolder.create({ clinic: req.clinicId, name, createdBy: req.user._id });
    res.status(201).json(folder);
  } catch (e) {
    res.status(500).json({ message: 'Error al crear carpeta', error: e.message });
  }
};

exports.renameFolder = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Nombre requerido' });
    const folder = await WorkflowFolder.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!folder) return res.status(404).json({ message: 'Carpeta no encontrada' });
    const oldName = folder.name;
    folder.name = name;
    await folder.save();
    // Mover los workflows de la carpeta al nuevo nombre.
    await Workflow.updateMany({ clinic: req.clinicId, folder: oldName }, { folder: name });
    res.json(folder);
  } catch (e) {
    res.status(500).json({ message: 'Error al renombrar carpeta', error: e.message });
  }
};

exports.deleteFolder = async (req, res) => {
  try {
    const folder = await WorkflowFolder.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!folder) return res.status(404).json({ message: 'Carpeta no encontrada' });
    const count = await Workflow.countDocuments({ clinic: req.clinicId, folder: folder.name });
    if (count > 0) {
      return res.status(400).json({ message: `La carpeta tiene ${count} automatización(es). Muévelas o elimínalas primero.` });
    }
    await folder.deleteOne();
    res.json({ message: 'Carpeta eliminada' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar carpeta', error: e.message });
  }
};

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
    if (!req.body.trigger?.type) return res.status(400).json({ message: 'Falta el disparador' });
    const payload = sanitizeWorkflowPayload(req.body);
    const wf = await Workflow.create({
      ...payload,
      folder: (req.body.folder || 'General').trim() || 'General',
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
    const update = sanitizeWorkflowPayload(req.body);
    delete update.clinic;
    delete update._id;
    delete update.stats;
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
    const wf = await Workflow.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!wf) return res.status(404).json({ message: 'Workflow no encontrado' });
    // Cancela inscripciones vivas del workflow eliminado.
    await WorkflowEnrollment.updateMany(
      { workflow: req.params.id, status: { $in: ['active', 'waiting'] } },
      { status: 'cancelled' }
    );
    res.json({ message: 'Workflow eliminado' });
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
