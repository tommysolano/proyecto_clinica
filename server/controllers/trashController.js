const Trash = require('../models/Trash');
const { restoreFromTrash, purgeOne, RETENTION_DAYS } = require('../utils/trashBin');

const ENTITY_LABELS = {
  Workflow: 'Automatización',
  MessageTemplate: 'Plantilla de mensaje',
  SavedReply: 'Mensaje guardado',
  Segment: 'Segmento',
  Contact: 'Contacto',
};

exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.entityType) filter.entityType = req.query.entityType;
    const items = await Trash.find(filter).sort({ createdAt: -1 }).lean();
    res.json({
      retentionDays: RETENTION_DAYS,
      items: items.map((it) => ({ ...it, entityLabel: ENTITY_LABELS[it.entityType] || it.entityType })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar la papelera', error: err.message });
  }
};

exports.restore = async (req, res) => {
  try {
    const r = await restoreFromTrash({ trashId: req.params.id, clinic: req.clinicId });
    if (!r.ok) {
      if (r.code === 'not_found') return res.status(404).json({ message: 'No encontrado' });
      return res.status(409).json({ message: r.error });
    }
    res.json({ message: 'Elemento restaurado', entityType: r.entityType, id: r.doc._id });
  } catch (err) {
    res.status(500).json({ message: 'Error al restaurar', error: err.message });
  }
};

exports.purgeNow = async (req, res) => {
  try {
    const ok = await purgeOne({ trashId: req.params.id, clinic: req.clinicId });
    if (!ok) return res.status(404).json({ message: 'No encontrado' });
    res.json({ message: 'Eliminado definitivamente' });
  } catch (err) {
    res.status(500).json({ message: 'Error al eliminar definitivamente', error: err.message });
  }
};
