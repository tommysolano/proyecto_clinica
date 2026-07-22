const mongoose = require('mongoose');

/**
 * Carpeta para organizar los Mensajes Guardados (SavedReply).
 *
 * `name` es una RUTA tipo Windows con '/' como separador ("CITA/Recordatorios"):
 * así hay carpetas dentro de carpetas. El registro existe para que una carpeta
 * (incluso VACÍA o una subcarpeta recién creada) persista aunque todavía no tenga
 * mensajes dentro — antes las carpetas solo existían si algún mensaje las usaba.
 * Espejo de WorkflowFolder pero para los mensajes guardados.
 */
const savedReplyFolderSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

savedReplyFolderSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SavedReplyFolder', savedReplyFolderSchema);
