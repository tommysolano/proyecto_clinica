const mongoose = require('mongoose');

/**
 * Carpeta para organizar automatizaciones (Workflows).
 * Una carpeta solo agrupa workflows; no contiene configuración propia.
 * Espejo de MessageFolder pero para el motor de Workflows.
 */
const workflowFolderSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

workflowFolderSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('WorkflowFolder', workflowFolderSchema);
