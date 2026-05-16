const mongoose = require('mongoose');

/**
 * Plan de cuentas (estructura jerárquica por código).
 * Tipos basados en NIIF para PYMES / Supercías Ecuador.
 */
const ACCOUNT_TYPES = ['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'COSTO', 'ORDEN'];
const NATURES = ['DEBITO', 'CREDITO'];

const chartOfAccountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ACCOUNT_TYPES, required: true },
    nature: { type: String, enum: NATURES, required: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    level: { type: Number, default: 1 },
    // Si es false es una cuenta agrupadora (no recibe movimientos)
    allowsMovement: { type: Boolean, default: true },
    // Referencia a normativa (clase fiscal opcional)
    taxCode: { type: String, default: null },
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    // Marca cuentas creadas por seed/sistema (no se pueden borrar)
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

chartOfAccountSchema.index({ clinic: 1, code: 1 }, { unique: true });

chartOfAccountSchema.statics.ACCOUNT_TYPES = ACCOUNT_TYPES;
chartOfAccountSchema.statics.NATURES = NATURES;

module.exports = mongoose.model('ChartOfAccount', chartOfAccountSchema);
