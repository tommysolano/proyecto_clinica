const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productName: String,
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  unitPrice: {
    type: Number,
    required: true,
  },
  taxRate: {
    type: Number,
    default: 15,
  },
  subtotal: {
    type: Number,
    required: true,
  },
});

const saleSchema = new mongoose.Schema({
  saleNumber: {
    type: String,
    unique: true,
  },
  patient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
  },
  clientName: {
    type: String,
    default: 'Consumidor Final',
    trim: true,
  },
  clientCedula: {
    type: String,
    default: '9999999999999',
    trim: true,
  },
  items: [saleItemSchema],
  subtotal: {
    type: Number,
    required: true,
  },
  taxAmount: {
    type: Number,
    required: true,
  },
  total: {
    type: Number,
    required: true,
  },
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
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

// Auto-generar número de venta
saleSchema.pre('save', async function (next) {
  if (!this.saleNumber) {
    const count = await mongoose.model('Sale').countDocuments();
    this.saleNumber = `V-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Sale', saleSchema);
