const mongoose = require('mongoose');

/**
 * CONSULTA GUARDADA del reporte de ventas ("preset").
 *
 * No es una categoría. `ServiceCategory` agrupa servicios de verdad (es un dato del negocio);
 * un preset es una BÚSQUEDA reutilizable de la contadora: "ventas de estética del mes, sin los
 * packs, más estos dos servicios sueltos, cobradas con tarjeta". Mezclarlos convertiría cada
 * consulta ad-hoc en una categoría comercial falsa.
 *
 * Por eso guarda la selección EXACTA: qué categorías entran, qué se saca de ellas y qué se
 * añade por fuera. Al aplicarlo se restaura la consulta completa (incluidos los filtros).
 */
const salesReportPresetSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Nombre normalizado (minúsculas, sin espacios extra): sostiene el índice único por clínica.
    nameKey: { type: String, required: true },
    description: { type: String, default: '' },

    // Selección: categorías comerciales de servicios (ServiceCategory).
    includeCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory' }],
    excludeCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory' }],
    // Ítems concretos: los `include` se añaden aunque no estén en las categorías; los `exclude`
    // se quitan aunque sí lo estén. La selección final es (categorías + incluidos) − excluidos.
    includeProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    excludeProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],

    // Filtros que se restauran con el preset (rango, método, centro de costo, estado…).
    filters: {
      status: { type: String, default: '' },
      method: { type: String, default: '' },          // efectivo | tarjeta_debito | …
      costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
      client: { type: String, default: '' },
      invoiceNumber: { type: String, default: '' },
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      // El rango se guarda solo si el preset lo fija; si no, lo elige el usuario al aplicarlo.
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
    },

    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Un nombre por clínica: dos presets "Estética" no pueden convivir (ni siquiera con otra caja).
salesReportPresetSchema.index({ clinic: 1, nameKey: 1 }, { unique: true });

/** Normaliza el nombre para el índice único (sin mayúsculas ni espacios de sobra). */
salesReportPresetSchema.statics.normalizeName = (name) =>
  String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

module.exports = mongoose.model('SalesReportPreset', salesReportPresetSchema);
