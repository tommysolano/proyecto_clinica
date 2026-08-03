const Segment = require('../models/Segment');
const { resolveSegment } = require('../utils/segmentResolver');
const { moveToTrash } = require('../utils/trashBin');

exports.list = async (req, res) => {
  try {
    const list = await Segment.find({ clinic: req.clinicId }).sort({ updatedAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar segmentos', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const seg = await Segment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!seg) return res.status(404).json({ message: 'Segmento no encontrado' });
    res.json(seg);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    if (!req.body.name || !String(req.body.name).trim()) {
      return res.status(400).json({ message: 'El nombre es requerido' });
    }
    const seg = await Segment.create({
      clinic: req.clinicId,
      name: String(req.body.name).trim(),
      description: req.body.description || '',
      filters: req.body.filters || {},
      dynamic: req.body.dynamic !== false,
      createdBy: req.user._id,
    });
    res.status(201).json(seg);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Ya existe un segmento con ese nombre' });
    }
    res.status(500).json({ message: 'Error al crear segmento', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const update = { ...req.body };
    delete update.clinic;
    delete update._id;
    const seg = await Segment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    );
    if (!seg) return res.status(404).json({ message: 'Segmento no encontrado' });
    res.json(seg);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar segmento', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const seg = await Segment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!seg) return res.status(404).json({ message: 'Segmento no encontrado' });
    await moveToTrash({ entityType: 'Segment', doc: seg, clinic: req.clinicId, user: req.user });
    await seg.deleteOne();
    res.json({ message: 'Segmento movido a la papelera de reciclaje' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Resuelve un segmento guardado a su lista de pacientes.
 * GET /api/segments/:id/resolve?preview=true  → solo cuenta + primeros 50.
 */
exports.resolve = async (req, res) => {
  try {
    const seg = await Segment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!seg) return res.status(404).json({ message: 'Segmento no encontrado' });
    const result = await resolveSegment(req.clinicId, seg.filters || {});
    if (req.query.preview === 'true') {
      return res.json({ count: result.count, patients: result.patients.slice(0, 50) });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Error al resolver segmento', error: err.message });
  }
};

/**
 * Previsualiza filtros SIN guardar el segmento (para el constructor en vivo).
 * POST /api/segments/preview  body: { filters }
 */
exports.preview = async (req, res) => {
  try {
    const result = await resolveSegment(req.clinicId, req.body.filters || {});
    res.json({ count: result.count, patients: result.patients.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ message: 'Error al previsualizar', error: err.message });
  }
};
