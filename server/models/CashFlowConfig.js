const mongoose = require('mongoose');

/**
 * Configuración del módulo de flujo de caja. UNA sola por clínica.
 *
 * Las cuentas de caja y banco que forman el saldo inicial son EXPLÍCITAS: no se deduce
 * "todo lo que se llame banco" ni se casa el código por regex. Si la clínica no configuró
 * ninguna, el servicio las resuelve por ROL contable (`caja`, `cajaChica`, `bancos` de
 * utils/accountMap) e incluye sus cuentas hijas — nunca por el nombre de la cuenta.
 */

const subcategorySchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: false });

const categorySchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  // Marca las categorías de préstamo: se muestran siempre separadas y nunca se mezclan
  // con proveedores ni con gastos fijos.
  isLoan: { type: Boolean, default: false },
  subcategories: { type: [subcategorySchema], default: [] },
}, { _id: false });

const cashFlowConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true, index: true },

    // ── Cuentas que forman el disponible ─────────────────────────────────────────
    // Vacío = el servicio resuelve por rol contable (caja, cajaChica, bancos) + hijas.
    cashAccounts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' }],
    bankAccounts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' }],
    // Incluir automáticamente las cuentas hijas de las configuradas (jerarquía del plan).
    includeChildAccounts: { type: Boolean, default: true },

    // ── Horizonte ────────────────────────────────────────────────────────────────
    defaultHorizonDays: { type: Number, default: 30, min: 1 },
    maxRangeDays: { type: Number, default: 180, min: 1 },

    // ── Calendario ───────────────────────────────────────────────────────────────
    // Regla acordada: lunes a sábado son hábiles y el sábado NO se desplaza; el domingo
    // se proyecta al lunes. Apagar `includeSaturdays` convierte el sábado en no hábil.
    includeSaturdays: { type: Boolean, default: true },
    sundayPolicy: { type: String, enum: ['NEXT_BUSINESS_DAY'], default: 'NEXT_BUSINESS_DAY' },
    // Estructura preparada para feriados por clínica. Se deja VACÍA a propósito: todavía no
    // existe un catálogo oficial cargado y no se inventan feriados nacionales.
    holidays: [{
      date: { type: String, required: true }, // 'YYYY-MM-DD'
      label: { type: String, default: '' },
      _id: false,
    }],

    // ── SRI ──────────────────────────────────────────────────────────────────────
    // El vencimiento real lo fija la declaración (SriDeclaration.dueDate). Esto solo sirve
    // para estimar cuando una declaración todavía no lo trae.
    sriDueDayOfMonth: { type: Number, default: null, min: 1, max: 28 },

    // ── Categorías ───────────────────────────────────────────────────────────────
    categories: {
      INGRESO: { type: [categorySchema], default: [] },
      EGRESO: { type: [categorySchema], default: [] },
    },

    // ── Visualización y alertas ──────────────────────────────────────────────────
    minimumBalanceThreshold: { type: Number, default: 0 },
    showEmptyCategories: { type: Boolean, default: false },
    // Las obligaciones ya vencidas y no pagadas se acumulan en el primer día del rango
    // (marcadas como vencidas) para que no desaparezcan de la proyección.
    overdueBucket: { type: String, enum: ['FIRST_DAY', 'HIDE'], default: 'FIRST_DAY' },

    version: { type: Number, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/** Feriados como Set de claves 'YYYY-MM-DD' (vacío mientras no exista catálogo). */
cashFlowConfigSchema.methods.holidayKeys = function holidayKeys() {
  return (this.holidays || []).map((h) => h.date);
};

/** Opciones de calendario para utils/paymentSchedule. */
cashFlowConfigSchema.methods.calendarOptions = function calendarOptions() {
  return { includeSaturdays: this.includeSaturdays !== false, holidays: this.holidayKeys() };
};

module.exports = mongoose.model('CashFlowConfig', cashFlowConfigSchema);
