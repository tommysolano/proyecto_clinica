const mongoose = require('mongoose');

/**
 * EMPRESA (oct-2026): una razón social con sus propias sucursales.
 *
 * Cada empresa lleva su agenda, su personal, sus ventas, su catálogo y su
 * contabilidad. Los PACIENTES (y su historia clínica) y el CRM son de todas.
 *
 * La empresa cuelga SOLO de la sucursal (`Clinic.company`): nunca se copia en
 * citas, ventas ni asientos. Así mover una sucursal a otra empresa es cambiar un
 * campo, y todo lo de esa sucursal se va con ella. La de cualquier documento se
 * deduce de su sucursal (utils/companies).
 */
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'El nombre es requerido'], trim: true },
    ruc: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || /^\d{13}$/.test(v),
        message: 'RUC debe tener 13 dígitos',
      },
    },
    razonSocial: { type: String, trim: true, default: '' },
    nombreComercial: { type: String, trim: true, default: '' },
    logoUrl: { type: String, trim: true, default: '' },
    // La empresa con la que nació el sistema. Lo que no tiene empresa es suyo.
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Solo puede haber una empresa principal: es el candado de la migración al arrancar.
companySchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

module.exports = mongoose.model('Company', companySchema);
