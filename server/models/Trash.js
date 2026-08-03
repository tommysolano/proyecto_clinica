const mongoose = require('mongoose');

/**
 * Papelera de reciclaje del CRM/Marketing: al borrar uno de los tipos
 * cubiertos, se guarda aquí una copia COMPLETA del documento (no un simple
 * flag "isDeleted") y el original se borra de su colección. Así ninguna
 * consulta de listado del resto del sistema necesita tocarse para excluir
 * borrados. Restaurar recrea el documento con su MISMO _id (para que las
 * referencias de otros documentos —enrollments, etc.— sigan vivas). Pasados
 * 30 días sin restaurar, un job la borra en firme (ver utils/trashBin.js).
 */
const trashSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    entityType: {
      type: String,
      required: true,
      enum: ['Workflow', 'MessageTemplate', 'SavedReply', 'Segment', 'Contact'],
      index: true,
    },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    label: { type: String, trim: true, default: '' },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deletedByName: { type: String, trim: true, default: '' },
    purgeAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

trashSchema.index({ clinic: 1, entityType: 1, createdAt: -1 });

module.exports = mongoose.model('Trash', trashSchema);
