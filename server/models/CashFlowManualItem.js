const mongoose = require('mongoose');
const { planningChangeSchema } = require('./CashFlowPlan');

/**
 * Partida manual del flujo de caja: un ingreso o egreso PREVISTO que todavía no nació de
 * otro módulo (préstamo, aporte de socio, gasto extraordinario, cuota bancaria…).
 *
 * REGLA CONTABLE CENTRAL: una partida PLANIFICADA no genera asiento. Es una previsión, no
 * un hecho económico. Cuando el dinero se mueve de verdad, se registra por el flujo normal
 * (un cobro/pago o un asiento) y la partida se enlaza a ese documento vía `settledBy*`:
 * nunca se convierte sola en movimiento real ni "se contabiliza al marcarla pagada".
 */

const RECURRENCES = ['NONE', 'MONTHLY'];

const cashFlowManualItemSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    direction: { type: String, enum: ['INGRESO', 'EGRESO'], required: true },

    category: { type: String, required: true },
    subcategory: { type: String, default: null },

    // Tercero (texto libre: puede no existir como Supplier/Patient, p.ej. un banco acreedor).
    partyName: { type: String, default: '' },
    partyModel: { type: String, default: null },
    partyRef: { type: mongoose.Schema.Types.ObjectId, default: null },

    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },

    // Fecha PLANIFICADA del movimiento. Es la única fecha obligatoria: una previsión no
    // tiene vencimiento legal. `dueDate` es opcional (p.ej. la cuota de un préstamo sí lo
    // tiene) y, si existe, NUNCA se modifica al reprogramar.
    plannedDate: { type: Date, required: true, index: true },
    dueDate: { type: Date, default: null },
    // Solo se usa si la partida llega a generar un asiento propio (no lo hace por sí sola).
    accountingDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ['PLANIFICADO', 'REALIZADO', 'CANCELADO'],
      default: 'PLANIFICADO',
      index: true,
    },

    // Origen de la partida (para poder marcar los préstamos explícitamente y no deducirlos
    // de la descripción).
    origin: {
      type: String,
      enum: ['PRESTAMO', 'APORTE', 'GASTO_EXTRAORDINARIO', 'DEVOLUCION', 'OTRO'],
      default: 'OTRO',
    },
    // Desglose de una cuota de préstamo (no se deduce de ningún asiento: se captura).
    loan: {
      creditor: { type: String, default: '' },
      principal: { type: Number, default: 0 },
      interest: { type: Number, default: 0 },
      fee: { type: Number, default: 0 },
    },

    recurrence: { type: String, enum: RECURRENCES, default: 'NONE' },
    // Si la partida se generó desde otra recurrente, apunta al original (idempotencia).
    recurrenceParent: { type: mongoose.Schema.Types.ObjectId, ref: 'CashFlowManualItem', default: null },
    recurrenceKey: { type: String, default: null },

    // Documento real que la liquidó (Payment, BankTransaction, JournalEntry…). Se enlaza al
    // registrar el movimiento por el flujo normal; la partida no lo crea.
    settledByModel: { type: String, default: null },
    settledByRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    settledAt: { type: Date, default: null },

    // Enlace opcional a un documento origen ya existente.
    sourceModel: { type: String, default: null },
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },

    notes: { type: String, default: '' },
    history: { type: [planningChangeSchema], default: [] },

    // Idempotencia de la creación (mismo contrato que los pagos de la Fase 1): un doble clic
    // o dos peticiones simultáneas con la misma clave crean UNA sola partida.
    idempotencyKey: { type: String, default: null },
    idempotencyFingerprint: { type: String, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Carga de las partidas de un rango en una sola consulta.
cashFlowManualItemSchema.index({ clinic: 1, status: 1, plannedDate: 1 });
// Idempotencia por clínica (parcial: las partidas sin clave no colisionan entre sí).
cashFlowManualItemSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
// Una recurrencia no puede materializar dos veces el mismo período.
cashFlowManualItemSchema.index(
  { clinic: 1, recurrenceParent: 1, recurrenceKey: 1 },
  { unique: true, partialFilterExpression: { recurrenceKey: { $type: 'string' } } }
);

cashFlowManualItemSchema.statics.RECURRENCES = RECURRENCES;

module.exports = mongoose.model('CashFlowManualItem', cashFlowManualItemSchema);
