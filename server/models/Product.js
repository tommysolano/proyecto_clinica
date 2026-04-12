const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'El código es requerido'],
    unique: true,
    trim: true,
  },
  name: {
    type: String,
    required: [true, 'El nombre es requerido'],
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  category: {
    type: String,
    enum: ['medicamento', 'insumo', 'servicio', 'otro'],
    default: 'otro',
  },
  purchasePrice: {
    type: Number,
    default: 0,
    min: 0,
  },
  salePrice: {
    type: Number,
    required: [true, 'El precio de venta es requerido'],
    min: 0,
  },
  stock: {
    type: Number,
    default: 0,
    min: 0,
  },
  minStock: {
    type: Number,
    default: 5,
    min: 0,
  },
  unit: {
    type: String,
    default: 'unidad',
    trim: true,
  },
  taxRate: {
    type: Number,
    default: 15,
  },
  active: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
