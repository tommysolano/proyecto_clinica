const mongoose = require('mongoose');

/**
 * Categoría de servicios para reportes de ventas. Agrupa varios productos/
 * servicios bajo un nombre para poder filtrar reportes por categoría guardada.
 */
const serviceCategorySchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    color: { type: String, default: '#10b981' },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

serviceCategorySchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
