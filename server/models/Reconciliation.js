const mongoose = require('mongoose');

// Movimiento del libro (banco) incluido en la conciliación.
const reconciliationItemSchema = new mongoose.Schema(
  {
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
    matched: { type: Boolean, default: false }, // ¿apareció en el extracto del banco?
    statementRef: { type: String, default: '' },
  },
  { _id: false }
);

// Línea del extracto bancario importado (CSV/Excel) dentro de la conciliación.
const statementLineSchema = new mongoose.Schema(
  {
    date: { type: Date, default: null },
    description: { type: String, default: '' },
    reference: { type: String, default: '' },
    amount: { type: Number, default: 0 }, // + = crédito/depósito, - = débito/retiro
    matched: { type: Boolean, default: false },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
  },
  { _id: false }
);

const reconciliationSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    // Fecha de corte: se concilia hasta esta fecha (no se usa fecha inicial).
    cutDate: { type: Date, required: true },
    // periodStart/periodEnd se conservan por compatibilidad (periodEnd = fecha de corte).
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    description: { type: String, default: '' },
    statementBalance: { type: Number, default: 0 }, // saldo bancario (extracto)
    bookBalance: { type: Number, default: 0 },      // saldo contable (libro)
    difference: { type: Number, default: 0 },
    items: { type: [reconciliationItemSchema], default: [] },
    statementLines: { type: [statementLineSchema], default: [] },
    // BORRADOR = Pendiente (en proceso) · CONCILIADO = terminado
    status: { type: String, enum: ['BORRADOR', 'CONCILIADO'], default: 'BORRADOR' },
    notes: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Reconciliation', reconciliationSchema);
