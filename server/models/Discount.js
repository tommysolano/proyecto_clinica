const mongoose = require('mongoose');

/**
 * Descuento configurable que el admin define para 1 producto, varios o TODOS.
 * Se aplica en la línea de venta y se refleja en la factura SRI.
 */
const discountSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['percentage', 'amount'], // % sobre subtotal del ítem o monto fijo
      default: 'percentage',
    },
    value: { type: Number, required: true, min: 0 },
    // 'all' aplica a todos los productos; 'specific' a los de la lista
    scope: { type: String, enum: ['all', 'specific'], default: 'specific' },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },

    // --- Parametrizaciones adicionales ---
    // Días de la semana en que aplica (0=Dom ... 6=Sáb). Vacío = todos los días.
    daysOfWeek: { type: [Number], default: [] },
    // Franja horaria en que aplica (formato 'HH:MM'). Vacío = todo el día.
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    // Sucursales donde aplica. Vacío = todas las sucursales.
    clinics: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' }],
    // Público objetivo
    audience: { type: String, enum: ['todos', 'nuevos', 'recurrentes', 'cumpleanos'], default: 'todos' },
    // Compra mínima para que aplique el descuento
    minAmount: { type: Number, default: 0 },
    // Límite de usos (0 = ilimitado) y contador
    maxUses: { type: Number, default: 0 },
    usedCount: { type: Number, default: 0 },

    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Discount', discountSchema);
