const AgentTask = require('../models/AgentTask');
const { emitToUser } = require('../realtime');

// Los agentes ven sus tareas; admin/marketing ven todas.
function scopeFilter(req) {
  const filter = { clinic: req.clinicId };
  if (req.role === 'call_center' && !req.user.isSuperAdmin) {
    filter.assignedTo = req.user._id;
  } else if (req.query.assignedTo) {
    filter.assignedTo = req.query.assignedTo;
  }
  return filter;
}

exports.list = async (req, res) => {
  try {
    const filter = scopeFilter(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.conversation) filter.conversation = req.query.conversation;
    const list = await AgentTask.find(filter)
      .populate('assignedTo', 'name')
      .populate('patient', 'firstName lastName phone')
      .populate('conversation', 'phone contactName')
      .sort({ status: 1, dueAt: 1, createdAt: -1 })
      .limit(300);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar tareas', error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    if (!req.body.title?.trim()) return res.status(400).json({ message: 'El título es requerido' });
    const task = await AgentTask.create({
      clinic: req.clinicId,
      title: req.body.title.trim(),
      notes: req.body.notes || '',
      conversation: req.body.conversation || null,
      patient: req.body.patient || null,
      assignedTo: req.body.assignedTo || req.user._id,
      dueAt: req.body.dueAt || null,
      createdBy: req.user._id,
    });
    if (task.assignedTo && String(task.assignedTo) !== String(req.user._id)) {
      emitToUser(task.assignedTo, 'task:assigned', { id: task._id, title: task.title });
    }
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear tarea', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const task = await AgentTask.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!task) return res.status(404).json({ message: 'Tarea no encontrada' });
    // Un agente solo edita lo suyo.
    if (req.role === 'call_center' && !req.user.isSuperAdmin && String(task.assignedTo) !== String(req.user._id)) {
      return res.status(403).json({ message: 'No puedes editar esta tarea' });
    }
    ['title', 'notes', 'dueAt', 'assignedTo'].forEach((k) => {
      if (req.body[k] !== undefined) task[k] = req.body[k];
    });
    if (req.body.status === 'done' && task.status !== 'done') {
      task.status = 'done';
      task.completedAt = new Date();
    } else if (req.body.status === 'open') {
      task.status = 'open';
      task.completedAt = null;
    }
    await task.save();
    res.json(task);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar tarea', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const task = await AgentTask.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!task) return res.status(404).json({ message: 'Tarea no encontrada' });
    res.json({ message: 'Tarea eliminada' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
