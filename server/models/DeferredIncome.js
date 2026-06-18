const mongoose = require('mongoose');

/**
 * Ingreso diferido de un paquete/programa vendido.
 *
 * Al vender un producto con `deferredIncome`, el ingreso (base imponible) no se
 * reconoce de inmediato: se acredita a "Ingresos diferidos" (pasivo) y queda
 * registrado aquí. Conforme se prestan las sesiones, se reconoce contra Ingresos
 * (Dr Ingresos diferidos / Cr Ingreso por servicios) total o parcialmente.
 *
 * El IVA de la venta sí se reconoce al momento (la obligación tributaria nace con
 * la factura); solo se difiere la base de ingreso.
 */
const deferredIncomeSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    sourceModel: { type: String, default: 'Sale' },
    sourceRef: { type: mongoose.Schema.Types.ObjectId, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productName: { type: String, default: '' },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    partyName: { type: String, default: '' },
    treatment: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
    // Cuenta de control (Ingresos diferidos) y cuenta de ingreso destino al reconocer.
    deferredAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    incomeAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Importe diferido = base imponible del ítem (sin IVA).
    total: { type: Number, required: true, min: 0 },
    recognized: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0 },
    sessionsTotal: { type: Number, default: 0, min: 0 },
    sessionsUsed: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['ABIERTO', 'PARCIAL', 'RECONOCIDO', 'ANULADO'], default: 'ABIERTO', index: true },
    issueDate: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Un solo registro de ingreso diferido por (venta, producto).
deferredIncomeSchema.index({ clinic: 1, sourceModel: 1, sourceRef: 1, product: 1 }, { unique: true });

deferredIncomeSchema.pre('validate', function (next) {
  const total = +Number(this.total || 0).toFixed(2);
  const recognized = +Number(this.recognized || 0).toFixed(2);
  this.total = total;
  this.recognized = recognized;
  this.balance = +(total - recognized).toFixed(2);
  if (this.status !== 'ANULADO') {
    if (this.balance <= 0.005) this.status = 'RECONOCIDO';
    else if (recognized > 0) this.status = 'PARCIAL';
    else this.status = 'ABIERTO';
  }
  next();
});

module.exports = mongoose.model('DeferredIncome', deferredIncomeSchema);
