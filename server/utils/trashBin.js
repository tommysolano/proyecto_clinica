/**
 * Papelera de reciclaje del CRM/Marketing (ver models/Trash.js para el porqué
 * del diseño). Este módulo es el único punto que sabe archivar/restaurar/
 * purgar; los controladores de cada entidad solo llaman a `moveToTrash` justo
 * antes de borrar el documento original.
 */
const Trash = require('../models/Trash');

const RETENTION_DAYS = 30;

// Carga perezosa de modelos (evita ciclos de require entre controllers/models
// al cargar este util desde varios controllers a la vez).
const MODEL_LOADERS = {
  Workflow: () => require('../models/Workflow'),
  MessageTemplate: () => require('../models/MessageTemplate'),
  SavedReply: () => require('../models/SavedReply'),
  Segment: () => require('../models/Segment'),
  Contact: () => require('../models/Contact'),
};

// Etiqueta legible por tipo, para mostrar en la lista de la papelera.
const LABELERS = {
  Workflow: (d) => d.name || '',
  MessageTemplate: (d) => d.name || '',
  SavedReply: (d) => d.title || d.shortcut || '',
  Segment: (d) => d.name || '',
  Contact: (d) => [d.firstName, d.lastName].filter(Boolean).join(' ') || d.displayName || d.phone || '',
};

/**
 * Archiva una copia completa de `doc` en la papelera. El caller sigue siendo
 * responsable de borrar el documento original después de llamar a esto.
 */
async function moveToTrash({ entityType, doc, clinic, user }) {
  if (!MODEL_LOADERS[entityType]) throw new Error(`Tipo de entidad no soportado en la papelera: ${entityType}`);
  const snapshot = doc.toObject({ flattenMaps: true, virtuals: false });
  await Trash.create({
    clinic,
    entityType,
    originalId: doc._id,
    label: LABELERS[entityType]?.(doc) || '',
    snapshot,
    deletedBy: user?._id || null,
    deletedByName: user?.name || '',
    purgeAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });
}

/** Restaura un elemento: recrea el documento (mismo _id) y borra la entrada de la papelera. */
async function restoreFromTrash({ trashId, clinic }) {
  const entry = await Trash.findOne({ _id: trashId, clinic });
  if (!entry) return { ok: false, code: 'not_found' };
  const loadModel = MODEL_LOADERS[entry.entityType];
  if (!loadModel) return { ok: false, code: 'not_found' };
  const data = { ...entry.snapshot };
  delete data.__v;
  try {
    const restored = await loadModel().create(data);
    await entry.deleteOne();
    return { ok: true, doc: restored, entityType: entry.entityType };
  } catch (err) {
    if (err?.code === 11000) {
      return {
        ok: false,
        code: 'duplicate',
        error: 'Ya existe otro elemento con el mismo nombre/identificador. Cámbialo o elimínalo antes de restaurar.',
      };
    }
    throw err;
  }
}

/** Elimina definitivamente una entrada (a mano, antes de los 30 días). */
async function purgeOne({ trashId, clinic }) {
  const r = await Trash.deleteOne({ _id: trashId, clinic });
  return r.deletedCount > 0;
}

/** Job periódico: borra en firme lo que ya cumplió los 30 días sin restaurar. */
async function purgeExpiredTrash() {
  const r = await Trash.deleteMany({ purgeAt: { $lte: new Date() } });
  return r.deletedCount;
}

module.exports = {
  moveToTrash,
  restoreFromTrash,
  purgeOne,
  purgeExpiredTrash,
  RETENTION_DAYS,
  ENTITY_TYPES: Object.keys(MODEL_LOADERS),
};
