const mongoose = require('mongoose');

/**
 * Configuración contable por clínica: mapa de "rol de cuenta" → cuenta contable.
 * Permite que el sistema NO elija las cuentas automáticamente por código fijo,
 * sino que el contador defina qué cuenta usar para cada concepto.
 */
const accountingConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true, index: true },
    // role -> ChartOfAccount _id
    accounts: { type: Map, of: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' }, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AccountingConfig', accountingConfigSchema);
