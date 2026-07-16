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
    // Carpeta para organizar los fragmentos (texto libre, '' = sin carpeta).
    folder: { type: String, trim: true, default: '' },
    // Adjunto opcional (imagen/video/documento) que se envía junto al texto.
    // url: URL pública autoalojada (/api/public/media/:id) o externa.
    attachment: {
      url: { type: String, trim: true, default: '' },
      type: { type: String, enum: ['', 'image', 'video', 'document'], default: '' },
      name: { type: String, trim: true, default: '' },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    shared: { type: Boolean, default: true }, // visible para toda la clínica
    // Veces insertado en el chat: ordena el menú por "más usados".
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

savedReplySchema.index({ clinic: 1, shortcut: 1 });

module.exports = mongoose.model('SavedReply', savedReplySchema);
