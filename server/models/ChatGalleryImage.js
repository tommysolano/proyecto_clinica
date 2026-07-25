const mongoose = require('mongoose');

/**
 * Imagen guardada en la galería del chat. Se guarda como data URL base64
 * para no requerir storage externo (limitada en tamaño por el controlador).
 */
const chatGalleryImageSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    dataUrl: { type: String, required: true }, // data:image/...;base64,...
    mimeType: { type: String, default: 'image/png' },
    size: { type: Number, default: 0 },
    // Para qué se guardó. 'inbound' es lo que MANDA el contacto (fotos, notas de
    // voz, videos): se almacena aquí para no engordar el mensaje, pero NO debe
    // salir en la galería que el agente elige a mano. Los documentos antiguos no
    // tienen el campo y siguen comportándose como galería, como hasta ahora.
    kind: {
      type: String,
      enum: ['gallery', 'attachment', 'inbound'],
      default: 'gallery',
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatGalleryImage', chatGalleryImageSchema);
