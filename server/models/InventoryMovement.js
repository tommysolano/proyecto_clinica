const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    type: {
      type: String,
      enum: ['entrada', 'salida', 'ajuste'],
      required: true,
    },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },     // costo unitario de la entrada (compra/ajuste)
    totalCost: { type: Number, default: 0 },    // qty * unitCost
    balanceAfter: { type: Number, default: 0 }, // stock resultante después del movimiento
    reason: { type: String, trim: true },
    reference: { type: String, trim: true },
    sourceModel: { type: String, default: null }, // p.ej. 'PurchaseInvoice', 'Sale'
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
