const mongoose = require('mongoose');

/**
 * Monto por servicio dentro de una regla multi-servicio. Permite que UNA misma
 * regla pague distinto por cada servicio (caso típico del administrador: gana X
 * por el servicio A, Y por el servicio B, etc.). Cada entrada decide si su valor
 * es fijo ($) o porcentaje sobre el precio que paga el paciente.
 */
const serviceAmountSchema = new mongoose.Schema(
  {
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    amountType: { type: String, enum: ['fixed', 'percent'], default: 'fixed' },
    amount: { type: Number, default: 0, min: 0 },      // valor fijo en $
    percent: { type: Number, default: 0, min: 0, max: 100 }, // % sobre el precio pagado
  },
  { _id: false }
);

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

    // Evento que devenga la comisión (cambia según el rol):
    //   appointment_performed   -> el usuario ATIENDE una cita que pasa a completada
    //                              (doctor / óptica / enfermero)
    //   appointment_created     -> una cita AGENDADA por el usuario es asistida/completada
    //                              (call center) — se cuenta una vez por cita
    //   sale                    -> el usuario REGISTRA una venta (cajero)
    //   recommendation          -> el usuario es "recomendado por" en una venta
    //   referral                -> el usuario (doctor) DERIVA un paciente y la cita
    //                              derivada se completa
    //   admin_service           -> por cada servicio atendido en la clínica (admin);
    //                              típicamente con montos por servicio (serviceAmounts)
    //   call_center_commission  -> el usuario (marketing) gana cuando el call center al
    //                              que está ligado (linkedCallCenter) gana comisión
    trigger: {
      type: String,
      enum: [
        'appointment_performed',
        'appointment_created',
        'sale',
        'recommendation',
        'referral',
        'admin_service',
        'call_center_commission',
      ],
      default: 'appointment_performed',
    },

    // Servicio específico (producto). Si es null, aplica a cualquier servicio.
    // Se ignora si serviceAmounts tiene elementos (regla multi-servicio).
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // Montos por servicio (regla multi-servicio). Si tiene elementos, la regla
    // aplica SOLO a estos servicios y usa el monto/porcentaje de cada uno,
    // ignorando `service`, `amount`, `amountType` y `percent` globales.
    serviceAmounts: { type: [serviceAmountSchema], default: [] },

    // Agente de call center al que está ligado un usuario marketing. Sólo aplica
    // al trigger 'call_center_commission': el marketing gana en función de la
    // comisión que devengue ESTE agente.
    linkedCallCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // A qué pacientes aplica: solo nuevos o todos.
    patientScope: { type: String, enum: ['new', 'all'], default: 'all' },

    // Horario opcional. Si scheduleEnabled=false, aplica a cualquier hora.
    scheduleEnabled: { type: Boolean, default: false },
    daysOfWeek: { type: [Number], default: [] }, // 0=domingo ... 6=sábado
    startTime: { type: String, default: '' },    // "HH:MM"
    endTime: { type: String, default: '' },       // "HH:MM"

    // Cómo se expresa el valor de la comisión:
    //   fixed   -> monto fijo en $ (campo `amount`)
    //   percent -> porcentaje sobre el precio que paga el paciente (campo `percent`)
    amountType: { type: String, enum: ['fixed', 'percent'], default: 'fixed' },

    // Monto de la comisión (valor fijo en dinero por servicio realizado).
    // Opcional: si es 0 y amountType='fixed', la comisión se cuenta sin valor $.
    amount: { type: Number, default: 0, min: 0 },

    // Porcentaje de comisión (0–100) sobre el precio de venta. Aplica cuando
    // amountType='percent'.
    percent: { type: Number, default: 0, min: 0, max: 100 },

    // Cuenta contable a la que se asigna el gasto de comisión.
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CommissionRule', commissionRuleSchema);
