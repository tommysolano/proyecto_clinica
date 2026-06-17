const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

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
    const wf = await Workflow.create({
      ...req.body,
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
    const update = { ...req.body };
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
