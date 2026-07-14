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
      enum: ['entrada', 'salida', 'ajuste', 'traslado'],
      required: true,
    },
    /**
     * FECHA FUNCIONAL del movimiento (la del documento: compra, venta, toma física…), que es
     * por la que se ordena y filtra el kardex. `createdAt` es la fecha TÉCNICA de grabación y
     * no sirve: una compra del 3 registrada el 20 se movió el 3.
     *
     * Los movimientos históricos no la tienen; ahí el kardex cae a `createdAt` y lo MARCA
     * (`dateSource: 'CREATED_AT'`) en vez de fingir que es una fecha funcional.
     */
    movementDate: { type: Date, default: null, index: true },
    dateSource: {
      type: String,
      enum: ['DOCUMENTO', 'MOVIMIENTO', 'CREATED_AT'],
      default: 'MOVIMIENTO',
    },
    // Bodega de origen (y destino para traslados)
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    toWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    /**
     * Las dos patas de un traslado (la SALIDA de la bodega origen y la ENTRADA en la destino)
     * comparten `transferGroup`. Así el kardex de cada bodega ve su propio movimiento con el
     * signo correcto, y el consolidado los reconoce como UNA reubicación de efecto neto cero
     * (antes había un único movimiento `traslado` al que el kardex daba signo 0: no aparecía
     * ni en el origen ni en el destino).
     */
    transferGroup: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // Centro de costo del movimiento (por defecto, el de la bodega).
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },     // costo unitario de la entrada (compra/ajuste)
    totalCost: { type: Number, default: 0 },    // qty * unitCost
    balanceAfter: { type: Number, default: 0 }, // stock resultante después del movimiento
    reason: { type: String, trim: true },
    reference: { type: String, trim: true },
    sourceModel: { type: String, default: null }, // p.ej. 'PurchaseInvoice', 'Sale'
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Trazabilidad de lote/vencimiento y consumo FIFO de capas (kardex).
    lot: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
    layerConsumption: {
      type: [{
        layer: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLayer' },
        qty: Number,
        unitCost: Number,
      }],
      default: [],
    },
    // Asiento contable del movimiento, cuando lo tiene (traslado entre cuentas, ajuste…).
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Kardex: los movimientos de un producto/bodega en orden cronológico.
inventoryMovementSchema.index({ clinic: 1, product: 1, movementDate: 1 });
inventoryMovementSchema.index({ clinic: 1, warehouse: 1, movementDate: 1 });

/** Fecha con la que el kardex ordena y filtra. Cae a `createdAt` solo en los históricos. */
inventoryMovementSchema.virtual('effectiveDate').get(function effectiveDate() {
  return this.movementDate || this.createdAt;
});

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
