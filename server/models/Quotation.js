const mongoose = require('mongoose');

const quotationItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productCode: String,
    productName: String,
    category: String,
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 15 },
    discount: { type: Number, default: 0, min: 0 },
    subtotal: { type: Number, required: true },
  },
  { _id: false }
);

const quotationSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    quotationNumber: { type: String },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    clientName: { type: String, default: 'Cliente', trim: true },
    clientCedula: { type: String, trim: true },
    clientEmail: { type: String, trim: true, lowercase: true },
    clientPhone: { type: String, trim: true },
    items: { type: [quotationItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    notes: String,
    validUntil: { type: Date },
    status: {
      type: String,
      enum: ['borrador', 'enviada', 'aceptada', 'rechazada', 'expirada'],
      default: 'borrador',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

quotationSchema.pre('save', async function (next) {
  if (!this.quotationNumber) {
    const Quotation = mongoose.model('Quotation');
    const count = await Quotation.countDocuments({ clinic: this.clinic });
    this.quotationNumber = `COT-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Quotation', quotationSchema);
