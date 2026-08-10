const mongoose = require('mongoose');

/**
 * Resultado individual de una fila de una importación de contactos.
 *
 * Vive en una colección separada porque un Excel real puede superar las 40 mil
 * filas: guardar todo dentro de ContactImport excedería el límite de 16 MB de
 * Mongo. Además permite paginar y filtrar los omitidos sin cargar el lote entero.
 */
const contactImportRowSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    importBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactImport', required: true, index: true },
    row: { type: Number, required: true },
    outcome: {
      type: String,
      enum: ['created', 'updated', 'skipped', 'failed'],
      required: true,
      index: true,
    },
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', default: null },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    displayName: { type: String, trim: true, default: '' },
    value: { type: String, trim: true, default: '' },
    reason: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

contactImportRowSchema.index({ importBatch: 1, outcome: 1, row: 1 });
contactImportRowSchema.index({ importBatch: 1, row: 1 }, { unique: true });

module.exports = mongoose.model('ContactImportRow', contactImportRowSchema);
