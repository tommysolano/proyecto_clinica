const mongoose = require('mongoose');

/**
 * Plan de flujo de caja de UN documento (CxC, CxP o partida manual).
 *
 * Guarda lo que decide la clínica SOBRE el documento, sin tocar el documento contable:
 *   - reclasificación (categoría / subcategoría);
 *   - exclusión temporal de la proyección;
 *   - notas;
 *   - HISTORIAL auditado de todos esos cambios y de las reprogramaciones.
 *
 * La fecha reprogramada NO vive aquí: se escribe en `plannedPaymentDate` del propio
 * documento de cartera, que ya es el campo que consume `effectivePaymentDate` desde la
 * Fase 1. Tener dos fuentes de verdad para la misma fecha sería pedir que discrepen. Lo que
 * este modelo aporta sobre la reprogramación es la AUDITORÍA (valor anterior, valor nuevo,
 * usuario, fecha y motivo), que el documento de cartera no guarda.
 *
 * `dueDate` (vencimiento legal) NUNCA se modifica por ninguna de estas operaciones.
 */

const planningChangeSchema = new mongoose.Schema({
  field: {
    type: String,
    enum: ['plannedPaymentDate', 'plannedCollectionDate', 'category', 'subcategory', 'excluded', 'amount', 'notes'],
    required: true,
  },
  previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  reason: { type: String, default: '' },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });

const cashFlowPlanSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    // Documento al que se refiere el plan.
    docModel: { type: String, enum: ['Payable', 'Receivable', 'CashFlowManualItem'], required: true },
    docRef: { type: mongoose.Schema.Types.ObjectId, required: true },
    direction: { type: String, enum: ['INGRESO', 'EGRESO'], required: true },

    // Override de clasificación (nivel 1 de la prioridad: gana a cualquier regla).
    category: { type: String, default: null },
    subcategory: { type: String, default: null },

    // Exclusión temporal de la proyección (el documento contable sigue vivo).
    excluded: { type: Boolean, default: false },
    excludedReason: { type: String, default: '' },

    notes: { type: String, default: '' },

    // Toda modificación de fecha planificada, clasificación o inclusión queda aquí.
    history: { type: [planningChangeSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Un solo plan por documento y clínica. Dos reprogramaciones simultáneas del mismo
// documento chocan aquí y el controlador las resuelve sin devolver un E11000 crudo.
cashFlowPlanSchema.index({ clinic: 1, docModel: 1, docRef: 1 }, { unique: true });

module.exports = mongoose.model('CashFlowPlan', cashFlowPlanSchema);
module.exports.planningChangeSchema = planningChangeSchema;
