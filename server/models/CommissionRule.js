const mongoose = require('mongoose');

/**
 * Regla de comisión configurable (definida por admin / super-admin).
 * Una comisión se devenga cuando un usuario REALIZA un servicio (cita completada)
 * que cumple con los criterios de la regla.
 */
const commissionRuleSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },

    // A quién aplica: a un usuario específico o a un rol completo.
    targetType: { type: String, enum: ['user', 'role'], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    role: { type: String, default: '' },

    // Servicio específico (producto). Si es null, aplica a cualquier servicio.
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // A qué pacientes aplica: solo nuevos o todos.
    patientScope: { type: String, enum: ['new', 'all'], default: 'all' },

    // Horario opcional. Si scheduleEnabled=false, aplica a cualquier hora.
    scheduleEnabled: { type: Boolean, default: false },
    daysOfWeek: { type: [Number], default: [] }, // 0=domingo ... 6=sábado
    startTime: { type: String, default: '' },    // "HH:MM"
    endTime: { type: String, default: '' },       // "HH:MM"

    // Monto de la comisión (valor fijo en dinero por servicio realizado).
    amount: { type: Number, required: true, min: 0 },

    // Cuenta contable a la que se asigna el gasto de comisión.
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommissionRule', commissionRuleSchema);
