const MessageFlow = require('../models/MessageFlow');
const MessageFolder = require('../models/MessageFolder');

// ─────────── Carpetas ───────────
exports.listFolders = async (req, res) => {
  try {
    const folders = await MessageFolder.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();
    res.json(folders);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar carpetas', error: e.message });
  }
};

exports.createFolder = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'El nombre de la carpeta es requerido' });
    const exists = await MessageFolder.findOne({ clinic: req.clinicId, name });
    if (exists) return res.status(400).json({ message: 'Ya existe una carpeta con ese nombre' });
    const folder = await MessageFolder.create({ clinic: req.clinicId, name, createdBy: req.user._id });
    res.status(201).json(folder);
  } catch (e) {
    res.status(500).json({ message: 'Error al crear carpeta', error: e.message });
  }
};

exports.renameFolder = async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Nombre requerido' });
    const folder = await MessageFolder.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!folder) return res.status(404).json({ message: 'Carpeta no encontrada' });
    const oldName = folder.name;
    folder.name = name;
    await folder.save();
    // Mover los flujos de la carpeta al nuevo nombre.
    await MessageFlow.updateMany({ clinic: req.clinicId, folder: oldName }, { folder: name });
    res.json(folder);
  } catch (e) {
    res.status(500).json({ message: 'Error al renombrar carpeta', error: e.message });
  }
};

exports.deleteFolder = async (req, res) => {
  try {
    const folder = await MessageFolder.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!folder) return res.status(404).json({ message: 'Carpeta no encontrada' });
    const count = await MessageFlow.countDocuments({ clinic: req.clinicId, folder: folder.name });
    if (count > 0) {
      return res.status(400).json({ message: `La carpeta tiene ${count} flujo(s). Muévelos o elimínalos primero.` });
    }
    await folder.deleteOne();
    res.json({ message: 'Carpeta eliminada' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar carpeta', error: e.message });
  }
};

// ─────────── Flujos ───────────
exports.listFlows = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.folder) filter.folder = req.query.folder;
    const flows = await MessageFlow.find(filter).sort({ updatedAt: -1 }).lean();
    res.json(flows);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar flujos', error: e.message });
  }
};

exports.getFlow = async (req, res) => {
  try {
    const flow = await MessageFlow.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!flow) return res.status(404).json({ message: 'Flujo no encontrado' });
    res.json(flow);
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener flujo', error: e.message });
  }
};

exports.createFlow = async (req, res) => {
  try {
    if (!req.body.name || !req.body.name.trim()) {
      return res.status(400).json({ message: 'El nombre del flujo es requerido' });
    }
    const flow = await MessageFlow.create({
      ...req.body,
      folder: (req.body.folder || 'General').trim() || 'General',
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    res.status(201).json(flow);
  } catch (e) {
    res.status(500).json({ message: 'Error al crear flujo', error: e.message });
  }
};

exports.updateFlow = async (req, res) => {
  try {
    const update = { ...req.body };
    delete update.clinic;
    delete update._id;
    if (update.folder) update.folder = update.folder.trim() || 'General';
    const flow = await MessageFlow.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    );
    if (!flow) return res.status(404).json({ message: 'Flujo no encontrado' });
    res.json(flow);
  } catch (e) {
    res.status(500).json({ message: 'Error al actualizar flujo', error: e.message });
  }
};

exports.deleteFlow = async (req, res) => {
  try {
    const flow = await MessageFlow.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!flow) return res.status(404).json({ message: 'Flujo no encontrado' });
    res.json({ message: 'Flujo eliminado' });
  } catch (e) {
    res.status(500).json({ message: 'Error al eliminar flujo', error: e.message });
  }
};
