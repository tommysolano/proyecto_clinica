const mongoose = require('mongoose');

/**
 * PDF generado por el escáner de documentos (/scanner).
 *
 * El archivo vive en disco (server/storage/scans/<clinica>/…), no en Mongo:
 * aquí solo queda la ficha con el nombre visible, cuántas páginas tiene y quién
 * lo escaneó. Ver [media en disco] en el resto del sistema.
 *
 * El NOMBRE es único por clínica (sin distinguir mayúsculas ni tildes): si el
 * usuario repite uno, el servidor le agrega " (2)", " (3)"… antes de guardar.
 */
const scannedDocumentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    // Nombre que ve el usuario (sin la extensión .pdf).
    name: { type: String, required: true, trim: true },
    // Versión normalizada del nombre: es la que garantiza la unicidad.
    nameKey: { type: String, required: true },
    // Nombre del archivo en disco (aleatorio, nunca el del usuario).
    filename: { type: String, required: true },
    size: { type: Number, default: 0 },
    pages: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

scannedDocumentSchema.index({ clinic: 1, nameKey: 1 }, { unique: true });
scannedDocumentSchema.index({ clinic: 1, createdAt: -1 });

module.exports = mongoose.model('ScannedDocument', scannedDocumentSchema);
