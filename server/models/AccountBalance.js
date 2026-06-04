const mongoose = require('mongoose');

/**
 * Saldo materializado por cuenta y período (mes/año): acumula débitos y créditos
 * de los movimientos contabilizados. Permite mayor y balances instantáneos y
 * obtener saldo de apertura/movimiento/cierre por período sin reagrupar todo.
 */
const accountBalanceSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
  },
  { timestamps: true }
);

accountBalanceSchema.index({ clinic: 1, account: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('AccountBalance', accountBalanceSchema);
