const mongoose = require('mongoose');

/**
 * Regla de clasificación automática de documentos en el flujo de caja.
 *
 * El orden de prioridad lo aplica el servicio (ver services/cashFlowService.classify):
 *   1. override explícito del documento (CashFlowPlan)
 *   2. regla por TERCERO      (SUPPLIER / CUSTOMER)
 *   3. regla por CUENTA o CONCEPTO (ACCOUNT / PURCHASE_CATEGORY / PAYROLL_CONCEPT)
 *   4. regla por ORIGEN       (SOURCE_MODEL / SOURCE_ACTION / DOC_TYPE / DECLARATION_TYPE)
 *   5. clasificación por defecto del módulo
 *   6. Sin clasificar
 *
 * `DESCRIPTION` existe como ÚLTIMO nivel y solo si el usuario la configura a mano: el
 * sistema nunca clasifica un préstamo, un impuesto o un gasto fijo buscando palabras en la
 * descripción por su cuenta.
 */
const MATCH_TYPES = [
  'SUPPLIER',           // matchValue = Supplier._id
  'CUSTOMER',           // matchValue = Patient._id
  'ACCOUNT',            // matchValue = ChartOfAccount._id
  'SOURCE_MODEL',       // matchValue = 'PurchaseInvoice' | 'Payroll' | 'SriDeclaration' | ...
  'SOURCE_ACTION',      // matchValue = 'FINALIZE' | 'CLOSE' | 'PAY' | ...
  'DOC_TYPE',           // matchValue = 'COMPRA' | 'FACTURA' | 'OTRO' | ...
  'PURCHASE_CATEGORY',  // matchValue = InventoryCategory._id
  'PAYROLL_CONCEPT',    // matchValue = PayrollConcept._id o code
  'DECLARATION_TYPE',   // matchValue = '103' | '104'
  'DESCRIPTION',        // matchValue = subcadena (case-insensitive). Último recurso.
];

// Prioridad base por tipo de coincidencia (menor gana). `priority` la ajusta dentro del tipo.
const MATCH_RANK = {
  SUPPLIER: 20,
  CUSTOMER: 20,
  ACCOUNT: 30,
  PURCHASE_CATEGORY: 30,
  PAYROLL_CONCEPT: 30,
  SOURCE_MODEL: 40,
  SOURCE_ACTION: 40,
  DOC_TYPE: 40,
  DECLARATION_TYPE: 40,
  DESCRIPTION: 50,
};

const cashFlowMappingSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    direction: { type: String, enum: ['INGRESO', 'EGRESO'], required: true },
    matchType: { type: String, enum: MATCH_TYPES, required: true },
    matchValue: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    subcategory: { type: String, default: null, trim: true },
    // Desempate DENTRO del mismo matchType (menor gana).
    priority: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Una sola regla por (clínica, dirección, tipo, valor): crear la misma dos veces en
// paralelo choca contra el índice y el controlador lo resuelve devolviendo la existente.
cashFlowMappingSchema.index(
  { clinic: 1, direction: 1, matchType: 1, matchValue: 1 },
  { unique: true }
);
// Carga de todas las reglas activas de una clínica en una sola consulta.
cashFlowMappingSchema.index({ clinic: 1, isActive: 1, matchType: 1 });

cashFlowMappingSchema.statics.MATCH_TYPES = MATCH_TYPES;
cashFlowMappingSchema.statics.MATCH_RANK = MATCH_RANK;

module.exports = mongoose.model('CashFlowMapping', cashFlowMappingSchema);
