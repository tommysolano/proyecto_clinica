const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: [true, 'El código es requerido'],
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
    },
    description: { type: String, trim: true },
    category: {
      type: String,
      enum: ['medicamento', 'insumo', 'servicio', 'otro'],
      default: 'otro',
    },
    purchasePrice: { type: Number, default: 0, min: 0 },
    salePrice: {
      type: Number,
      required: [true, 'El precio de venta es requerido'],
      min: 0,
    },
    stock: { type: Number, default: 0, min: 0 },
    minStock: { type: Number, default: 5, min: 0 },
    // Si es true, el producto se considera de stock infinito (no se descuenta ni valida).
    // Útil para servicios u otros ítems facturables sin inventario físico.
    unlimited: { type: Boolean, default: false },
    unit: { type: String, default: 'unidad', trim: true },
    taxRate: { type: Number, default: 15 },
    // Límite de citas para este servicio en un mismo día (0 o null = sin límite).
    // Solo aplica a productos de categoría 'servicio' o 'unlimited'.
    maxAppointmentsPerDay: { type: Number, default: 0, min: 0 },
    // Si true, este servicio NO marca al paciente como "nuevo" cuando se agenda
    // o se vende (útil para servicios recurrentes que no son una primera consulta).
    excludeFromFirstVisit: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Product', productSchema);
