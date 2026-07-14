const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '' },   // se conserva por compatibilidad
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    chartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    /**
     * Centro de costo PREDETERMINADO de la bodega. Es una PROPUESTA, no una imposición: cuando
     * un documento (compra, traslado, toma física, ajuste) elige esta bodega y no trae centro de
     * costo, se propone éste. Si el usuario elige otro, se avisa y se registra el que realmente
     * se usó — el documento manda.
     */
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    isMain: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

warehouseSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Warehouse', warehouseSchema);
