const mongoose = require('mongoose');

/**
 * Catálogo CIE-10 (Clasificación Internacional de Enfermedades, 10.ª rev.).
 * Es global (no por clínica). Se llena con scripts/seedCie10.js: un subconjunto
 * de los códigos más frecuentes viene por defecto, y el catálogo oficial completo
 * del MSP se carga pasando el archivo al script.
 */
const cie10Schema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    description: { type: String, required: true, trim: true },
    // Capítulo/categoría opcionales (para agrupar en el catálogo oficial).
    chapter: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

// Búsqueda por código o por nombre (regex insensible a mayúsculas).
cie10Schema.index({ description: 1 });

module.exports = mongoose.model('Cie10', cie10Schema);
