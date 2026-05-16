const mongoose = require('mongoose');

/**
 * Categoría de inventario / activo fijo con parámetros tributarios.
 * Porcentajes de depreciación según Reglamento LRTI Art. 28 (Ecuador):
 *  - Inmuebles (excepto terrenos): 5% anual
 *  - Maquinaria, equipos: 10% anual
 *  - Vehículos y similares: 20% anual
 *  - Equipos de cómputo y software: 33% anual
 */
const inventoryCategorySchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['INVENTARIO', 'ACTIVO_FIJO'], required: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    // Para activos fijos:
    depreciationRate: { type: Number, default: 0 }, // % anual
    usefulLifeYears: { type: Number, default: 0 },
    residualPercent: { type: Number, default: 0 }, // % valor residual
    // Cuentas contables vinculadas
    assetAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    depreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    accumDepreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    expenseAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    incomeAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

inventoryCategorySchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('InventoryCategory', inventoryCategorySchema);
