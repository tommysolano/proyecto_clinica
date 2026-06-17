const mongoose = require('mongoose');

/**
 * Segmento (smart list) reutilizable: guarda un conjunto de filtros que se
 * resuelven dinámicamente a una lista de pacientes (utils/segmentResolver.js).
 * Se usa como destino de campañas y, más adelante, como disparador de workflows.
 *
 * Filtros soportados (todos opcionales, se combinan con AND):
 *  - sources:        Patient.source ∈ [...]
 *  - tags:           Patient.tags contiene TODOS los indicados
 *  - gender:         Patient.gender
 *  - ageRange:       edad calculada desde birthDate entre {min,max}
 *  - hasOptIn:       'whatsapp' | 'email' (excluye opt-out)
 *  - zone:           última zona facturada (clientZone) — vía ventas
 *  - treatmentStatus:'activo' | 'completado' | 'abandonado'
 *  - service:        productId que aparece en un tratamiento del paciente
 *  - program:        programId (se expande a sus servicios)
 *  - daysSinceLastVisit: pacientes cuya última cita asistida fue hace >= N días
 */
const segmentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    entity: { type: String, enum: ['patient'], default: 'patient' },
    filters: {
      sources: { type: [String], default: [] },
      tags: { type: [String], default: [] },
      gender: { type: String, enum: ['masculino', 'femenino', 'otro', ''], default: '' },
      ageRange: {
        min: { type: Number, default: null },
        max: { type: Number, default: null },
      },
      hasOptIn: { type: String, enum: ['', 'whatsapp', 'email'], default: '' },
      zone: { type: String, trim: true, default: '' },
      treatmentStatus: {
        type: String,
        enum: ['', 'activo', 'completado', 'abandonado'],
        default: '',
      },
      service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      program: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      daysSinceLastVisit: { type: Number, default: null },
    },
    dynamic: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

segmentSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Segment', segmentSchema);
