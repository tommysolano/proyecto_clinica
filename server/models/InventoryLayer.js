const mongoose = require('mongoose');

/**
 * Capa de inventario (kardex valorado). Cada entrada de stock (compra, ajuste,
 * saldo inicial) crea una capa con su costo, lote y vencimiento. Las salidas
 * consumen capas por orden de llegada (FIFO), de modo que el costo de venta es
 * exacto y reversible, y el inventario queda valorado por capa.
 */
const inventoryLayerSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    lot: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
    qtyInitial: { type: Number, required: true, min: 0 },
    qtyRemaining: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, index: true }, // orden FIFO
    sourceModel: { type: String, default: null }, // PurchaseInvoice | Sale | Adjustment | Opening
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    exhausted: { type: Boolean, default: false, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Selección eficiente de capas disponibles en orden FIFO.
inventoryLayerSchema.index({ clinic: 1, product: 1, warehouse: 1, exhausted: 1, date: 1 });

module.exports = mongoose.model('InventoryLayer', inventoryLayerSchema);
