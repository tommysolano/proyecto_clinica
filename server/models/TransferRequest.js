const mongoose = require('mongoose');

/**
 * SOLICITUD DE TRASLADO ENTRE BODEGAS (nov-2026).
 *
 * El usuario de un punto de emisión que tiene bodega (PuntoEmision.bodega) pide ítems PARA esa
 * bodega. Un administrador (o contabilidad) la atiende: escoge desde qué bodega salen, puede
 * ajustar las cantidades y la aprueba, lo que ejecuta el traslado real (mismo núcleo que el
 * traslado directo: kardex, capas FIFO y asiento si corresponde). O la rechaza con un motivo.
 *
 *   PENDIENTE → APROBADA (con `transferGroup`) | RECHAZADA | CANCELADA (la retira quien pidió)
 *
 * `clinic` es la sucursal de la bodega destino (donde se ejecuta el traslado);
 * `requesterClinic`, la sucursal activa de quien pidió (ahí le llega el aviso de respuesta).
 */
const itemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: String,
    productName: String,
    quantity: { type: Number, required: true, min: 0 },       // lo pedido
    approvedQty: { type: Number, default: null },             // lo que se trasladó (al aprobar)
    // Bodega de la que salió ESTE ítem (nov-2026): el administrador puede sacar ítems sueltos de
    // otra bodega distinta de la principal (`fromWarehouse` de la solicitud). null = la principal.
    fromWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
  },
  { _id: false }
);

const transferRequestSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    requesterClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    code: { type: String, required: true },
    puntoEmision: { type: mongoose.Schema.Types.ObjectId, ref: 'PuntoEmision', default: null },
    toWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    fromWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    items: { type: [itemSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: ['PENDIENTE', 'APROBADA', 'RECHAZADA', 'CANCELADA'], default: 'PENDIENTE', index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, maxlength: 500, default: '' },
    transferGroup: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Un traslado por cada bodega de origen (si hubo ítems de varias bodegas).
    transferGroups: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);

transferRequestSchema.index({ clinic: 1, code: 1 }, { unique: true });
transferRequestSchema.index({ requestedBy: 1, createdAt: -1 });

module.exports = mongoose.model('TransferRequest', transferRequestSchema);
