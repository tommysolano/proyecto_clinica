const mongoose = require('mongoose');

/**
 * PAGO DE COMISIONES A UN DOCTOR POR PERÍODO (sep-2026).
 *
 * El superadministrador marca como PAGADO lo que un doctor ganó entre dos
 * fechas (p. ej. las dos primeras semanas de septiembre). Toda comisión cuya
 * cita cae dentro del período —y de las sucursales del pago— deja de sumar en
 * «Por pagar»: así no se paga dos veces lo mismo.
 *
 * Las comisiones se calculan en vivo (ver commissionController), así que lo que
 * cuenta como pagado es el PERÍODO, no una lista congelada de citas. `amount` y
 * `lines` son la foto de lo que se pagó ese día, para auditoría: si después se
 * cambia una tarifa, el pago sigue diciendo cuánto se entregó.
 *
 * No se admiten dos pagos solapados del mismo doctor en la misma sucursal: una
 * cita solo puede quedar pagada por un período.
 */
const commissionPayoutSchema = new mongoose.Schema(
  {
    // Sucursal activa de quien registró el pago (referencia, no filtra).
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Sucursales que cubre el pago. Vacío = todas.
    clinics: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' }], default: [] },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    // Lo que se pagó (comisiones pendientes del período + ajustes del período).
    amount: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    lines: [
      {
        appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
        kind: String, // 'servicio' | 'paciente' | 'derivacion' | 'ajuste'
        concept: String,
        amount: Number,
        _id: false,
      },
    ],
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

commissionPayoutSchema.index({ doctor: 1, start: 1, end: 1 });

module.exports = mongoose.model('CommissionPayout', commissionPayoutSchema);
