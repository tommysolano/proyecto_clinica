const mongoose = require('mongoose');

/**
 * Bitácora de fusiones de pacientes.
 *
 * Guarda una fotografía de ambos perfiles antes de tocar nada. Las historias,
 * observaciones y documentos siguen en sus colecciones normales; esta copia es
 * el respaldo administrativo para saber exactamente qué ficha se absorbió.
 */
const patientMergeSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    targetPatient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    sourcePatient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    sourceSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    moved: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['RUNNING', 'DONE', 'FAILED'], default: 'RUNNING' },
    error: { type: String, default: '' },
  },
  { timestamps: true }
);

patientMergeSchema.index({ sourcePatient: 1, status: 1 });

module.exports = mongoose.model('PatientMerge', patientMergeSchema);
