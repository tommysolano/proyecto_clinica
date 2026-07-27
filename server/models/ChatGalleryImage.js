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
    // Ruta del archivo EN DISCO, relativa a MEDIA_DIR (ver utils/mediaStore).
    // Es donde viven los adjuntos desde jul-2026: guardar videos como base64 en
    // Mongo se comía el 88% de la base de datos (149 MB de 169 MB) mientras el
    // servidor tenía 65 GB de disco libres al lado.
    storageKey: { type: String, trim: true, default: '' },
    // Base64 heredado. Ya NO se escribe: solo lo conservan los adjuntos anteriores
    // a la migración, y `migrateChatMediaToDisk.js` los va vaciando. Se lee como
    // respaldo (ver mediaStore.loadAttachment) para no perder ningún archivo.
    dataUrl: { type: String },
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
