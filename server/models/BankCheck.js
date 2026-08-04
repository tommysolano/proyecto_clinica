const mongoose = require('mongoose');

/**
 * Registro de cheques de una chequera. Permite saber qué cheques están
 * disponibles, girados, cobrados o anulados.
 */
const bankCheckSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    number: { type: Number, required: true },
    status: { type: String, enum: ['DISPONIBLE', 'GIRADO', 'COBRADO', 'ANULADO'], default: 'DISPONIBLE' },
    beneficiary: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    date: { type: Date, default: null },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    // Pago que giró el cheque (cuando salió de Pagos y no de un movimiento manual de Bancos):
    // es el enlace que permite ver EN QUÉ se usó el cheque desde la pantalla de Cheques.
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true }
);

bankCheckSchema.index({ clinic: 1, bankAccount: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('BankCheck', bankCheckSchema);
