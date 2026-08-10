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
// Campos y operadores de una condición (compartidos por el paso legacy, las
// condiciones sueltas y las ramas). 'clinic' = sucursal del evento que inscribió
// el flujo; 'chatTag' = etiquetas del chat; 'opportunityTag'/'opportunityValue' =
// etiquetas y valor esperado de la oportunidad principal del chat.
const CONDITION_FIELDS = [
  'tag',
  'chatTag',
  'stage',
  'opportunityName',
  'opportunityTag',
  'opportunityValue',
  'source',
  'hasPatient',
  'lastReply',
  'clinic',
  '',
];
// 'in'/'nin' = "es alguno de" / "no es ninguno de" (usan `values[]`);
// 'gt'/'lt' = mayor/menor (solo campos numéricos).
const CONDITION_OPS = ['eq', 'neq', 'contains', 'exists', 'in', 'nin', 'gt', 'lt', ''];

// Una condición suelta. Varias forman un grupo (rama) que se combina con Y u O.
const conditionSchema = new mongoose.Schema(
  {
    id: { type: String, default: '' }, // estable para la UI (React keys)
    field: { type: String, enum: CONDITION_FIELDS, default: '' },
    op: { type: String, enum: CONDITION_OPS, default: 'eq' },
    value: { type: String, default: '' },
    values: { type: [String], default: [] }, // para 'in' / 'nin'
  },
  { _id: false }
);

// Rama de un paso `condition`: su propio conjunto de condiciones y su salida
// (sourceHandle = branch.id). Se evalúan EN ORDEN (if / else-if); si ninguna se
// cumple, el flujo sale por el handle 'no' ("si no").
const conditionBranchSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, trim: true, default: '' },
    match: { type: String, enum: ['all', 'any', ''], default: 'all' },
    conditions: { type: [conditionSchema], default: [] },
  },
  { _id: false }
);

