const mongoose = require('mongoose');

/**
 * ENVÍO MASIVO A LAS CITAS DE LA AGENDA (recordatorios).
 *
 * Es el hermano de `ContactImport`, pero la audiencia no sale de un Excel: sale
 * de las citas que ya están agendadas en el sistema. Antes había que exportar la
 * agenda a Excel, importarla como contactos y lanzar el flujo desde ahí; el
 * archivo solo servía de puente y traía sus propios errores (la hora escrita a
 * mano, el teléfono mal copiado, el paciente duplicado).
 *
 * Lo que cambia frente a la importación:
 *  - se inscribe al PACIENTE (no al contacto del CRM) y la inscripción lleva
 *    `context.appointmentId`, así que {{fecha}}, {{hora}}, {{servicio}},
 *    {{doctor}} y {{sede}} salen de la CITA REAL (ver messaging.js) sin mapear
 *    ninguna columna;
 *  - por lo mismo, si la cita se reagenda o se cancela después de encolar el
 *    envío, el motor lo sabe (syncEnrollmentsForAppointment /
 *    cancelWaitingEnrollmentsForAppointment trabajan por `context.appointmentId`).
 *
 * Lo que NO cambia, porque ya estaba resuelto y costó sangre: goteo, hora de
 * arranque, número de salida, cancelar lo pendiente del envío anterior y el
 * informe de a quién NO se le mandó nada y por qué.
 *
 * `clinic` es la clínica ANCLA del CRM (donde viven workflows y conversaciones),
 * NO la sucursal de las citas: una misma tanda puede llevar citas de varias sedes
 * y cada inscripción guarda la suya en `context.eventClinicId`.
 */
const blastFiltersSchema = new mongoose.Schema(
  {
    startDate: { type: String, trim: true, default: '' }, // 'YYYY-MM-DD'
    endDate: { type: String, trim: true, default: '' },
    clinics: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' }], // vacío = todas las visibles
    statuses: { type: [String], default: [] }, // vacío = pendiente + confirmada
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    serviceItem: { type: mongoose.Schema.Types.ObjectId, ref: 'AppointmentServiceItem', default: null },
    // '' = todas · 'true' = solo primera visita · 'false' = solo recurrentes
    isFirstVisit: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const appointmentBlastSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    // Etiqueta legible en el historial ("Citas del 8 sep — 34 citas").
    name: { type: String, trim: true, default: '' },
    filters: { type: blastFiltersSchema, default: () => ({}) },
    // Las citas EXACTAS que se van a trabajar, congeladas al confirmar. Se guardan
    // en vez de reejecutar el filtro al procesar porque lo que el usuario aprobó
    // en la pantalla de confirmación es esta lista y no otra: entre que confirma y
    // el job arranca se pueden agendar más citas para ese día, y esas no las vio.
    appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],

    // Automatizaciones (con disparador 'appointment_bulk') que trabajarán estas citas.
    workflows: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Workflow' }],
    // GOTEO: segundos entre el arranque de una cita y la siguiente. Sin esto, 300
    // recordatorios salen en la misma ráfaga: es el patrón por el que WhatsApp
    // cierra una sesión QR y por el que cae la calidad de un número de Cloud API.
    dripSeconds: { type: Number, default: 20, min: 1, max: 3600 },
    // now → de inmediato · at → a la hora `sendAt` · flow → la hora del propio flujo
    sendMode: { type: String, enum: ['now', 'at', 'flow'], default: 'now' },
    sendAt: { type: String, trim: true, default: '' }, // "HH:MM" cuando sendMode='at'
    // Vacío = automático (cada paciente por el número con el que él escribió).
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },
    // Cancelar lo que quedó pendiente de envíos anteriores de estos mismos flujos.
    cancelPending: { type: Boolean, default: true },

    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed'],
      default: 'pending',
      index: true,
    },

    // Contadores. Los "skipped" están separados a propósito: "se inscribieron 20
    // de 34" sin decir qué pasó con las otras 14 es exactamente la pantalla que
    // hace pensar que el sistema falló.
    total: { type: Number, default: 0 },        // citas elegidas
    enrolled: { type: Number, default: 0 },     // inscripciones creadas
    skippedDuplicate: { type: Number, default: 0 }, // ya tenían este envío encolado
    skippedNoPhone: { type: Number, default: 0 },   // paciente sin teléfono
    skippedOptOut: { type: Number, default: 0 },    // paciente dado de baja
    skippedNoPatient: { type: Number, default: 0 }, // cita sin ficha de paciente
    cancelledPending: { type: Number, default: 0 }, // envíos anteriores anulados
    warning: { type: String, trim: true, default: '' },
    errorMessage: { type: String, trim: true, default: '' },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

appointmentBlastSchema.index({ clinic: 1, createdAt: -1 });

module.exports = mongoose.model('AppointmentBlast', appointmentBlastSchema);
