const mongoose = require('mongoose');

/**
 * Ajuste manual de comisiones para un doctor en un rango de fechas.
 * Sirve para sumar (o restar, con valor negativo) una comisión que el sistema
 * no contabilizó correctamente. Se muestra junto con el total devengado y se
 * incluye en el PDF del período del doctor.
 */
const commissionAdjustmentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Rango al que aplica el ajuste (coincide con el filtro de Comisiones).
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    // Valor a sumar a las comisiones devengadas. Admite negativos para descontar.
    amount: { type: Number, required: true },
    // Motivo del ajuste (por qué no se contabilizó correctamente).
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommissionAdjustment', commissionAdjustmentSchema);