// Botones de un nodo `send_message`. El `id` es estable y se usa también como
// sourceHandle de la arista que representa la acción posterior al clic.
const workflowButtonSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    type: { type: String, enum: ['quick_reply', 'url', 'phone'], default: 'quick_reply' },
    text: { type: String, trim: true, default: '' },
    // URL para `url`; número (con prefijo internacional) para `phone`.
    url: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

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
        'move_stage', // legacy: solo cambia la etapa. Lo sustituye create_opportunity.
        'create_opportunity',
        'set_appointment_status',
        'assign_agent',
        'create_task',
        'webhook',
        'ai_reply',
        'request_review',
        'goal',
        'send_media', // solo imagen/video, sin texto
        'window', // retiene el flujo hasta que la franja horaria esté abierta
        // Marketing (Meta / Facebook):
        'meta_capi', // envía un evento de conversión a Meta (Conversions API)
        'fb_audience_add', // añade el contacto a un Público Personalizado
        'fb_audience_remove', // quita el contacto de un Público Personalizado
      ],
      required: true,
    },
    // send_message
    body: { type: String, default: '' },
    // send_message: adjunto opcional (imagen/video/audio) que viaja con el texto.
    // url pública autoalojada (/api/public/media/:id) o externa.
    mediaUrl: { type: String, trim: true, default: '' },
    mediaType: { type: String, enum: ['', 'image', 'video', 'document', 'audio'], default: '' },
    mediaName: { type: String, trim: true, default: '' },
    // send_message: hasta tres botones. En workflows lineales antiguos se
    // conservan y se envían; las ramas por clic solo aplican al modelo de grafo.
    buttons: { type: [workflowButtonSchema], default: [] },
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
    // window ("Ventana horaria"): días (0=domingo … 6=sábado) y franja HH:MM de
    // SILENCIO — las horas en las que el flujo NO molesta. Dentro de la franja el
    // contacto espera a que TERMINE (nunca se descarta); fuera, el flujo sigue.
    // Ojo: hasta ago-2026 el rango significaba lo contrario. Ver utils/sendWindow.js.
    windowDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    windowFrom: { type: String, trim: true, default: '09:00' },
    windowTo: { type: String, trim: true, default: '18:00' },
    // set_appointment_status: actualiza la cita del contexto
    appointmentStatus: { type: String, enum: ['confirmada', 'cancelada', ''], default: '' },
    // condition / goal — condición ÚNICA (legacy: sigue funcionando tal cual).
    field: { type: String, enum: CONDITION_FIELDS, default: '' },
    op: { type: String, enum: CONDITION_OPS, default: 'eq' },
    value: { type: String, default: '' },
    values: { type: [String], default: [] },
    // condition / goal — VARIAS condiciones combinadas: 'all' = todas (Y,
    // condiciones conectadas), 'any' = cualquiera (O, independientes).
    match: { type: String, enum: ['all', 'any', ''], default: 'all' },
    conditions: { type: [conditionSchema], default: [] },
    // condition — varias ramas con su propia salida (if / else-if / si no).
    branches: { type: [conditionBranchSchema], default: [] },
    onFailGoTo: { type: Number, default: null }, // índice de paso; null = terminar
    // add_tag / remove_tag
    tag: { type: String, trim: true, default: '' },
    // move_stage / create_opportunity: etapa del embudo.
    stage: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido', ''],
      default: '',
    },
    // create_opportunity: la oportunidad COMPLETA (nombre, servicios del
    // inventario, valor automático o manual, etiquetas y notas).
    opportunityName: { type: String, trim: true, default: '' }, // admite variables {{nombre}}
    opportunityProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    opportunityValueMode: { type: String, enum: ['auto', 'manual', ''], default: 'auto' },
    opportunityValue: { type: Number, default: 0, min: 0 },
    opportunityTags: { type: [String], default: [] },
    opportunityNotes: { type: String, default: '' },
    // Qué hacer si el chat YA tiene oportunidad: 'update' actualiza la principal,
    // 'new' añade otra (dos intereses distintos en el mismo chat).
    ifExists: { type: String, enum: ['update', 'new', ''], default: 'update' },
    // meta_capi: evento estándar de conversión de Meta + valor opcional (Purchase).
    metaEventName: { type: String, trim: true, default: 'Lead' },
    metaValue: { type: Number, default: 0 },
    metaCurrency: { type: String, trim: true, default: 'USD' },
    // fb_audience_add / fb_audience_remove: ID del Público Personalizado destino.
    audienceId: { type: String, trim: true, default: '' },
    audienceName: { type: String, trim: true, default: '' }, // solo etiqueta para la UI
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
  // La oportunidad del chat entró a una etapa del embudo (nuevo/contactado/…).
  // Filtrable por etapa (trigger.stageFilter). Se dispara al mover la oportunidad
  // desde el chat/Kanban, no desde un paso move_stage (para evitar cascadas).
  'opportunity_stage',
  // Mensaje entrante desde un anuncio click-to-WhatsApp de Meta (el webhook trae
  // `referral.source_id` = ID del anuncio). Permite un workflow por anuncio.
  'ctwa_ad',
  // Contactos del CRM (no pacientes): el asistente de importación inscribe a los
  // contactos del Excel en los workflows que tengan este disparador. No se emite
  // como evento de dominio: inscribe directamente el runner de importación.
  'contact_import',
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
    // Filtro opcional por SUCURSAL: solo dispara si el evento (cita, venta, etc.)
    // ocurrió en esta sucursal. Vacío = todas. Permite un flujo por sede (p.ej.
    // un video distinto por sucursal al agendar la cita).
    clinicFilter: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    // Audiencia (cuando aplica): all | new (primera visita) | existing.
    audience: { type: String, enum: ['all', 'new', 'existing'], default: 'all' },
    // Trigger 'keyword': palabras clave + tipo de coincidencia.
    keywords: { type: [String], default: [] },
    matchType: { type: String, enum: ['contains', 'exact', 'starts', ''], default: 'contains' },
    // Trigger 'tag_added': solo dispara si se añade esta etiqueta (vacío = cualquiera).
    tagFilter: { type: String, trim: true, default: '' },
    // Trigger 'opportunity_stage': solo dispara al entrar a esta etapa del embudo
    // (nuevo/contactado/interesado/agendado/ganado/perdido). Vacío = cualquier etapa.
    stageFilter: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido', ''],
      default: '',
    },
    // Trigger 'ctwa_ad': ID(s) del anuncio de Meta (referral.source_id), separados
    // por coma. Vacío = cualquier anuncio. Marketing API resuelve el ID estable
    // del Ads Manager y sus aliases de publicación/creativo (utils/metaAds.js).
    adFilter: { type: String, trim: true, default: '' },
    // Trigger 'ctwa_ad': texto(s) que debe contener el TÍTULO del anuncio
    // (referral.headline), separados por coma. Respaldo adicional por texto.
    // Si adFilter y adTextFilter están vacíos → cualquier anuncio. Si alguno tiene
    // valor, el mensaje coincide si casa por ID O por texto.
    adTextFilter: { type: String, trim: true, default: '' },
    // Trigger 'contact_import': "Hora de envío" por defecto del flujo ("HH:MM"). Al
    // hacer un envío masivo, el 1er mensaje sale a esta hora salvo que el usuario
    // elija otra. Vacío = de inmediato. (En flujos de grafo vive en node.data —Mixed—,
    // pero también se declara aquí para el trigger/triggers legacy.)
    sendHour: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

/**
 * HORARIO DE SILENCIO del workflow: días y franja en los que la automatización
 * NO debe mandar mensajes. Un contacto que llega dentro del silencio no se
 * pierde: espera a que la franja termine.
 *  - mode 'any' (defecto) → sin silencio, el flujo trabaja 24/7 como siempre.
 *  - mode 'specific'      → se calla dentro de `days` + `from`–`to` (hora de Ecuador).
 * `days`: 0=domingo … 6=sábado. Si `from` > `to` la franja cruza la medianoche.
 *
 * OJO: hasta ago-2026 el rango era el horario PERMITIDO. Se invirtió porque nadie
 * lo entendía así — ver el encabezado de utils/sendWindow.js.
 */
const sendWindowSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ['any', 'specific'], default: 'any' },
    days: { type: [Number], default: [1, 2, 3, 4, 5] },
    from: { type: String, trim: true, default: '09:00' },
    to: { type: String, trim: true, default: '18:00' },
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
    // Ventana horaria de ENVÍO para todo el workflow (los pasos de mensajería
    // esperan a la próxima apertura). El nodo 'window' hace lo mismo pero en un
    // punto concreto del diagrama.
    sendWindow: { type: sendWindowSchema, default: () => ({}) },
    stats: {
      enrolled: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

workflowSchema.statics.TRIGGER_TYPES = TRIGGER_TYPES;
workflowSchema.statics.CONDITION_FIELDS = CONDITION_FIELDS;
workflowSchema.statics.CONDITION_OPS = CONDITION_OPS;

module.exports = mongoose.model('Workflow', workflowSchema);
