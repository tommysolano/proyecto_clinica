const mongoose = require('mongoose');

/**
 * ÍTEMS DEL PACIENTE (oct-2026). Lo que el paciente COMPRÓ y todavía no se le
 * aplicó: ampollas, moléculas, sueros… (cualquier ítem físico).
 *
 * Al cobrar, cada línea física de un paciente dice qué pasa con lo comprado:
 *
 *   · 'en_clinica' — lo compra pero NO se lo lleva: se queda en la clínica para
 *     aplicárselo después. NO sale del inventario al venderlo (sigue en la percha)
 *     y el paciente queda como su DUEÑO. Sale del inventario cuando se le aplica:
 *     en el cobro del servicio que lo usa (ítem vinculado «del paciente») o con
 *     «Aplicar» desde su perfil. Así no se le cobra otra vez.
 *
 *   · 'llevado' — se lo lleva: sale del inventario al venderlo, como siempre. Se
 *     anota igual (solo si es un ítem vinculado de algún servicio) para que, cuando
 *     vuelva con él a aplicárselo, el cobro avise de que lo TRAJO y no se descuente.
 *
 * Un documento por línea de venta. `remaining` baja con cada uso; los usos dicen
 * dónde se gastó. Se usa en cualquier sucursal de la empresa donde se vendió (la
 * empresa se deduce de la sucursal, como en PrepaidService).
 */
const useSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    quantity: { type: Number, required: true, min: 0 },
    // Venta en la que se usó (ítem vinculado de un servicio). Vacío = «Aplicar» a mano.
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
    saleNumber: { type: String, default: '' },
    // Para qué se usó: el servicio cobrado, o la nota de quien lo aplicó a mano.
    detail: { type: String, default: '', trim: true },
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    // Inventario que movió ESTE uso (solo 'en_clinica' aplicado a mano): para que
    // anular la venta de origen sepa que ya salió de la percha.
    stockMoved: { type: Number, default: 0 },
  },
  { _id: true }
);

const patientItemSchema = new mongoose.Schema(
  {
    // Sucursal donde se VENDIÓ.
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: { type: String, default: '' },
    productName: { type: String, default: '' },
    mode: { type: String, enum: ['en_clinica', 'llevado'], required: true },
    quantity: { type: Number, required: true, min: 0 },
    remaining: { type: Number, required: true, min: 0 },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    saleNumber: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    uses: { type: [useSchema], default: [] },
    status: { type: String, enum: ['activo', 'anulado'], default: 'activo', index: true },
    voidedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

patientItemSchema.index({ patient: 1, status: 1, product: 1, mode: 1 });
patientItemSchema.index({ 'uses.sale': 1 });

module.exports = mongoose.model('PatientItem', patientItemSchema);
