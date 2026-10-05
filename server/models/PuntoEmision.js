const mongoose = require('mongoose');

/**
 * PUNTO DE EMISIÓN / PUNTO DE VENTA (oct-2026).
 *
 * Cada caja de una sucursal es un punto de emisión del SRI (la serie `estab-ptoEmi` de la
 * factura) con su propia numeración, y pertenece a UN solo usuario (cajero o administrador):
 * lo que ese usuario factura, las notas de crédito que emite y su caja (apertura/cierre) salen
 * de su punto. Un usuario tiene como máximo un punto por sucursal y un punto un solo usuario.
 *
 * Mientras una sucursal no tenga ningún punto creado se sigue usando el par único
 * `establecimiento/puntoEmision` de InvoicingConfig (comportamiento anterior). En cuanto se crea
 * el primero, facturar y abrir caja exigen tener un punto asignado (services/puntoEmision).
 *
 * Los secuenciales guardan el PRÓXIMO número a usar y se reservan con `$inc` atómico: dos cajas
 * facturando a la vez nunca sacan el mismo número.
 */
const codigo3 = {
  validator: (v) => /^\d{3}$/.test(v),
  message: 'Debe tener 3 dígitos (p. ej. 001)',
};

const puntoEmisionSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    establecimiento: { type: String, required: true, validate: codigo3 },
    codigo: { type: String, required: true, validate: codigo3 },
    nombre: { type: String, trim: true, maxlength: 120, default: '' },
    // Dirección del establecimiento que va en el XML/RIDE. Vacía = la de la configuración SRI.
    direccionEstablecimiento: { type: String, trim: true, maxlength: 300, default: '' },
    usuario: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    secuencialFactura: { type: Number, default: 1, min: 1, max: 999999999 },
    secuencialNotaCredito: { type: Number, default: 1, min: 1, max: 999999999 },
    activo: { type: Boolean, default: true },
  },
  { timestamps: true }
);

puntoEmisionSchema.index({ clinic: 1, establecimiento: 1, codigo: 1 }, { unique: true });
// Un usuario, un punto por sucursal.
puntoEmisionSchema.index(
  { clinic: 1, usuario: 1 },
  { unique: true, partialFilterExpression: { usuario: { $type: 'objectId' } } }
);

puntoEmisionSchema.virtual('serie').get(function () {
  return `${this.establecimiento}-${this.codigo}`;
});

puntoEmisionSchema.set('toJSON', { virtuals: true });
puntoEmisionSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('PuntoEmision', puntoEmisionSchema);
