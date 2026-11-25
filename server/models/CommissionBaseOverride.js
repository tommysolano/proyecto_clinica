const mongoose = require('mongoose');

// Corrección de la base de comisión, independiente del valor de la cita y la venta.
const schema = new mongoose.Schema({
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  base: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
}, { timestamps: true });
schema.index({ appointment: 1, doctor: 1 }, { unique: true });
module.exports = mongoose.model('CommissionBaseOverride', schema);
