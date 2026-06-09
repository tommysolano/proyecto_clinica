const mongoose = require('mongoose');

/**
 * Registro de una contabilización de comisiones devengadas en un período.
 * Las comisiones se calculan sobre la marcha (no se persisten por evento), por
 * lo que este documento sirve para: (1) dejar constancia de qué rango ya fue
 * contabilizado y evitar duplicados, y (2) enlazar el asiento contable generado
 * (Débito gasto comisiones / Crédito comisiones por pagar al personal).
 */
const commissionPostingSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    total: { type: Number, default: 0 },
    // Resumen por usuario (para auditoría / referencia).
    byUser: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        userName: String,
        count: Number,
        total: Number,
        _id: false,
      },
    ],
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    status: { type: String, enum: ['CONTABILIZADO', 'ANULADO'], default: 'CONTABILIZADO' },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommissionPosting', commissionPostingSchema);
