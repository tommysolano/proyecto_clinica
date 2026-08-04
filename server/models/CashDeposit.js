const mongoose = require('mongoose');

/**
 * DEPÓSITO DE EFECTIVO EN EL BANCO.
 *
 * Lo que se lleva a ventanilla: el efectivo cobrado en el mostrador (ventas y cobros) que se
 * deposita en una cuenta con una papeleta. El módulo existe porque el contador necesita ver
 * QUÉ documentos entraron en cada depósito: sin eso, un depósito de $1.240 es un número suelto
 * que no se puede cuadrar contra la caja del día.
 *
 * Solo entra dinero EN EFECTIVO: lo cobrado por transferencia o tarjeta ya está en el banco (o
 * en tarjetas por liquidar) y depositarlo otra vez lo contaría dos veces.
 */
const cashDepositItemSchema = new mongoose.Schema(
  {
    // Qué documento aportó el efectivo: una venta del mostrador o un cobro de cartera.
    docModel: { type: String, enum: ['Sale', 'Payment'], required: true },
    docRef: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'items.docModel' },
    number: { type: String, default: '' },
    docDate: { type: Date, default: null },
    party: { type: String, default: '' },
    // Importe EN EFECTIVO de ese documento (en una venta mixta no es su total).
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const cashDepositSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    number: { type: String, required: true },
    // Fecha de corte del depósito: hasta qué día se recogió el efectivo que se lleva al banco.
    date: { type: Date, required: true, index: true },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    // Número de papeleta que entrega el banco. Es el amarre con el estado de cuenta.
    voucherNumber: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    items: { type: [cashDepositItemSchema], default: [] },
    total: { type: Number, required: true, default: 0 },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    status: { type: String, enum: ['REGISTRADO', 'ANULADO'], default: 'REGISTRADO' },
    voidReason: { type: String, default: '' },
    // Idempotencia: un doble clic en «Confirmar depósito» no puede depositar dos veces.
    idempotencyKey: { type: String, trim: true, default: null },
    idempotencyFingerprint: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cashDepositSchema.index({ clinic: 1, number: 1 }, { unique: true });
cashDepositSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('CashDeposit', cashDepositSchema);
