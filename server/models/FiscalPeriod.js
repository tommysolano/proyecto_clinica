const mongoose = require('mongoose');

/**
 * Período contable mensual.
 * Estados:
 *  - ABIERTO: permite registrar movimientos.
 *  - CERRADO: solo lectura, no admite nuevos asientos.
 *  - BLOQUEADO: cerrado por cierre anual; ni siquiera admin puede reabrir sin permiso.
 */
const fiscalPeriodSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    status: { type: String, enum: ['ABIERTO', 'CERRADO', 'BLOQUEADO'], default: 'ABIERTO' },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

fiscalPeriodSchema.index({ clinic: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('FiscalPeriod', fiscalPeriodSchema);
