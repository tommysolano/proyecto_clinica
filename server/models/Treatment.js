const mongoose = require('mongoose');

/**
 * Treatment plan = un conjunto ordenado de servicios (Products de tipo 'servicio')
 * que un paciente debe completar. Permite ver progreso y alertas para marketing.
 */
const treatmentItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: String, // snapshot
    quantity: { type: Number, default: 1, min: 1 },
    // Cuántas veces ya completó este servicio dentro del tratamiento
    completed: { type: Number, default: 0, min: 0 },
    // Ítems donde se registró el cumplimiento (citas/ventas)
    completionRefs: [
      {
        type: { type: String, enum: ['appointment', 'sale'] },
        ref: { type: mongoose.Schema.Types.ObjectId },
        date: Date,
        _id: false,
      },
    ],
  },
  { _id: false }
);

const treatmentSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    items: { type: [treatmentItemSchema], default: [] },
    // Doctor que recetó el tratamiento
    prescribedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startDate: { type: Date, default: Date.now },
    targetEndDate: { type: Date },
    status: {
      type: String,
      enum: ['activo', 'completado', 'abandonado'],
      default: 'activo',
    },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Porcentaje de avance virtual
treatmentSchema.virtual('progress').get(function () {
  const total = this.items.reduce((s, it) => s + (it.quantity || 0), 0);
  if (!total) return 0;
  const done = this.items.reduce(
    (s, it) => s + Math.min(it.completed || 0, it.quantity || 0),
    0
  );
  return Math.round((done / total) * 100);
});

treatmentSchema.set('toJSON', { virtuals: true });
treatmentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Treatment', treatmentSchema);
