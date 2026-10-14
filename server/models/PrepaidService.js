const mongoose = require('mongoose');

/**
 * SESIONES PREPAGADAS (oct-2026). El paciente paga hoy servicios que se va a
 * hacer en citas futuras —4 sueroterapias, por ejemplo—. La venta (y su
 * factura) es una sola y se registra entera al cobrar; lo que queda aquí es el
 * SALDO DE SESIONES: cuántas pagó y en qué cita se usó cada una, para que al
 * asignar la atención de la próxima cita no se le vuelva a cobrar.
 *
 * Un documento por servicio y venta. `quantity` incluye la sesión de la cita
 * en la que se pagó (si se usó ahí): por eso esa cita también se ve «1 de 5».
 *
 * Se usa en CUALQUIER sucursal de la empresa donde se vendió. La empresa no se
 * guarda: se deduce siempre de la sucursal (ver utils/companies).
 *
 * Un uso cuya cita se canceló, se marcó como no asistida o se borró NO cuenta
 * (ver utils/sesionesPrepagadas): la sesión vuelve sola al paciente.
 */
const useSchema = new mongoose.Schema(
  {
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
    usedAt: { type: Date, default: Date.now },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const prepaidServiceSchema = new mongoose.Schema(
  {
    // Sucursal donde se VENDIÓ (la de la venta).
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    // El servicio del inventario (el mismo que enlaza el servicio de la agenda).
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, default: '' },
    // Si vino dentro de un PROGRAMA, el programa que se vendió.
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    programName: { type: String, default: '' },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    saleNumber: { type: String, default: '' },
    // Cita en la que se cobró (si se cobró desde la agenda).
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    quantity: { type: Number, required: true, min: 1 },
    uses: { type: [useSchema], default: [] },
    status: { type: String, enum: ['activo', 'anulado'], default: 'activo', index: true },
    voidedAt: { type: Date, default: null },
    // Revisión: cada uso la sube. Dos mostradores que asignan a la vez no pueden
    // gastar la misma sesión (el segundo ve otra revisión y vuelve a leer).
    rev: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

prepaidServiceSchema.index({ patient: 1, status: 1, product: 1 });
prepaidServiceSchema.index({ 'uses.appointment': 1 });

module.exports = mongoose.model('PrepaidService', prepaidServiceSchema);
