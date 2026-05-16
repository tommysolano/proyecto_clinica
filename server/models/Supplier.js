const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    ruc: { type: String, required: true, trim: true },
    tipoIdentificacion: { type: String, enum: ['RUC', 'CEDULA', 'PASAPORTE'], default: 'RUC' },
    razonSocial: { type: String, required: true, trim: true },
    nombreComercial: { type: String, default: '', trim: true },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },
    contactName: { type: String, default: '' },
    // Cuenta contable de gasto/activo por defecto al ingresar facturas (memoria)
    defaultExpenseAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    defaultPayableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Régimen tributario
    isSpecialContributor: { type: Boolean, default: false },
    isWithholdingAgent: { type: Boolean, default: false },
    rimpe: { type: String, enum: ['', 'POPULAR', 'EMPRENDEDOR'], default: '' },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

supplierSchema.index({ clinic: 1, ruc: 1 }, { unique: true });

module.exports = mongoose.model('Supplier', supplierSchema);
