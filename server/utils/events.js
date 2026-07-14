const { EventEmitter } = require('events');

/**
 * Bus de eventos de dominio (in-process). Los controladores emiten hechos del
 * negocio (cita creada, cita asistida, no-show, tratamiento abandonado,
 * cumpleaños) y los suscriptores reaccionan — hoy el motor de workflows.
 *
 * Desacoplado a propósito: emitir un evento NUNCA debe romper el flujo que lo
 * dispara, por eso los handlers se ejecutan en try/catch y de forma diferida.
 *
 * Tipos de evento (constantes en DOMAIN_EVENTS):
 *  - appointment.created / appointment.attended / appointment.no_show
 *  - treatment.abandoned
 *  - patient.birthday
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

const DOMAIN_EVENTS = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_ATTENDED: 'appointment.attended',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_CONFIRMED: 'appointment.confirmed',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  TREATMENT_ABANDONED: 'treatment.abandoned',
  PATIENT_BIRTHDAY: 'patient.birthday',
  PATIENT_CREATED: 'patient.created',
  SALE_CREATED: 'sale.created',
  QUOTATION_SENT: 'quotation.sent',
  TAG_ADDED: 'patient.tag_added',
  PAYMENT_RECEIVED: 'payment.received',
};

/**
 * Emite un evento de dominio. `payload` siempre lleva clinicId.
 * No lanza: cualquier error de los handlers se aísla.
 */
function emitDomainEvent(type, payload = {}) {
  if (!type) return;
  // setImmediate: no bloquea ni hace fallar al emisor (la cita ya se guardó).
  setImmediate(() => {
    try {
      bus.emit('domain', { type, payload, at: new Date() });
      bus.emit(type, payload);
    } catch (err) {
      console.error('[events] handler error', type, err.message);
    }
  });
}

function onDomainEvent(type, handler) {
  bus.on(type, (payload) => {
    Promise.resolve(handler(payload)).catch((err) =>
      console.error('[events] async handler error', type, err.message)
    );
  });
}

module.exports = { bus, DOMAIN_EVENTS, emitDomainEvent, onDomainEvent };
