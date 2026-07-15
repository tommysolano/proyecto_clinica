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
        'send_email',
        'wait',
        'wait_until',
        'wait_reply',
        'condition',
        'add_tag',
        'remove_tag',
        'move_stage',
        'set_appointment_status',
        'assign_agent',
        'create_task',
        'webhook',
        'ai_reply',
        'request_review',
        'goal',
      ],
      required: true,
    },
    // send_message
    body: { type: String, default: '' },
    // send_template
    templateName: { type: String, trim: true, default: '' },
    templateLanguage: { type: String, trim: true, default: 'es' },
    // send_email
    emailSubject: { type: String, trim: true, default: '' },
    // assign_agent: roundrobin (menos chats) | user (usuario fijo)
    assignMode: { type: String, enum: ['roundrobin', 'user', ''], default: 'roundrobin' },
    assignUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // create_task
    taskTitle: { type: String, trim: true, default: '' },
    taskDueOffsetMinutes: { type: Number, default: 1440 }, // por defecto vence en 24h
    // webhook
    webhookUrl: { type: String, trim: true, default: '' },
    webhookMethod: { type: String, enum: ['POST', 'GET', ''], default: 'POST' },
    // wait
    waitMinutes: { type: Number, default: 0, min: 0 },
    // wait_until: fecha base del contexto + offset (offset negativo = antes)
    waitEvent: { type: String, enum: ['appointment_date', ''], default: '' },
    offsetMinutes: { type: Number, default: 0 },
    // wait_until modo "hora fija": N días antes de la cita a las HH:MM (p.ej.
    // recordatorio a las 18:00 del día anterior, sin importar la hora de la cita).
    waitMode: { type: String, enum: ['', 'offset', 'clock'], default: '' },
    daysBefore: { type: Number, default: 1, min: 0 },
    atTime: { type: String, trim: true, default: '' },
    // wait_reply: pausa hasta que el paciente responda (o venza el timeout)
    timeoutMinutes: { type: Number, default: 720, min: 1 },
    // set_appointment_status: actualiza la cita del contexto
    appointmentStatus: { type: String, enum: ['confirmada', 'cancelada', ''], default: '' },
    // condition / goal
    field: { type: String, enum: ['tag', 'stage', 'source', 'hasPatient', 'lastReply', ''], default: '' },
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
  'appointment_cancelled',
  'appointment_confirmed',
  'appointment_rescheduled',
  'treatment_abandoned',
  'patient_birthday',
  'patient_created',
  'sale_created',
  'payment_received',
  'quotation_sent',
  // Disparadores de chat (reemplazan a MessageFlow):
  'inbound_message',
  'keyword',
  'new_conversation',
  'tag_added',
  // Mensaje entrante desde un anuncio click-to-WhatsApp de Meta (el webhook trae
  // `referral.source_id` = ID del anuncio). Permite un workflow por anuncio.
  'ctwa_ad',
];

// Nodo del grafo visual (editor estilo GoHighLevel). `type` es el tipo de paso
// (mismos tipos que workflowStepSchema) o 'trigger' para el nodo inicial.
// `data` lleva la configuración del paso (body, templateName, field/op/value, etc.).
const workflowNodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

// Arista dirigida. `sourceHandle` distingue las ramas de una condición:
// 'yes' | 'no' (para condition/goal) o 'default' para pasos lineales.
const workflowEdgeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    sourceHandle: { type: String, default: 'default' },
  },
  { _id: false }
);

// Disparador (sub-esquema reutilizable). Un workflow puede tener VARIOS
// disparadores (lógica OR, estilo GoHighLevel): cualquiera de ellos lo inicia.
const triggerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TRIGGER_TYPES, required: true },
    // Filtro opcional por servicio (para eventos de cita): solo dispara si la
    // cita incluye este producto.
    serviceFilter: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    // Audiencia (cuando aplica): all | new (primera visita) | existing.
    audience: { type: String, enum: ['all', 'new', 'existing'], default: 'all' },
    // Trigger 'keyword': palabras clave + tipo de coincidencia.
    keywords: { type: [String], default: [] },
    matchType: { type: String, enum: ['contains', 'exact', 'starts', ''], default: 'contains' },
    // Trigger 'tag_added': solo dispara si se añade esta etiqueta (vacío = cualquiera).
    tagFilter: { type: String, trim: true, default: '' },
    // Trigger 'ctwa_ad': ID(s) del anuncio de Meta (referral.source_id), separados
    // por coma. Vacío = cualquier anuncio.
    adFilter: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const workflowSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    folder: { type: String, trim: true, default: 'General' },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: false },
    // Disparador principal (legacy / compatibilidad). Se mantiene sincronizado con
    // triggers[0]. El motor consulta ambos para no romper workflows antiguos.
    trigger: { type: triggerSchema, default: undefined },
    // Lista de disparadores (lógica OR). Fuente canónica para los workflows nuevos.
    triggers: { type: [triggerSchema], default: [] },
    // Modelo lineal (legacy / compatibilidad). Los workflows nuevos usan nodes/edges.
    steps: { type: [workflowStepSchema], default: [] },
    // Grafo visual con ramificaciones (editor react-flow).
    nodes: { type: [workflowNodeSchema], default: [] },
    edges: { type: [workflowEdgeSchema], default: [] },
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
