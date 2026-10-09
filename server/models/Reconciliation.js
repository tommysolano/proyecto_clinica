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

// Línea del MAYOR conciliada en Contífico. En las cuentas importadas el libro del
// banco es el mayor (services/bankJournalLedger), no BankTransaction; se guarda una
// copia de lo que mostró Contífico por si el asiento cambia o se retira después.
const journalItemSchema = new mongoose.Schema(
  {
    // Un movimiento del banco puede ser varias líneas del mayor: un «PAGO MASIVO»
    // agrupa los asientos de pago de cada factura de esa transferencia.
    lines: {
      type: [new mongoose.Schema({
        journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
        lineIndex: { type: Number, required: true },
      }, { _id: false })],
      default: [],
    },
    note: { type: String, default: '' },
    date: { type: Date, default: null },
    type: { type: String, default: '' }, // TRANSF, CHE, DEP, N/C…
    description: { type: String, default: '' },
    reference: { type: String, default: '' },
    party: { type: String, default: '' },
    amount: { type: Number, default: 0 }, // + entra al banco, - sale
    matched: { type: Boolean, default: true },
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
    // Conciliación local: libro menos partidas todavía en tránsito. La diferencia
    // ajustada es la que debe llegar a cero frente al extracto bancario.
    outstandingBalance: { type: Number, default: null },
    adjustedBalance: { type: Number, default: null },
    adjustedDifference: { type: Number, default: null },
    pendingCount: { type: Number, default: null },
    items: { type: [reconciliationItemSchema], default: [] },
    statementLines: { type: [statementLineSchema], default: [] },
    // BORRADOR = Pendiente (en proceso) · CONCILIADO = terminado
    status: { type: String, enum: ['BORRADOR', 'CONCILIADO'], default: 'BORRADOR' },
    notes: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    // CONTIFICO = importada del reporte de Contífico; sus movimientos son líneas del mayor.
    source: { type: String, enum: ['LOCAL', 'CONTIFICO'], default: 'LOCAL' },
    sourceKey: { type: String, default: null }, // contifico:<nº cuenta>:<AAAA-MM-DD>
    openingBalance: { type: Number, default: null }, // saldo bancario inicial según Contífico
    journalItems: { type: [journalItemSchema], default: [] },
    // Partidas pendientes al corte según Contífico: explican saldo contable − bancario.
    // Los cheques posfechados son informativos (fecha posterior al corte).
    pendingItems: {
      type: [new mongoose.Schema({
        category: { type: String, enum: ['DEPOSITO_TRANSITO', 'CHEQUE_PENDIENTE', 'NC_TRANSITO', 'ND_TRANSITO', 'CHEQUE_POSTFECHADO'], required: true },
      }, { _id: false }).add(journalItemSchema)],
      default: [],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

reconciliationSchema.index({ clinic: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } });

module.exports = mongoose.model('Reconciliation', reconciliationSchema);
