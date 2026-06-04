const mongoose = require('mongoose');

/**
 * Cierre de caja diario. El cajero cuenta el efectivo físico y el sistema lo
 * compara contra lo esperado (fondo inicial + ventas en efectivo del día),
 * registrando la diferencia (sobrante/faltante) y el desglose por método de pago.
 */
const cashClosingSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    date: { type: Date, required: true },
    // Ciclo de la caja: se ABRE (apertura) con un fondo inicial y luego se CIERRA.
    openedAt: { type: Date },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    openingBalance: { type: Number, default: 0 },   // fondo de caja inicial
    expectedCash: { type: Number, default: 0 },      // esperado = fondo + ventas efectivo
    countedCash: { type: Number, default: 0 },       // efectivo físico contado
    difference: { type: Number, default: 0 },        // contado - esperado (+ sobrante / - faltante)
    // Desglose por método de pago del día (informativo)
    byMethod: {
      efectivo: { type: Number, default: 0 },
      tarjeta: { type: Number, default: 0 },
      transferencia: { type: Number, default: 0 },
    },
    salesCount: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
    // Desglose de denominaciones (opcional)
    denominations: [{ value: Number, count: Number }],
    // ABIERTA = caja en curso; CERRADO = cerrada/cuadrada; ANULADO = anulada
    status: { type: String, enum: ['ABIERTA', 'CERRADO', 'ANULADO'], default: 'CERRADO' },
    notes: { type: String, default: '' },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Asiento contable del ajuste por diferencia (sobrante/faltante) al cerrar.
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  },
  { timestamps: true }
);

cashClosingSchema.index({ clinic: 1, date: -1 });

module.exports = mongoose.model('CashClosing', cashClosingSchema);
