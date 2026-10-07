const mongoose = require('mongoose');

/**
 * SALDO A FAVOR DEL PACIENTE (oct-2026): un movimiento por renglón.
 *
 * El paciente paga MÁS de lo que se le factura —300 por un servicio de 100,
 * porque sigue un tratamiento y va a volver—. Se factura solo lo vendido y el
 * excedente queda como anticipo suyo: en contabilidad, un pasivo en «Anticipos
 * de clientes» (2.1.01.03); aquí, el detalle por paciente para saber cuánto le
 * queda y de dónde salió. Se consume en sus próximas ventas (método 'anticipo').
 *
 * El saldo es la SUMA de `amount` (con signo) de la sucursal: el anticipo vive
 * en la contabilidad de la sede donde se cobró y se usa en esa misma sede.
 *
 *  · ANTICIPO   (+) excedente de una venta o anticipo de un cobro (Payment).
 *  · APLICACION (−) se usó para pagar una venta.
 *  · REVERSO    (±) se anuló la venta o el cobro que lo movió.
 *
 * Nunca se edita ni se borra: cada corrección es otro movimiento.
 */
const patientCreditSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    type: { type: String, enum: ['ANTICIPO', 'APLICACION', 'REVERSO'], required: true },
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null, index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null, index: true },
    // El movimiento que este REVERSO deshace (un reverso por movimiento).
    reverses: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientCredit', default: null },
    description: { type: String, trim: true, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

patientCreditSchema.index({ clinic: 1, patient: 1, date: -1 });

module.exports = mongoose.model('PatientCredit', patientCreditSchema);
