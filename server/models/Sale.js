const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productCode: String,
  productName: String,
  category: String,
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  taxRate: { type: Number, default: 15 },
  subtotal: { type: Number, required: true },
});

const saleSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    saleNumber: { type: String },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    clientName: { type: String, default: 'Consumidor Final', trim: true },
    clientCedula: { type: String, default: '9999999999999', trim: true },
    clientEmail: { type: String, trim: true, lowercase: true },
    clientPhone: { type: String, trim: true },
    clientAddress: { type: String, trim: true },
    items: [saleItemSchema],
    subtotal: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    total: { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ['efectivo', 'tarjeta', 'transferencia'],
      default: 'efectivo',
    },
    status: {
      type: String,
      enum: ['completada', 'anulada'],
      default: 'completada',
    },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    notes: String,
    // Marca si es la primera venta/servicio del paciente (paciente nuevo).
    isFirstVisit: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Generar saleNumber por clínica
saleSchema.pre('save', async function (next) {
  if (!this.saleNumber) {
    const Sale = mongoose.model('Sale');
    const count = await Sale.countDocuments({ clinic: this.clinic });
    this.saleNumber = `V-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Sale', saleSchema);
