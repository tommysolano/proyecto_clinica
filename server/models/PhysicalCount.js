const mongoose = require('mongoose');

/**
 * Ítem de una toma física. `systemQty` y `unitCost` son un SNAPSHOT del momento en que se
 * inició la toma: el stock que el sistema decía EN ESA BODEGA y el costo real de sus capas.
 * Si después alguien cambia la categoría del producto o compra más unidades, la toma no cambia
 * sola: se contó lo que se contó contra lo que el sistema decía entonces.
 */
const countItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: String,
    productName: String,
    barcode: String,
    // Categoría de inventario del producto EN EL MOMENTO del snapshot.
    inventoryCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    categoria: String,                                   // categoría comercial (snapshot)
    systemQty: { type: Number, default: 0 },             // stock del sistema EN LA BODEGA
    countedQty: { type: Number, default: 0 },
    counted: { type: Boolean, default: false },          // ¿alguien lo contó de verdad?
    difference: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },              // costo real de las capas (no purchasePrice)
    adjustmentValue: { type: Number, default: 0 },
    notes: String,
  },
  { _id: false }
);

const physicalCountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    // La bodega es OBLIGATORIA en las tomas nuevas: un conteo sin bodega ajustaba el stock
    // global y creaba capas sin bodega (corrompía las existencias por bodega).
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    // Categoría de inventario contada (null = todas las inventariables de la bodega).
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    date: { type: Date, default: Date.now },             // fecha FUNCIONAL de la toma
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    description: String,
    notes: String,
    items: { type: [countItemSchema], default: [] },
    // Snapshot: qué se congeló y cuándo (auditoría).
    snapshotAt: { type: Date, default: null },
    snapshotBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['BORRADOR', 'CONFIRMADO', 'ANULADO'], default: 'BORRADOR' },
    adjustmentEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    confirmedAt: Date,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

physicalCountSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('PhysicalCount', physicalCountSchema);
