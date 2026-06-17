const mongoose = require('mongoose');

/**
 * Motor de workflows orientado a EVENTOS del sistema (citas, tratamientos,
 * cumpleaños). Complementa a MessageFlow (que sigue atendiendo los flujos de
 * chat por palabra clave). La unificación de ambos motores es trabajo posterior.
 *
 * Un paso (WorkflowStep) puede:
 *  - send_message   : texto libre (solo dentro de ventana 24h en WhatsApp)
 *  - send_template  : plantilla aprobada (fuera de ventana)
 *  - wait           : espera N minutos
 *  - wait_until     : espera hasta una fecha del contexto + offset (p.ej. 24h antes de la cita)
 *  - condition      : evalúa un predicado; si falla salta a onFailGoTo (o termina)
 *  - add_tag / remove_tag : etiqueta al paciente
 *  - move_stage     : mueve la oportunidad de la conversación
 *  - goal           : termina la inscripción si se cumple el predicado
 */
const workflowStepSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'send_message',
        'send_template',
        'wait',
        'wait_until',
        'condition',
        'add_tag',
        'remove_tag',
        'move_stage',
        'goal',
      ],
      required: true,
    },
    // send_message
    body: { type: String, default: '' },
    // send_template
    templateName: { type: String, trim: true, default: '' },
    templateLanguage: { type: String, trim: true, default: 'es' },
    // wait
    waitMinutes: { type: Number, default: 0, min: 0 },
    // wait_until: fecha base del contexto + offset (offset negativo = antes)
    waitEvent: { type: String, enum: ['appointment_date', ''], default: '' },
    offsetMinutes: { type: Number, default: 0 },
    // condition / goal
    field: { type: String, enum: ['tag', 'stage', 'source', 'hasPatient', ''], default: '' },
    op: { type: String, enum: ['eq', 'neq', 'contains', 'exists', ''], default: 'eq' },
    value: { type: String, default: '' },
    onFailGoTo: { type: Number, default: null }, // índice de paso; null = terminar
    // add_tag / remove_tag
    tag: { type: String, trim: true, default: '' },
    // move_stage
    stage: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido', ''],
      default: '',
    },
  },
  { _id: true }
);

const TRIGGER_TYPES = [
  'appointment_created',
  'appointment_attended',
  'appointment_no_show',
  'treatment_abandoned',
  'patient_birthday',
];

const workflowSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    folder: { type: String, trim: true, default: 'General' },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: false },
    trigger: {
      type: { type: String, enum: TRIGGER_TYPES, required: true },
      // Filtro opcional por servicio (para eventos de cita): solo dispara si la
      // cita incluye este producto.
      serviceFilter: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      // Audiencia (cuando aplica): all | new (primera visita) | existing.
      audience: { type: String, enum: ['all', 'new', 'existing'], default: 'all' },
    },
    steps: { type: [workflowStepSchema], default: [] },
    stats: {
      enrolled: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

workflowSchema.statics.TRIGGER_TYPES = TRIGGER_TYPES;

module.exports = mongoose.model('Workflow', workflowSchema);
