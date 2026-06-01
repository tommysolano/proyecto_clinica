const mongoose = require('mongoose');

/**
 * Carpeta para organizar flujos de mensajes automáticos.
 * Una carpeta solo agrupa flujos; no contiene configuración de mensajes.
 */
const messageFolderSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

messageFolderSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('MessageFolder', messageFolderSchema);
