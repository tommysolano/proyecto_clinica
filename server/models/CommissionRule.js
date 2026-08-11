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

/** Eventos que pueden devengar una comisión (ver el comentario de `trigger`). */
const TRIGGERS = [
  'appointment_performed',
  'appointment_created',
  'sale',
  'recommendation',
  'referral',
  'admin_service',
  'call_center_commission',
];

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

    // A quién aplica: a personas concretas o a un rol completo.
    targetType: { type: String, enum: ['user', 'role'], required: true },
    /**
     * Personas a las que aplica la regla (targetType='user'). Una misma condición suele
     * valer para VARIOS empleados (p. ej. "las tres enfermeras del turno de la tarde") y
     * antes había que duplicar la regla una vez por persona.
     * `user` (singular) se conserva como la primera persona para las reglas antiguas y
     * para los listados; `users` manda cuando tiene elementos. Ver `ruleUsers()`.
     */
    users: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
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
      enum: TRIGGERS,
      default: 'appointment_performed',
    },

    /**
     * CONDICIONES (eventos) que devengan la regla. Una misma regla puede pagar por más de
     * un motivo — p. ej. "gana igual si atiende la cita y si recomienda el producto" —, y
     * antes eso obligaba a crear una regla por evento.
     * `trigger` (singular) se conserva como la primera condición para las reglas antiguas;
     * `triggers` manda cuando tiene elementos. Ver `ruleTriggers()`.
     */
    triggers: { type: [{ type: String, enum: TRIGGERS }], default: [] },

    // Servicio específico (producto). Si es null, aplica a cualquier servicio.
    // Se ignora si serviceAmounts tiene elementos (regla multi-servicio).
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    /**
     * Varios productos/servicios con el MISMO monto (lista blanca): la regla aplica solo
     * a estos. Es el punto medio entre "cualquier servicio" (`service` vacío) y
     * `serviceAmounts` (un monto distinto por servicio, que sigue mandando si existe).
     */
    services: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], default: [] },

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

/**
 * LECTORES ÚNICOS de los campos que admiten varios valores. La regla puede venir de la
 * forma vieja (singular) o de la nueva (plural); todo el que consulte una regla debe
 * pasar por aquí para que no haya dos interpretaciones distintas del mismo dato.
 */
commissionRuleSchema.statics.ruleTriggers = (rule) =>
  (rule?.triggers?.length ? rule.triggers : [rule?.trigger || 'appointment_performed']).map(String);

commissionRuleSchema.statics.ruleUsers = (rule) =>
  (rule?.users?.length ? rule.users : [rule?.user].filter(Boolean)).map((u) => String(u?._id || u));

commissionRuleSchema.statics.ruleServices = (rule) =>
  (rule?.services?.length ? rule.services : [rule?.service].filter(Boolean)).map((s) => String(s?._id || s));

commissionRuleSchema.statics.TRIGGERS = TRIGGERS;

module.exports = mongoose.model('CommissionRule', commissionRuleSchema);
