const mongoose = require('mongoose');

/**
 * Cuenta de gasto/activo de uso frecuente en compras (estilo Contífico).
 * Se registra cuando el contador autoriza una factura asignando una cuenta; el sistema
 * memoriza la cuenta a nivel clínica (supplier = null) y por proveedor para sugerirla
 * como acceso rápido en la siguiente compra. El ranking usa useCount/lastUsedAt.
 */
const recurringAccountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    // null = recurrente a nivel clínica; con valor = recurrente para ese proveedor.
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    label: { type: String, default: '' },
    useCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

recurringAccountSchema.index({ clinic: 1, supplier: 1, account: 1 }, { unique: true });

module.exports = mongoose.model('RecurringAccount', recurringAccountSchema);
