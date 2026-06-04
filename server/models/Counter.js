const mongoose = require('mongoose');

/**
 * Contador secuencial atómico por clínica + clave (p.ej. 'journal-2026').
 * Evita condiciones de carrera y huecos en numeraciones (asientos, etc.).
 */
const counterSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

counterSchema.index({ clinic: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('Counter', counterSchema);
