const mongoose = require('mongoose');

/**
 * Regla de retención parametrizable (catálogo por clínica). El personal contable
 * escoge el CÓDIGO por línea de compra y el sistema conoce el porcentaje, calcula la
 * base y el monto y resuelve la cuenta de retención por pagar. El catálogo es EDITABLE
 * porque las tarifas del SRI cambian; el seed inicial solo trae códigos comunes.
 *
 * `baseType` define cómo se calcula la base sobre la línea:
 *   - SUBTOTAL_TOTAL: subtotal de la línea antes de IVA (uso típico de RENTA).
 *   - SUBTOTAL_IVA:   base solo si la línea está gravada con IVA (>0).
 *   - SUBTOTAL_0:     base solo si la línea es 0%.
 *   - IVA:            el monto de IVA de la línea (uso típico de retención de IVA).
 */
const retentionRuleSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    type: { type: String, enum: ['RENTA', 'IVA'], required: true },
    code: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    rate: { type: Number, required: true, min: 0, max: 100 },
    appliesTo: {
      type: String,
      enum: ['BIENES', 'SERVICIOS', 'TRANSPORTE', 'HONORARIOS', 'ARRENDAMIENTO', 'OTRO'],
      default: 'OTRO',
    },
    baseType: {
      type: String,
      enum: ['SUBTOTAL_IVA', 'SUBTOTAL_0', 'SUBTOTAL_TOTAL', 'IVA'],
      default: 'SUBTOTAL_TOTAL',
    },
    // Cuenta de retención por pagar. Si es null, se resuelve por accountMap
    // (retIvaPorPagar / retRentaPorPagar) como fallback controlado.
    payableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Un código de retención es único por clínica y tipo.
retentionRuleSchema.index({ clinic: 1, type: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('RetentionRule', retentionRuleSchema);
