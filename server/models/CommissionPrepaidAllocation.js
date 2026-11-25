const mongoose = require('mongoose');

// Conciliación de una sesión histórica con una línea vendida antes de que
// existiera el registro de paquetes. No modifica el saldo operativo de sesiones.
const schema = new mongoose.Schema({
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
}, { timestamps: true });
schema.index({ appointment: 1, product: 1 }, { unique: true });
module.exports = mongoose.model('CommissionPrepaidAllocation', schema);
