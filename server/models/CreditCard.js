const mongoose = require('mongoose');

const posSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    name: { type: String, default: '' },
    terminal: { type: String, default: '' }, // nº de terminal/POS
    commissionRate: { type: Number, default: 0 }, // % comisión del POS
    active: { type: Boolean, default: true },
  },
  { _id: true }
);

/**
 * Tarjeta de crédito / medio de pago con tarjeta. Dentro de cada tarjeta se
 * crean los POS (terminales) asociados.
 */
const creditCardSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    brand: { type: String, enum: ['VISA', 'MASTERCARD', 'AMEX', 'DINERS', 'DISCOVER', 'OTRA'], default: 'VISA' },
    acquirer: { type: String, default: '' }, // Datafast, Medianet, Pacificard...
    accountType: { type: String, enum: ['CREDITO', 'DEBITO', 'CORRIENTE'], default: 'CREDITO' },
    chartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    commissionRate: { type: Number, default: 0 },
    retentionRate: { type: Number, default: 0 },
    pos: { type: [posSchema], default: [] },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CreditCard', creditCardSchema);
