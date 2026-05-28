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
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatGalleryImage', chatGalleryImageSchema);
