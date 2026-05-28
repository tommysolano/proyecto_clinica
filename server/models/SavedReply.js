const mongoose = require('mongoose');

/**
 * Mensaje guardado (canned reply) tipo "/" en WhatsApp.
 * Cada agente puede tener sus propios mensajes y/o compartidos por clínica.
 */
const savedReplySchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    shortcut: { type: String, required: true, trim: true }, // p.ej. "saludo"
    title: { type: String, trim: true },
    body: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    shared: { type: Boolean, default: true }, // visible para toda la clínica
  },
  { timestamps: true }
);

savedReplySchema.index({ clinic: 1, shortcut: 1 });

module.exports = mongoose.model('SavedReply', savedReplySchema);
