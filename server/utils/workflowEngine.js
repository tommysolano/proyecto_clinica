const mongoose = require('mongoose');
const crypto = require('crypto');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const AgentTask = require('../models/AgentTask');
const Product = require('../models/Product');
const User = require('../models/User');
const ReviewRequest = require('../models/ReviewRequest');
const messaging = require('./messaging');
// Etapas del embudo: fuente ÚNICA de lectura/escritura (ver utils/opportunities.js).
const opportunities = require('./opportunities');
const { emitToClinic, emitToUser, emitToCallCenter, emitChatAssignment } = require('../realtime');
const { isWorkingAt } = require('./agentSchedule');
const { applyAgentRestrictionState } = require('./workflowChatRestriction');
const { DOMAIN_EVENTS, onDomainEvent } = require('./events');
const {
  isWindowActive, isQuietTime, nextAllowedTime, nextAllowedTimeAll, isAlwaysQuiet, describeWindow,
} = require('./sendWindow');

const MAX_STEP_TRANSITIONS = 100; // guarda contra bucles por onFailGoTo mal formado
const MAX_LOG_ENTRIES = 60; // tope del registro de ejecución por inscripción

// Pasos de EFECTO (no de control de flujo) del runner lineal: tras ejecutarlos
// se persiste stepIndex para que una recuperación (deploy/caída a mitad del
// flujo) continúe desde ahí y no repita envíos. El runner de grafo ya lo hace.
const LINEAR_ACTION_TYPES = new Set([
  'send_message', 'send_media', 'send_template', 'send_email', 'assign_agent', 'create_task',
  'webhook', 'request_review', 'ai_reply', 'set_appointment_status',
  'add_tag', 'remove_tag', 'move_stage',
  'meta_capi', 'fb_audience_add', 'fb_audience_remove',
]);

// Pasos que MANDAN algo al contacto. Son los únicos que respetan las ventanas de
// silencio: etiquetar o crear una tarea a las 3 a.m. no molesta a nadie, mandar un
// WhatsApp sí.
const SENDING_TYPES = new Set([
  'send_message', 'send_media', 'send_template', 'send_email', 'request_review', 'ai_reply',
]);

/**
 * Ventana horaria de un nodo 'window' del diagrama (su configuración vive en
 * node.data). Siempre en modo 'specific': el nodo existe justamente para callar
 * el flujo en esa franja.
 */
function windowOfNode(data = {}) {
  return { mode: 'specific', days: data.windowDays, from: data.windowFrom, to: data.windowTo };
}

/** Clave para no guardar dos veces la misma ventana en el contexto. */
const windowKey = (w) => `${(w.days || []).join(',')}|${w.from}|${w.to}`;

/**
 * Apunta en el contexto de la inscripción la ventana de un nodo "Ventana horaria"
 * por el que el contacto ACABA de pasar, para que siga callando los envíos que
 * vengan después (ver `sendWindowHold`). Devuelve true si el contexto cambió.
 *
 * CASO REAL (ago-2026): un flujo con "Ventana horaria 23:02–06:20" seguida de
 * "Esperar 5 horas" y "Enviar mensaje" mandaba el WhatsApp a las 03:08. El nodo
 * miraba el reloj solo al pasar por él (a las 22:08 no había silencio) y la espera
 * posterior aterrizaba dentro de la franja. La ficha del nodo promete justo lo
 * contrario: "todo lo que venga después de este paso se queda esperando aquí".
 */
function rememberQuietWindow(ctx, win) {
  if (!ctx || !isWindowActive(win) || isAlwaysQuiet(win)) return false;
  const list = Array.isArray(ctx.quietWindows) ? ctx.quietWindows : [];
  if (list.some((w) => windowKey(w) === windowKey(win))) return false;
  ctx.quietWindows = [...list, { mode: 'specific', days: win.days, from: win.from, to: win.to }];
  return true;
}

/**
 * Ventanas de los nodos "Ventana horaria" que están ANTES de `nodeId` en el
 * diagrama (recorriendo las aristas hacia atrás). Es el mismo silencio que
 * `rememberQuietWindow` apunta al pasar, pero leído del propio dibujo: así también
 * quedan cubiertos los contactos que YA estaban a mitad de flujo cuando se corrigió
 * esto, y los que llegan a un punto donde confluyen varias ramas.
 */
function windowsUpstreamOf(workflow, nodeId) {
  if (!nodeId || !(workflow?.nodes || []).length) return [];
  const edges = workflow.edges || [];
  const vistos = new Set([nodeId]);
  const pendientes = [nodeId];
  const wins = [];
  while (pendientes.length) {
    const actual = pendientes.pop();
    for (const e of edges) {
      if (e.target !== actual || vistos.has(e.source)) continue;
      vistos.add(e.source);
      pendientes.push(e.source);
      const node = getNode(workflow, e.source);
      if (node?.type === 'window') wins.push(windowOfNode(node.data || {}));
    }
  }
  return wins;
}

/** Ventanas que callan los envíos de esta inscripción, ya activas y cumplibles. */
function quietWindowsFor(workflow, ctx, nodeId = null) {
  const wins = [
    workflow?.sendWindow,
    ...(Array.isArray(ctx?.quietWindows) ? ctx.quietWindows : []),
    ...windowsUpstreamOf(workflow, nodeId),
  ]
    .filter((w) => isWindowActive(w))
    .filter((w, i, all) => all.findIndex((x) => windowKey(x) === windowKey(w)) === i);
  const usables = wins.filter((w) => !isAlwaysQuiet(w));
  if (usables.length < wins.length) {
    // Silencio de 24 h los 7 días: no hay hueco al que esperar. Retener sería
    // dejar al contacto preso para siempre, así que se avisa y se deja pasar.
    console.warn(
      '[workflow] una ventana de "%s" calla las 24 h de los 7 días: se ignora (revisa su configuración)',
      workflow?.name || workflow?._id
    );
  }
  return usables;
}

/** Texto para el registro: qué ventana(s) están callando en este momento. */
function describeQuiet(wins, at = new Date()) {
  const callando = wins.filter((w) => isQuietTime(w, at));
  return (callando.length ? callando : wins).map(describeWindow).join(' y ');
}

/**
 * ¿Hay que RETENER este paso porque estamos en franja de silencio? Devuelve la
 * fecha en la que el silencio termina, o null si puede ejecutarse ya (sin ventana,
 * fuera del silencio, o paso que no envía nada).
 *
 * Cuenta la ventana del workflow (`workflow.sendWindow`, la del botón "Horario de
 * silencio") Y las de los nodos "Ventana horaria" que quedan por encima de este
 * paso: las que la inscripción trae apuntadas (ctx.quietWindows) y las que están
 * antes en el diagrama (windowsUpstreamOf).
 */
function sendWindowHold(workflow, type, at = new Date(), ctx = null, nodeId = null) {
  if (!SENDING_TYPES.has(type)) return null;
  const wins = quietWindowsFor(workflow, ctx, nodeId);
  if (!wins.length) return null;
  const libre = nextAllowedTimeAll(wins, at);
  if (!libre) return null;
  return libre.getTime() > at.getTime() ? libre : null;
}

// Motivos por los que messaging.send salta/falla un envío, en lenguaje del usuario.
// `provider_unavailable` e `invalid_recipient` los devuelve messaging.send para
// CUALQUIER canal (whatsapp/messenger/instagram/email): su texto se arma según el
// canal real del paso (ver sendFailureInfo), no queda fijo en "WhatsApp".
const CHANNEL_LABELS = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', email: 'email' };
// Canales donde el paso "Enviar plantilla" tiene sentido. Meta no tiene HSM fuera
// de WhatsApp, pero SÍ deja mandar el TEXTO de la plantilla como mensaje normal
// por Messenger/Instagram (igual que ya hacían los números QR de WhatsApp, que
// tampoco admiten HSM) — ver `messaging.send`/`sendToProvider`. TikTok no es de
// Meta y aún no tiene envío implementado: queda fuera.
const TEMPLATE_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram']);
const SEND_FAIL_REASONS = {
  out_of_window: 'WhatsApp: fuera de la ventana de 24h (el paciente no ha escrito recientemente). Usa el paso "Enviar plantilla" con una plantilla aprobada.',
  opt_out: 'El paciente pidió no recibir mensajes (opt-out).',
  no_whatsapp_consent: 'El paciente tiene desactivado el consentimiento de WhatsApp (ficha del paciente → Marketing).',
  no_email_consent: 'El paciente no aceptó recibir emails.',
  blocked: 'La conversación está bloqueada.',
  template_header_missing: 'La plantilla requiere una imagen/archivo de cabecera que no está guardado.',
  qr_not_connected: 'El número QR por el que saldría este mensaje está desconectado: reconéctalo en Configuración del Call Center.',
  qr_invalid_number: 'El teléfono del paciente no está en WhatsApp.',
  qr_send_failed: 'La sesión de WhatsApp Web se recargó en mitad del envío y el mensaje NO salió (se comprobó en el chat).',
  qr_send_unconfirmed: 'La sesión de WhatsApp Web se recargó en mitad del envío y no se pudo comprobar si salió.',
  qr_media_unconfirmed: 'WhatsApp no confirmó el envío del archivo (la sesión estaba inestable).',
  token_undecryptable: 'El token de WhatsApp no se pudo descifrar en el servidor que procesó el envío (falta o cambió SECRETS_KEY — p.ej. un servidor de desarrollo local conectado a la base de producción, que no tiene esa clave). Se reintenta: el servidor de producción (con la clave) lo enviará.',
};

/**
 * Añade una entrada al registro de ejecución de la inscripción (en memoria; se
 * persiste con el siguiente save). Si es un fallo, actualiza lastError.
 */
function pushLog(enrollment, entry) {
  const e = { at: new Date(), ok: true, ...entry };
  enrollment.log = [...(enrollment.log || []), e].slice(-MAX_LOG_ENTRIES);
  if (e.ok === false && e.info) enrollment.lastError = e.info;
}

/**
 * ¿Esta inscripción YA ejecutó algún paso? Su registro es la evidencia: se
 * escribe en cada paso (envíos, condiciones, esperas). Sirve para distinguir las
 * DOS cosas que significa `currentNodeId: null` — "aún no ha empezado" (recién
 * creada) y "la rama se acabó" (una salida sin conectar) — que es justo lo que
 * confundía el motor y le hacía reenviar el flujo desde el disparador.
 */
function hasRunSteps(enrollment) {
  return (enrollment.log || []).length > 0 || Number(enrollment.stepIndex || 0) > 0;
}

/**
 * Cierra una inscripción porque su rama no tiene continuación (un botón sin
 * conectar, una salida "otra respuesta / tiempo" sin conectar). Termina en 'done'
 * y deja escrito el porqué; NUNCA reinicia el flujo.
 */
async function finishDeadEnd(enrollment, workflowId, { nodeId = null, info }) {
  pushLog(enrollment, { nodeId, type: 'end', info });
  enrollment.currentNodeId = null;
  enrollment.waitingForReply = false;
  enrollment.status = 'done';
  await enrollment.save();
  if (workflowId) await Workflow.updateOne({ _id: workflowId }, { $inc: { 'stats.completed': 1 } });
}

// Fecha legible (hora Ecuador) para el registro de ejecución.
const fmtLogDate = (d) =>
  d.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Interpreta el resultado de messaging.send: null = éxito, string = motivo del
 * fallo. `channel` (whatsapp/messenger/instagram/email) arma el texto de los
 * motivos que aplican a cualquier canal (provider_unavailable, invalid_recipient)
 * para no decir "WhatsApp" cuando el paso en realidad falló por Messenger/Instagram.
 */
function sendFailureInfo(result, channel = 'whatsapp') {
  if (!result || result.ok) return null;
  const reason = result.reason || result.errorCode || 'error';
  const label = CHANNEL_LABELS[channel] || channel;
  if (reason === 'provider_unavailable') return `Canal no disponible: ${channel === 'whatsapp' ? 'no hay número de WhatsApp' : `${label} no está`} conectado/configurado.`;
  if (reason === 'invalid_recipient') return `El contacto no tiene un destino válido en ${label}, o el mensaje llegó vacío.`;
  return SEND_FAIL_REASONS[reason] || result.errorMessage || `No se pudo enviar (${reason}).`;
}

/**
 * Fallo de un envío: `{ info, code }` — el texto para el registro y el CÓDIGO del
 * proveedor, que es lo que decide si se reintenta (ver RETRYABLE_SEND_CODES). Antes
 * se decidía comparando el texto, y cualquier motivo nuevo (o un texto con el
 * número de origen pegado detrás) se quedaba sin reintento en silencio.
 */
function sendFail(result, channel = 'whatsapp') {
  const info = sendFailureInfo(result, channel);
  if (!info) return null;
  return { info, code: String(result?.reason || result?.errorCode || '') };
}

// Fallos TRANSITORIOS: se REINTENTA en vez de quemar el turno del contacto.
//  - qr_not_connected: el número QR caído (reconectar lo cura). Caso real: una
//    importación inscribió sus contactos mientras la sesión QR se re-asentaba tras
//    un deploy; todos quedaron "fallido" para siempre con el número ya en verde.
//  - token_undecryptable: el servidor que procesó el envío no pudo descifrar el
//    token (falta/otra SECRETS_KEY — típico de un `npm run dev` local conectado a la
//    base de prod). El servidor de producción (con la clave) SÍ puede: reintentar deja
//    que él lo envíe en vez de perder el mensaje. En prod nunca dispara (descifra bien).
//  - qr_send_failed / qr_send_unconfirmed / qr_media_unconfirmed: la pestaña de
//    WhatsApp Web se recargó a mitad del envío. Caso real (ago-2026): el flujo daba
//    el mensaje por fallido, SEGUÍA con el paso siguiente y ese mensaje se perdía
//    para siempre. No hay riesgo de duplicado: antes de reenviar, el gateway QR
//    comprueba en el propio chat si aquel mensaje llegó a salir.
// OJO: provider_unavailable ("no hay número configurado") NO va aquí — es ausencia de
// configuración, no un tropiezo: debe fallar claro y al instante.
const RETRYABLE_SEND_CODES = new Set([
  'qr_not_connected',
  'token_undecryptable',
  'qr_send_failed',
  'qr_send_unconfirmed',
  'qr_media_unconfirmed',
]);
const SEND_RETRY_MS = 5 * 60 * 1000; // reintento cada 5 min…
const SEND_RETRY_MAX = 36; // …hasta ~3 horas; después, fallo definitivo y el flujo sigue

/**
 * Si `fail` (`{ info, code }`) es un fallo transitorio del canal y quedan
 * reintentos, pausa la inscripción para reintentar ESTE MISMO paso (waiting +
 * nextRunAt) y devuelve true. El caller debe fijar currentNodeId/stepIndex al paso
 * actual, guardar y salir. `at` = { nodeId } (grafo) o { stepIndex } (lineal).
 */
function scheduleSendRetry(enrollment, fail, at) {
  if (!fail || !RETRYABLE_SEND_CODES.has(fail.code)) return false;
  const ctx = enrollment.context || {};
  const tries = Number(ctx.sendRetries || 0) + 1;
  if (tries > SEND_RETRY_MAX) return false; // agotado: que el caller lo registre como definitivo
  ctx.sendRetries = tries;
  enrollment.context = ctx;
  enrollment.markModified('context');
  pushLog(enrollment, {
    ...at,
    type: 'retry',
    ok: false,
    info: `${fail.info} Se reintenta en 5 min (intento ${tries}/${SEND_RETRY_MAX}); el turno del contacto no se pierde.`,
  });
  enrollment.status = 'waiting';
  enrollment.nextRunAt = new Date(Date.now() + SEND_RETRY_MS);
  return true;
}

/** El paso se resolvió (éxito o fallo definitivo): limpiar el contador de reintentos. */
function clearSendRetries(enrollment) {
  if (enrollment.context?.sendRetries) {
    delete enrollment.context.sendRetries;
    enrollment.markModified('context');
  }
}

/**
 * Agente call_center con MENOS conversaciones abiertas asignadas (reparto
 * equitativo). Devuelve { _id, name } o null si no hay agentes.
 */
async function pickRoundRobinAgent(clinicId) {
  const agents = await User.find({
    active: true,
    'clinics.role': 'call_center',
  }).select('_id name active clinics callCenterSchedule');
  if (!agents.length) return null;
  // El call center es global. Para reparto automático solo participan los
  // asesores que están en su turno configurado; sin horario explícito = 24/7.
  const available = agents.filter((agent) => isWorkingAt(agent.callCenterSchedule, new Date()));
  if (!available.length) return null;
  const counts = await Conversation.aggregate([
    { $match: { clinic: new mongoose.Types.ObjectId(clinicId), status: 'open', assignedTo: { $ne: null } } },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);
  const byAgent = new Map(counts.map((c) => [String(c._id), c.count]));
  available.sort((a, b) => (byAgent.get(String(a._id)) || 0) - (byAgent.get(String(b._id)) || 0));
  return available[0];
}

async function findAssignableAgent(userId) {
  if (!userId || !mongoose.isValidObjectId(userId)) return null;
  return User.findOne({
    _id: userId,
    active: true,
    'clinics.role': 'call_center',
  }).select('_id name active clinics callCenterSchedule');
}

/**
 * Lista de disparadores efectivos de un workflow. Fuente canónica: `triggers`
 * (array, lógica OR); si está vacío, cae al legacy `trigger` (objeto único).
 */
function getTriggers(wf) {
  if (Array.isArray(wf.triggers) && wf.triggers.length) return wf.triggers;
  return wf.trigger && wf.trigger.type ? [wf.trigger] : [];
}

/**
 * Disparadores de un nodo trigger concreto (cada nodo trigger = un flujo). Si el
 * nodo no trae su propia lista (workflows viejos de un solo flujo), cae a los
 * disparadores a nivel workflow.
 */
function triggersOfNode(wf, node) {
  const nt = node?.data?.triggers;
  if (Array.isArray(nt) && nt.length) return nt;
  return getTriggers(wf);
}

/**
 * Flujos (nodos trigger) de un workflow de grafo que coinciden con un predicado.
 * Devuelve [{ startNodeId, currentNodeId }] listo para inscribir. Para workflows
 * lineales (legacy, sin nodes) devuelve un único flujo {null,null} si coincide.
 */
function matchingFlows(wf, matchFn) {
  const triggerNodes = (wf.nodes || []).filter((n) => n.type === 'trigger');
  if (!triggerNodes.length) {
    return getTriggers(wf).some(matchFn) ? [{ startNodeId: null, currentNodeId: null }] : [];
  }
  const flows = [];
  for (const tn of triggerNodes) {
    if (!triggersOfNode(wf, tn).some(matchFn)) continue;
    const startChild = nextNodeId(wf, tn.id);
    if (!startChild) continue; // flujo sin pasos: nada que ejecutar
    flows.push({ startNodeId: tn.id, currentNodeId: startChild });
  }
  return flows;
}

/** ¿Coincide un disparador con un evento de dominio (cita, venta, etc.)? */
function triggerMatchesEvent(tr, eventType, payload, services) {
  if (!tr || tr.type !== eventType) return false;
  if (tr.audience === 'new' && !payload.isFirstVisit) return false;
  if (tr.audience === 'existing' && payload.isFirstVisit) return false;
  if (tr.serviceFilter && !services.includes(String(tr.serviceFilter))) return false;
  // Filtro por SUCURSAL del evento (payload.clinicId = sede donde ocurrió la
  // cita/venta): permite un flujo distinto por sede (p.ej. un video por sucursal).
  if (tr.clinicFilter && String(payload.clinicId || '') !== String(tr.clinicFilter)) return false;
  if (eventType === 'tag_added' && tr.tagFilter && String(payload.tag || '') !== tr.tagFilter) return false;
  return true;
}

/** Coincidencia de palabra clave para triggers de chat. PURO y testeable. */
function keywordMatchesTrigger(trigger, text) {
  const kws = (trigger.keywords || []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return false;
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return kws.some((kw) => {
    if (trigger.matchType === 'exact') return t === kw;
    if (trigger.matchType === 'starts') return t.startsWith(kw);
    return t.includes(kw);
  });
}

// Normaliza texto (sin acentos, mayúsculas) para clasificar respuestas.
function normalizeReply(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const YES_WORDS = ['SI', 'SII', 'CLARO', 'OK', 'OKEY', 'DALE', 'LISTO', 'CONFIRMO', 'CONFIRMADO', 'CONFIRMAR', 'ASISTIRE', 'VOY', 'DE ACUERDO', 'PERFECTO'];
const NO_WORDS = ['NO', 'NEL', 'CANCELAR', 'CANCELA', 'CANCELO', 'NO PUEDO', 'NO VOY', 'NO ASISTIRE', 'REAGENDAR', 'REPROGRAMAR', 'OTRO DIA'];

/**
 * Clasifica una respuesta entrante como 'yes' | 'no' | 'other'. PURO y testeable.
 */
function classifyReply(text) {
  const n = normalizeReply(text);
  if (!n) return 'other';
  if (NO_WORDS.some((w) => n === w || n.startsWith(w + ' '))) return 'no';
  if (YES_WORDS.some((w) => n === w || n.startsWith(w + ' '))) return 'yes';
  return 'other';
}

function firstNameOf(patient) {
  return (patient?.firstName || (patient?.name || '').split(' ')[0] || '').trim();
}

function personalize(text, patient) {
  const name = firstNameOf(patient);
  return String(text || '').replace(/\{\{\s*(nombre|name|firstName)\s*\}\}/gi, name);
}

/**
 * Rellena TODAS las variables conocidas del texto — el mismo catálogo que las
 * plantillas: {{nombre}}, {{apellido}}, {{nombre_completo}}, {{fecha_cita}},
 * {{hora_cita}}, {{servicio}}, {{doctor}}, {{sede}} (las de cita se resuelven
 * con la cita del contexto del flujo). Una variable desconocida o sin dato se
 * elimina, para que al paciente nunca le llegue un "{{x}}" literal.
 */
async function renderText(text, patient, ctx = {}) {
  const raw = String(text || '');
  if (!raw.includes('{{')) return raw;
  // Inscripción de un CONTACTO del CRM (importación): {{nombre}} sale del contacto
  // guardado en el contexto (sin esto el saludo llegaba como "Hola " en blanco) y
  // {{servicio}}/{{hora}}… de sus campos personalizados (las columnas del Excel).
  // `customFields` FALTABA en el select: en un paso de texto libre esas variables
  // se resolvían siempre a vacío y se borraban del mensaje.
  //
  // Se carga aunque HAYA paciente: la ficha clínica no tiene las columnas del
  // Excel, y un contacto que además es paciente perdía los datos de su campaña.
  let contact = null;
  if (ctx.contactId) {
    contact = await require('../models/Contact')
      .findById(ctx.contactId)
      .select('firstName lastName displayName customFields')
      .lean()
      .catch(() => null);
  }
  const resolve = await messaging.buildKnownVariableResolver(patient, ctx.appointmentId || null, contact);
  return raw.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key) => resolve(key) || '').replace(/[ \t]{2,}/g, ' ');
}

/**
 * Calcula la fecha objetivo de un paso wait_until a partir del contexto.
 * PURO y testeable. Devuelve Date o null si no hay base.
 */
function computeWaitUntil(step, context = {}) {
  if (step.waitEvent === 'appointment_date' && context.appointmentDate) {
    const base = new Date(context.appointmentDate);
    if (Number.isNaN(base.getTime())) return null;
    // Modo "hora fija": N días antes de la cita, a una hora del reloj — p.ej.
    // "recordatorio a las 18:00 del día anterior", sin importar a qué hora sea
    // la cita. El proceso corre en America/Guayaquil (TZ forzada en index.js).
    if (step.waitMode === 'clock') {
      const m = String(step.atTime || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const target = new Date(base);
      target.setDate(target.getDate() - Math.max(0, Number(step.daysBefore || 0)));
      target.setHours(Math.min(23, Number(m[1])), Math.min(59, Number(m[2])), 0, 0);
      return target;
    }
    return new Date(base.getTime() + Number(step.offsetMinutes || 0) * 60000);
  }
  return null;
}

/**
 * Aplica (o quita) una etiqueta en el PACIENTE y en la CONVERSACIÓN. La bandeja
 * de chats muestra las etiquetas de la conversación: etiquetar solo al paciente
 * era invisible ahí ("añadir etiqueta no funciona"). Emite chat:updated para
 * que la bandeja se refresque en vivo.
 */
async function applyTag(patient, conversation, tag, { remove = false } = {}) {
  if (!tag) return;
  if (patient) {
    const cur = patient.tags || [];
    const next = remove ? cur.filter((t) => t !== tag) : cur.includes(tag) ? cur : [...cur, tag];
    if (next.length !== cur.length) {
      patient.tags = next;
      await patient.save();
    }
  }
  if (conversation) {
    const cur = conversation.tags || [];
    const next = remove ? cur.filter((t) => t !== tag) : cur.includes(tag) ? cur : [...cur, tag];
    if (next.length !== cur.length) {
      conversation.tags = next;
      await conversation.save();
      try {
        emitToCallCenter('chat:updated', { id: conversation._id });
      } catch {
        /* realtime opcional */
      }
    }
  }
}

/**
 * Añade o cambia la ETAPA de la oportunidad de la conversación operando sobre el
 * modelo canónico `conv.opportunities[]` (el que leen el modal de Oportunidades
 * del chat y el embudo global). Si el chat aún no tiene oportunidad, CREA una en
 * esta etapa; si ya existe, cambia la etapa de la PRINCIPAL (la última). Mantiene
 * en sync el espejo legacy `conv.opportunity` (igual que syncPrimaryOpportunity
 * del chatController), que leen el panel lateral y los listados, y emite
 * `chat:opportunity` para refrescar el embudo/panel en vivo.
 *
 * ANTES este paso escribía SOLO en `conv.opportunity` (legacy): el cambio no
 * aparecía en el modal de Oportunidades ni en el embudo cuando el chat ya tenía
 * entradas en `opportunities[]`, y una edición manual posterior lo borraba
 * (syncPrimaryOpportunity resetea el legacy si el array está vacío).
 */
async function applyOpportunityStage(conversation, stage, automationName = '') {
  if (!conversation || !stage) return;
  const result = opportunities.applyStage(conversation, stage);
  await conversation.save();
  await opportunities.announceStageResult(
    conversation,
    result,
    opportunities.systemActor(automationName ? `automatización "${automationName}"` : 'automatización')
  );
  try {
    emitToCallCenter('chat:opportunity', { conversationId: conversation._id });
  } catch {
    /* realtime opcional */
  }
}

/**
 * Crea (o actualiza) la oportunidad de un chat CON TODOS SUS DATOS: nombre,
 * etapa, servicios de interés del inventario, valor (automático desde esos
 * servicios o manual), etiquetas y notas. Lo usa el paso `create_opportunity`.
 *
 * `data.ifExists`:
 *  - 'update' (defecto) → si el chat ya tiene oportunidad, actualiza la principal
 *    (solo los campos configurados); si no tiene, la crea.
 *  - 'new' → añade SIEMPRE una oportunidad más (p.ej. un interés distinto).
 *
 * Como `applyOpportunityStage`, NO emite el evento de dominio del disparador
 * 'opportunity_stage' (evita cascadas workflow → workflow).
 * Devuelve null si todo fue bien, o el motivo del fallo para el registro.
 */
async function applyOpportunity(conversation, data = {}, { clinicId, patient, ctx, automationName = '' } = {}) {
  if (!conversation) return 'El flujo no tiene un chat asociado: la oportunidad se crea sobre la conversación del contacto';
  // Servicios de interés (catálogo): nombre + precio salen del inventario.
  const ids = (Array.isArray(data.opportunityProducts) ? data.opportunityProducts : []).filter(Boolean);
  let interestedIn = [];
  let autoValue = 0;
  if (ids.length) {
    const products = await Product.find({ _id: { $in: ids } }).select('name salePrice');
    interestedIn = products.map((p) => ({ product: p._id, name: p.name }));
    autoValue = products.reduce((s, p) => s + Number(p.salePrice || 0), 0);
  }
  const valueMode = data.opportunityValueMode === 'manual' ? 'manual' : 'auto';
  const expectedValue = valueMode === 'manual' ? Math.max(0, Number(data.opportunityValue) || 0) : autoValue;
  const stage = data.stage || 'nuevo';
  const tags = (Array.isArray(data.opportunityTags) ? data.opportunityTags : []).filter(Boolean);
  const notes = await renderText(data.opportunityNotes || '', patient, ctx);
  // El nombre admite variables ({{nombre}}, {{servicio}}…) como los mensajes.
  const rendered = (await renderText(data.opportunityName || '', patient, ctx)).trim();
  const contacto = `${patient?.firstName || ''} ${patient?.lastName || ''}`.trim()
    || conversation.contactName || conversation.phone || '';
  const name = rendered
    || [interestedIn.map((i) => i.name).join(', ') || 'Oportunidad', contacto].filter(Boolean).join(' — ').slice(0, 120);

  // Un chat antiguo con la oportunidad SOLO en el espejo legacy se sube primero
  // al array: si no, "actualizar la existente" creaba una segunda y la del espejo
  // desaparecía al recalcularlo.
  const list = opportunities.ensureArray(conversation);
  const reuse = data.ifExists !== 'new' && list.length > 0;
  const prevStage = reuse ? String(list[list.length - 1]?.stage || '') : null;
  let changedOpportunity;
  if (reuse) {
    const primary = list[list.length - 1];
    changedOpportunity = primary;
    opportunities.setStage(primary, stage);
    primary.name = name;
    if (ids.length) {
      primary.interestedIn = interestedIn;
      if (valueMode === 'auto') primary.expectedValue = autoValue;
    }
    if (valueMode === 'manual') { primary.valueMode = 'manual'; primary.expectedValue = expectedValue; }
    else if (ids.length) primary.valueMode = 'auto';
    if (tags.length) primary.tags = [...new Set([...(primary.tags || []), ...tags])];
    if (notes) primary.notes = notes;
  } else {
    const now = new Date();
    conversation.opportunities = [
      ...list,
      {
        isOpportunity: true,
        name,
        stage,
        interestedIn,
        valueMode,
        expectedValue,
        tags,
        notes,
        createdAt: now,
        stageChangedAt: now,
        ...(stage === 'ganado' ? { convertedAt: now } : {}),
      },
    ];
    changedOpportunity = conversation.opportunities[conversation.opportunities.length - 1];
  }
  conversation.markModified('opportunities');
  // Espejo legacy = última del array (regla única en utils/opportunities.js).
  opportunities.syncPrimaryOpportunity(conversation);
  await conversation.save();
  const actor = opportunities.systemActor(
    automationName ? `automatización "${automationName}"` : 'automatización'
  );
  if (!reuse) {
    await opportunities.announceOpportunity(conversation, {
      type: 'created', opportunity: changedOpportunity, actor,
    });
  } else if (prevStage !== String(stage)) {
    await opportunities.announceOpportunity(conversation, {
      type: 'stage', prevStage, opportunity: changedOpportunity, actor,
    });
  }
  try {
    emitToCallCenter('chat:opportunity', { conversationId: conversation._id });
  } catch {
    /* realtime opcional */
  }
  return null;
}

/**
 * Oportunidad "principal" de un chat: la ÚLTIMA de `opportunities[]` (fuente
 * canónica, misma regla que el chatController/applyOpportunityStage) con
 * respaldo en el espejo legacy `opportunity`.
 */
const primaryOpportunity = opportunities.primaryOpportunity;

/**
 * Valores de una condición para los operadores de lista ('in' / 'nin').
 * Acepta `values: []` (lo que guarda el editor) o `value` con comas.
 */
function conditionValues(cond = {}) {
  if (Array.isArray(cond.values) && cond.values.length) {
    return cond.values.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(cond.value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

// Compara un valor SUELTO del contexto (etapa, fuente, sucursal…) con la condición.
function matchScalar(actual, cond) {
  const a = String(actual ?? '');
  const v = String(cond.value ?? '');
  switch (cond.op) {
    case 'exists': return !!a;
    case 'neq': return a !== v;
    case 'contains': return !!v && a.toLowerCase().includes(v.toLowerCase());
    case 'in': return conditionValues(cond).includes(a);
    case 'nin': return !conditionValues(cond).includes(a);
    default: return a === v; // eq
  }
}

/**
 * Compara un valor del contexto que puede tener VARIOS candidatos (las etapas de
 * todas las oportunidades del chat). Con operadores positivos basta con que UNO
 * coincida; con los negativos ('distinto de', 'no está en') se exige que
 * NINGUNO coincida, que es lo que la gente entiende por "no está en agendado".
 */
function matchScalarAny(values, cond) {
  const list = Array.isArray(values) && values.length ? values : [''];
  const negative = cond.op === 'neq' || cond.op === 'nin';
  return negative ? list.every((v) => matchScalar(v, cond)) : list.some((v) => matchScalar(v, cond));
}

// Compara una LISTA del contexto (etiquetas del paciente / del chat / de la oportunidad).
function matchList(list, cond) {
  const arr = (Array.isArray(list) ? list : []).map((x) => String(x));
  const v = String(cond.value ?? '');
  switch (cond.op) {
    case 'exists': return arr.length > 0;
    case 'neq': return !arr.includes(v);
    case 'in': return conditionValues(cond).some((x) => arr.includes(x));
    case 'nin': return !conditionValues(cond).some((x) => arr.includes(x));
    default: return arr.includes(v); // eq / contains
  }
}

// Compara un NÚMERO del contexto (valor esperado de la oportunidad).
function matchNumber(actual, cond) {
  const n = Number(actual) || 0;
  const v = Number(cond.value) || 0;
  switch (cond.op) {
    case 'exists': return n > 0;
    case 'neq': return n !== v;
    case 'gt': return n > v;
    case 'lt': return n < v;
    default: return n === v; // eq
  }
}

/**
 * Evalúa UNA condición suelta ({ field, op, value }) contra el paciente, la
 * conversación y el contexto de la inscripción. PURO y testeable.
 */
function evaluateSingleCondition(cond = {}, { patient, conversation, context } = {}) {
  // La oportunidad "de la que va" el flujo: si la inscripción nació de un cambio
  // de etapa, la que está EN ESA etapa; si no, la principal. Antes era siempre la
  // última del array, así que en un chat con varias oportunidades las condiciones
  // se evaluaban contra una que no tenía nada que ver con el evento.
  const opp = opportunities.relevantOpportunity(conversation, context);
  switch (cond.field) {
    case 'clinic':
      // Sucursal donde ocurrió el evento que inscribió el flujo (cita/venta).
      return matchScalar(String(context?.eventClinicId || ''), cond);
    case 'tag':
      return matchList(patient?.tags, cond);
    case 'chatTag':
      return matchList(conversation?.tags, cond);
    case 'opportunityTag':
      return matchList(opp?.tags, cond);
    case 'stage':
      // Etapa del embudo. Se comparan las etapas de TODAS las oportunidades del
      // chat (más la del evento que inscribió el flujo). Antes se miraba solo la
      // ÚLTIMA del array, con la del evento como mero respaldo: en un chat con
      // varias oportunidades —o cuando la etapa se había movido en otra— la
      // condición "etapa = agendado" daba falso y el flujo moría ahí, aunque el
      // chat SÍ estuviera en esa etapa. Era el "las etapas no funcionan".
      return matchScalarAny(opportunities.stageCandidates(conversation, context), cond);
    case 'opportunityValue':
      return matchNumber(opp?.expectedValue, cond);
    case 'opportunityName':
      return matchScalar(opp?.name || '', cond);
    case 'source':
      return matchScalar(patient?.source || '', cond);
    case 'lastReply': {
      const lastReply = context?.lastReply || '';
      if (cond.op === 'exists') return !!lastReply && lastReply !== 'other';
      return matchScalar(lastReply, cond); // eq → 'yes' | 'no' | 'other'
    }
    case 'hasPatient':
      return cond.op === 'neq' ? !patient : !!patient;
    default:
      return true;
  }
}

/**
 * Condiciones de un grupo (rama). Acepta el formato NUEVO (`conditions[]`) y el
 * legacy de una sola condición (`field`/`op`/`value` en el propio paso).
 */
function conditionsOf(group = {}) {
  const list = Array.isArray(group.conditions) ? group.conditions.filter((c) => c && c.field) : [];
  if (list.length) return list;
  return group.field ? [{ field: group.field, op: group.op, value: group.value, values: group.values }] : [];
}

/**
 * ¿Se cumple un grupo de condiciones? `match`: 'any' = basta UNA (O / condiciones
 * independientes), cualquier otro valor = TODAS (Y / condiciones conectadas).
 * Un grupo SIN condiciones se cumple siempre (igual que el paso vacío de antes).
 */
function evaluateConditionGroup(group = {}, scope = {}) {
  const list = conditionsOf(group);
  if (!list.length) return true;
  return group.match === 'any'
    ? list.some((c) => evaluateSingleCondition(c, scope))
    : list.every((c) => evaluateSingleCondition(c, scope));
}

/**
 * Ramas de un paso `condition`. Formato nuevo: `branches[]`, cada una con su
 * propio conjunto de condiciones y su salida (sourceHandle = branch.id). Sin
 * `branches` se comporta como el nodo clásico de una rama (handle 'yes').
 */
function branchesOf(step = {}) {
  const arr = Array.isArray(step.branches) ? step.branches.filter((b) => b && b.id) : [];
  if (arr.length) return arr;
  return [{ id: 'yes', name: 'Sí', match: step.match, conditions: conditionsOf(step) }];
}

/**
 * Primera rama que se cumple (se evalúan EN ORDEN, como un if/else-if). Devuelve
 * { id, name } o null si no se cumple ninguna → salida 'no' ("si no").
 */
function matchBranch(step, scope = {}) {
  for (const b of branchesOf(step)) {
    if (evaluateConditionGroup(b, scope)) return { id: b.id || 'yes', name: b.name || 'Sí' };
  }
  return null;
}

/**
 * Evalúa el predicado de condition/goal (sí/no). Usa la PRIMERA rama: sirve para
 * `goal` y para el runner lineal legacy, que solo tienen dos salidas.
 * PURO y testeable.
 */
function evaluateCondition(step, scope = {}) {
  return evaluateConditionGroup(branchesOf(step)[0], scope);
}

async function loadConversationForPatient(clinicId, phone, patientId) {
  // Primero por PACIENTE: los contactos con número oculto de WhatsApp (LID)
  // tienen una conversación cuyo "phone" son los dígitos del LID, NO el
  // teléfono de la ficha — buscar solo por teléfono no la encuentra nunca.
  if (patientId) {
    const byPatient = await Conversation.findOne({
      clinic: clinicId,
      patient: patientId,
      channel: 'whatsapp',
    }).sort({ lastMessageAt: -1 });
    if (byPatient) return byPatient;
  }
  if (!phone) return null;
  // Incluye los chats de "número oculto" (@lid) enlazados a este teléfono y se
  // queda con aquel en el que el contacto escribió por última vez: es el que
  // decide por qué número sale la respuesta. Ver findConversationForPerson.
  return messaging.findConversationForPerson(clinicId, messaging.normalizePhone(phone), null);
}

// ─────────── Ejecución de acciones (compartida por grafo) ───────────

/**
 * Ejecuta UNA acción de efecto secundario (no de control de flujo). La usa el
 * runner de grafo. `convRef` = { current } comparte la conversación cargada
 * perezosamente entre nodos. Replica la lógica del runner lineal.
 * Devuelve null si todo salió bien, o un string con el motivo del fallo (para
 * el registro de ejecución). Los errores inesperados se propagan (throw).
 */
async function performAction(step, { clinicId, patient, phone, ctx, convRef, automationName = '', workflowButtons = [] }) {
  const loadConv = async () => {
    if (!convRef.current) convRef.current = await loadConversationForPatient(clinicId, phone, patient?._id);
    return convRef.current;
  };
  // Número por el que sale este envío. Solo lo trae el contexto cuando el usuario
  // FIJÓ uno al importar el Excel; vacío = automático y lo resuelve messaging con
  // el último número por el que escribió el contacto.
  const whatsappAccount = ctx?.whatsappAccountId || null;
  // Ficha de contacto de la que salen las variables de la campaña ({{servicio}},
  // {{hora}}… del Excel). Sin esto messaging la buscaba por teléfono y, con dos
  // fichas del mismo número, cogía la vieja: el mensaje salía con los datos de la
  // campaña ANTERIOR.
  const contactId = ctx?.contactId || null;
  switch (step.type) {
    case 'send_message': {
      // Se envía a la CONVERSACIÓN existente del paciente (imprescindible con
      // números ocultos/LID, donde el teléfono de la ficha no sirve de destino;
      // y con Messenger/Instagram, donde el "teléfono" es en realidad un PSID/
      // IGSID); si no hay ninguna, messaging la crea a partir del teléfono (whatsapp).
      const conversation = await loadConv();
      const r = await messaging.send({
        clinicId,
        channel: conversation?.channel || 'whatsapp',
        conversation,
        to: phone,
        patient,
        body: await renderText(step.body, patient, ctx),
        // Adjunto opcional del nodo (imagen/video/audio/documento): Cloud/Messenger/
        // Instagram lo mandan por link, QR lee los bytes del storage propio. Misma
        // ventana de 24h que el texto (whatsapp) o de mensajería estándar (Meta).
        mediaUrl: step.mediaUrl || null,
        mediaType: step.mediaType || null,
        buttons: workflowButtons,
        isAutoReply: true,
        whatsappAccount,
      });
      return sendFail(r, conversation?.channel || 'whatsapp');
    }
    case 'send_media': {
      // Solo imagen/video/audio/documento, sin texto (nodo "Enviar imagen / video / audio").
      if (!step.mediaUrl) return 'El nodo no tiene imagen o video adjunto: edítalo y sube el archivo.';
      const conversation = await loadConv();
      const r = await messaging.send({
        clinicId,
        channel: conversation?.channel || 'whatsapp',
        conversation,
        to: phone,
        patient,
        body: '',
        mediaUrl: step.mediaUrl,
        mediaType: step.mediaType || 'image',
        isAutoReply: true,
        whatsappAccount,
      });
      return sendFail(r, conversation?.channel || 'whatsapp');
    }
    case 'send_template': {
      // Meta no tiene plantillas HSM fuera de WhatsApp, pero SÍ se puede mandar el
      // TEXTO de la plantilla como mensaje normal por Messenger/Instagram (ver
      // messaging.send). TikTok (no es de Meta) y otros canales sin envío
      // implementado fallan claro en vez de intentarlo por WhatsApp (que mandaría
      // a un PSID/IGSID/open_id como si fuera un teléfono).
      const conversation = await loadConv();
      const stepChannel = conversation?.channel || 'whatsapp';
      if (!TEMPLATE_CHANNELS.has(stepChannel)) {
        return `Este chat es de ${CHANNEL_LABELS[stepChannel] || stepChannel}: las plantillas no están disponibles ahí todavía. Usa el paso "Enviar mensaje" en su lugar.`;
      }
      // Sin vars posicionales: messaging rellena cada variable por su NOMBRE
      // (paciente + datos reales de la cita vía appointmentId del contexto).
      const r = await messaging.send({
        clinicId,
        channel: stepChannel,
        conversation,
        to: phone,
        patient,
        template: { name: step.templateName, language: step.templateLanguage || 'es' },
        appointmentId: ctx.appointmentId || null,
        isAutoReply: true,
        whatsappAccount,
        contactId,
      });
      return sendFail(r, stepChannel);
    }
    case 'send_email': {
      const to = patient?.email;
      if (!to) return 'El paciente no tiene email registrado.';
      const r = await messaging.send({ clinicId, channel: 'email', to, patient, subject: await renderText(step.emailSubject || 'Mensaje de tu clínica', patient, ctx), body: await renderText(step.body, patient, ctx) });
      return sendFail(r, 'email');
    }
    case 'assign_agent': {
      const conversation = await loadConv();
      if (!conversation) return 'No existe un chat que se pueda asignar.';
      let agent = null;
      if (step.assignMode === 'user') agent = await findAssignableAgent(step.assignUser);
      else agent = await pickRoundRobinAgent(clinicId);
      if (!agent) {
        return step.assignMode === 'user'
          ? 'El asesor seleccionado no existe, está inactivo o ya no tiene rol call center.'
          : 'No hay asesores de call center en turno para el reparto automático.';
      }
      conversation.assignedTo = agent._id;
      conversation.assignedToName = agent.name;
      conversation.assignedAt = new Date();
      // Solo la elección explícita desde el workflow reserva la cola, y lo hace
      // únicamente mientras el asesor está dentro de una de sus franjas.
      // El round-robin mantiene la asignación operativa compartida.
      conversation.workflowRestrictedTo = step.assignMode === 'user' ? agent._id : null;
      conversation.workflowRestrictedAt = step.assignMode === 'user' ? new Date() : null;
      conversation.workflowRestrictionActive = step.assignMode === 'user'
        ? applyAgentRestrictionState(conversation, agent)
        : false;
      await conversation.save();
      // Una asignación explícita fuera de turno no debe avisar al propietario:
      // en ese momento el chat pertenece a la bandeja compartida de los demás.
      if (step.assignMode !== 'user' || conversation.workflowRestrictionActive) {
        emitToUser(agent._id, 'chat:assigned', { conversationId: conversation._id });
      }
      emitChatAssignment({
        conversationId: conversation._id,
        assignedTo: agent._id,
        assignedToName: agent.name,
        restrictedTo: conversation.workflowRestrictedTo,
        restrictionActive: conversation.workflowRestrictionActive,
      });
      break;
    }
    case 'create_task': {
      let assignTo = step.assignUser || null;
      if (!assignTo) { const a = await pickRoundRobinAgent(clinicId); assignTo = a?._id || null; }
      const offset = Number(step.taskDueOffsetMinutes || 0);
      const task = await AgentTask.create({
        clinic: clinicId,
        title: await renderText(step.taskTitle || 'Tarea automática', patient, ctx),
        conversation: convRef.current?._id || null,
        patient: patient?._id || null,
        assignedTo: assignTo,
        dueAt: offset ? new Date(Date.now() + offset * 60000) : null,
      });
      if (assignTo) emitToUser(assignTo, 'task:assigned', { id: task._id, title: task.title });
      break;
    }
    case 'webhook':
      if (step.webhookUrl) {
        try {
          const method = step.webhookMethod || 'POST';
          const payload = {
            event: 'workflow',
            patient: patient ? { id: String(patient._id), firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone, email: patient.email } : null,
            conversationId: convRef.current?._id ? String(convRef.current._id) : null,
            context: ctx,
          };
          await fetch(step.webhookUrl, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
        } catch (err) { console.error('[workflowEngine] webhook error', err.message); }
      }
      break;
    case 'request_review': {
      const conversation = await loadConv();
      const stepChannel = conversation?.channel || 'whatsapp';
      const token = ReviewRequest.newToken();
      await ReviewRequest.create({ clinic: clinicId, patient: patient?._id || null, appointment: ctx.appointmentId || null, conversation: conversation?._id || null, token, channel: stepChannel });
      const base = process.env.PUBLIC_API_URL || '';
      const link = base ? `${base}/api/public/review/${token}` : '';
      const text = await renderText(step.body || '¡Hola {{nombre}}! ¿Cómo fue tu experiencia con nosotros? Califícanos aquí:', patient, ctx);
      const r = await messaging.send({ clinicId, channel: stepChannel, conversation, to: phone, patient, body: link ? `${text}\n${link}` : text, isAutoReply: true });
      return sendFail(r, stepChannel);
    }
    case 'ai_reply': {
      const conversation = await loadConv();
      if (!conversation) return 'No hay conversación abierta con el paciente para responder con IA.';
      const { suggestReply } = require('./aiAssistant');
      const r = await suggestReply({ clinicId, conversationId: conversation._id });
      if (r.ok && r.suggestion) {
        const sent = await messaging.send({ clinicId, channel: conversation.channel || 'whatsapp', to: phone, patient, conversation, body: r.suggestion, isAutoReply: true });
        return sendFail(sent, conversation.channel || 'whatsapp');
      }
      return 'La IA no generó una sugerencia.';
    }
    case 'set_appointment_status':
      if (ctx.appointmentId && step.appointmentStatus) {
        const appt = await Appointment.findOne({ _id: ctx.appointmentId, clinic: clinicId });
        if (appt && !['completada', 'asistida'].includes(appt.status)) {
          appt.status = step.appointmentStatus;
          await appt.save();
          emitToClinic(clinicId, 'appointment:updated', appt);
        }
      }
      break;
    case 'add_tag':
      if (step.tag) await applyTag(patient, await loadConv(), step.tag);
      break;
    case 'remove_tag':
      if (step.tag) await applyTag(patient, await loadConv(), step.tag, { remove: true });
      break;
    case 'move_stage':
      if (step.stage) await applyOpportunityStage(await loadConv(), step.stage, automationName);
      break;
    case 'create_opportunity':
      // Crea la oportunidad COMPLETA (nombre, etapa, servicios, valor, etiquetas,
      // notas) sobre el chat del contacto. Sustituye a `move_stage`, que solo
      // sabía mover la etapa.
      return applyOpportunity(await loadConv(), step, { clinicId, patient, ctx, automationName });
    case 'meta_capi': {
      // Reporta un evento de conversión a Meta (Conversions API) con los datos
      // del paciente. Optimiza las campañas por resultados reales del CRM.
      const mc = require('./metaConversions');
      const eventName = step.metaEventName || 'Lead';
      const user = patient ? mc.patientUserData(patient) : {};
      if (!user.phone && phone) user.phone = phone;
      const customData = { chat_funnel_stage: 'automatizacion' };
      if (Number(step.metaValue) > 0) { customData.value = Number(step.metaValue); customData.currency = step.metaCurrency || 'USD'; }
      const r = await mc.sendConversionEvent({
        eventName,
        eventId: `${eventName.toLowerCase()}_wf_${patient?._id || phone || 'anon'}_${ctx.appointmentId || Date.now()}`,
        user,
        customData,
      });
      if (r.skipped) {
        return r.reason === 'capi_not_configured'
          ? 'La API de conversión de Meta (CAPI) no está configurada en Ajustes → WhatsApp.'
          : 'El paciente no tiene teléfono/email para el matching con Meta.';
      }
      if (!r.ok) return `Meta rechazó el evento de conversión: ${r.error}`;
      break;
    }
    case 'fb_audience_add': {
      const ca = require('./metaCustomAudience');
      const r = await ca.addToAudience({ audienceId: step.audienceId, patient: patient || { phone } });
      if (r.error && !r.skipped && !r.reason) return `Meta rechazó añadir al público: ${r.error}`;
      if (r.skipped) {
        return r.reason === 'marketing_api_not_configured'
          ? 'La Marketing API de Meta no está configurada (falta el token con ads_management en Ajustes → WhatsApp).'
          : 'El contacto no tiene teléfono/email para el matching con Meta.';
      }
      if (!r.ok) return r.error || 'No se pudo añadir al público personalizado.';
      break;
    }
    case 'fb_audience_remove': {
      const ca = require('./metaCustomAudience');
      const r = await ca.removeFromAudience({ audienceId: step.audienceId, patient: patient || { phone } });
      if (r.error && !r.skipped && !r.reason) return `Meta rechazó quitar del público: ${r.error}`;
      if (r.skipped) {
        return r.reason === 'marketing_api_not_configured'
          ? 'La Marketing API de Meta no está configurada (falta el token con ads_management en Ajustes → WhatsApp).'
          : 'El contacto no tiene teléfono/email para el matching con Meta.';
      }
      if (!r.ok) return r.error || 'No se pudo quitar del público personalizado.';
      break;
    }
    default:
      break;
  }
}

// ─────────── Helpers de grafo (nodes/edges) ───────────
function getNode(workflow, id) {
  return (workflow.nodes || []).find((n) => n.id === id) || null;
}

function findStartNode(workflow) {
  const nodes = workflow.nodes || [];
  const trigger = nodes.find((n) => n.type === 'trigger');
  if (trigger) return trigger;
  const targets = new Set((workflow.edges || []).map((e) => e.target));
  return nodes.find((n) => !targets.has(n.id)) || nodes[0] || null;
}

/**
 * Elige UNA ruta del nodo Dividir (split) según el tipo de distribución.
 * 'random' (por defecto): reparto aleatorio ponderado por el % de cada ruta (A/B
 * testing, "como tirar un dado"). PURO y testeable: `rand` inyectable en tests.
 * Devuelve la ruta elegida ({ id, name, percent }) o null si no hay rutas.
 */
function pickSplitRoute(routes, rand = Math.random) {
  const list = (routes || []).filter((r) => r && r.id);
  if (!list.length) return null;
  const weights = list.map((r) => Math.max(0, Number(r.percent) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  // Sin porcentajes válidos (todos 0): reparto uniforme para no dejar el flujo muerto.
  if (total <= 0) return list[Math.floor(rand() * list.length)] || list[0];
  let roll = rand() * total;
  for (let i = 0; i < list.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * Elige la ruta del split POR SUCURSAL del contacto: la ruta cuyo `clinicId`
 * coincide con la sede del contacto; si ninguna coincide, la ruta marcada como
 * `isFallback` ("otras sucursales"), o null si no hay. PURO y testeable.
 */
function pickClinicRoute(routes, clinicId) {
  const list = (routes || []).filter((r) => r && r.id);
  if (!list.length) return null;
  const cid = String(clinicId || '');
  const match = cid && list.find((r) => !r.isFallback && String(r.clinicId || '') === cid);
  return match || list.find((r) => r.isFallback) || null;
}

/** Siguiente nodo siguiendo la arista del handle indicado (yes/no/default). */
function nextNodeId(workflow, nodeId, handle = 'default') {
  const edges = workflow.edges || [];
  let edge = edges.find((e) => e.source === nodeId && (e.sourceHandle || 'default') === handle);
  if (!edge && handle !== 'default') {
    edge = edges.find((e) => e.source === nodeId && (e.sourceHandle || 'default') === 'default');
  }
  if (!edge && handle === 'default') {
    edge = edges.find((e) => e.source === nodeId);
  }
  return edge ? edge.target : null;
}

/** Siguiente nodo por un handle EXACTO (un botón sin conectar termina su rama). */
function nextNodeIdExact(workflow, nodeId, handle) {
  const edge = (workflow.edges || []).find(
    (candidate) => candidate.source === nodeId && (candidate.sourceHandle || 'default') === handle
  );
  return edge ? edge.target : null;
}

const publicApiBase = () => String(process.env.PUBLIC_API_URL || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/api$/i, '');

function safeButtonDestination(button = {}) {
  const value = String(button.url || '').trim();
  if (button.type === 'phone') {
    const digits = value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
    return digits ? `tel:${digits}` : '';
  }
  return /^https?:\/\//i.test(value) ? value : '';
}

/**
 * Prepara los botones de un nodo para el proveedor y guarda en el contexto la
 * tabla id/token → salida del grafo. Los tokens se reutilizan si el envío se
 * reintenta, evitando enlaces distintos para el mismo contacto.
 */
async function prepareWorkflowButtons({ enrollment, nodeId, buttons, patient, ctx }) {
  const configured = (Array.isArray(buttons) ? buttons : [])
    .filter((button) => button?.id && ['quick_reply', 'url', 'phone'].includes(button.type) && String(button.text || '').trim())
    .slice(0, 3);
  if (!configured.length) return [];

  const previous = ctx.pendingWorkflowButtons?.nodeId === nodeId
    ? ctx.pendingWorkflowButtons.buttons || []
    : [];
  const base = publicApiBase();
  const prepared = [];
  for (const button of configured) {
    // eslint-disable-next-line no-await-in-loop
    const rawDestination = button.type === 'quick_reply'
      ? ''
      : await renderText(button.url || '', patient, ctx);
    const destination = safeButtonDestination({ ...button, url: rawDestination });
    const old = previous.find((item) => item.id === button.id);
    const token = button.type === 'quick_reply' ? '' : (old?.token || crypto.randomBytes(24).toString('hex'));
    prepared.push({
      id: String(button.id),
      type: button.type,
      // Las respuestas rápidas de plantillas de Meta admiten hasta 25
      // caracteres; los mensajes interactivos libres se validan a 20.
      text: String(button.text).trim().slice(0, 25),
      url: rawDestination,
      destination,
      token,
      providerId: `wf:${String(enrollment._id)}:${String(button.id)}`.slice(0, 256),
      providerUrl: token && base ? `${base}/api/public/workflow-buttons/${token}` : destination,
    });
  }

  ctx.pendingWorkflowButtons = {
    nodeId,
    buttons: prepared.map(({ id, type, text, destination, token, providerId }) => ({
      id, type, text, destination, token, providerId,
    })),
  };
  const priorLinks = Array.isArray(ctx.workflowButtonLinks) ? ctx.workflowButtonLinks : [];
  const freshLinks = prepared
    .filter((button) => button.token && button.destination)
    .map((button) => ({
      token: button.token,
      type: button.type,
      destination: button.destination,
      nodeId,
      buttonId: button.id,
      text: button.text,
    }));
  ctx.workflowButtonLinks = [
    ...priorLinks.filter((old) => !freshLinks.some((fresh) => fresh.token === old.token)),
    ...freshLinks,
  ].slice(-12);
  enrollment.context = ctx;
  enrollment.markModified('context');
  return prepared;
}

/**
 * Ejecuta una inscripción de un workflow de GRAFO recorriendo aristas desde
 * `enrollment.currentNodeId` (o desde el nodo inicial). Las condiciones bifurcan
 * por las aristas 'yes'/'no'. Persiste el estado en cada espera.
 */
async function executeGraphEnrollment(enrollment, workflow, patient, { phone, ctx, conversation }) {
  const convRef = { current: conversation };
  let currentId = enrollment.currentNodeId;
  if (!currentId) {
    // `currentNodeId: null` significa DOS cosas: "aún no ha empezado" (inscripción
    // recién creada) y "la rama se acabó" (la salida por la que tocaba seguir no
    // lleva a ningún paso). Darlo SIEMPRE por lo primero reiniciaba el flujo desde
    // el disparador y REENVIABA el mensaje.
    //
    // CASO REAL (ago-2026, flujo "24 horas"): la plantilla llevaba un botón "Si
    // asistiré" y su salida "otra respuesta / tiempo" estaba sin conectar, así que
    // la inscripción quedaba esperando con currentNodeId = null. Cada mensaje que
    // escribía el paciente ("Ok, gracias") la despertaba, no casaba con el botón,
    // volvía a resolver null… y le devolvía OTRA copia del recordatorio —cobrada
    // por Meta— un segundo después. 76 contactos recibieron 122 plantillas (61% de
    // más) y el vencimiento de los botones lo repetía cada 24 h sin fin.
    // Si la inscripción YA recorrió pasos, null solo puede ser "se acabó".
    if (hasRunSteps(enrollment)) {
      await finishDeadEnd(enrollment, workflow._id, {
        info: 'La rama terminó: la salida por la que había que continuar no lleva a ningún paso. El flujo NO se reinicia desde el disparador (eso reenviaba el mensaje).',
      });
      return;
    }
    const start = findStartNode(workflow);
    if (!start) { enrollment.status = 'done'; await enrollment.save(); return; }
    currentId = start.type === 'trigger' ? nextNodeId(workflow, start.id) : start.id;
  }
  let transitions = 0;
  const now = new Date();
  while (currentId) {
    if (++transitions > MAX_STEP_TRANSITIONS) break;
    const node = getNode(workflow, currentId);
    if (!node) break;
    const data = node.data || {};
    const type = node.type;

    if (type === 'trigger') {
      currentId = nextNodeId(workflow, currentId);
    } else if (type === 'wait') {
      const mins = Number(data.waitMinutes || 0);
      if (mins > 0) {
        enrollment.currentNodeId = nextNodeId(workflow, currentId);
        enrollment.nextRunAt = new Date(Date.now() + mins * 60000);
        enrollment.status = 'waiting';
        await enrollment.save();
        return;
      }
      currentId = nextNodeId(workflow, currentId);
    } else if (type === 'wait_until') {
      const target = computeWaitUntil(data, ctx);
      const nxt = nextNodeId(workflow, currentId);
      if (target && target.getTime() > now.getTime()) {
        pushLog(enrollment, { nodeId: currentId, type, info: `Esperando hasta ${fmtLogDate(target)}` });
        enrollment.currentNodeId = nxt;
        enrollment.nextRunAt = target;
        enrollment.status = 'waiting';
        // Marca EN QUÉ wait_until quedó pausada: si la cita se reagenda o se
        // cancela mientras espera, el suscriptor recalcula/anula esta espera.
        ctx.waitNodeId = currentId;
        enrollment.context = ctx;
        enrollment.markModified('context');
        await enrollment.save();
        return;
      }
      // NO esperó: dejar constancia del porqué (antes era invisible y parecía
      // que el recordatorio "llegó cuando quiso").
      pushLog(enrollment, {
        nodeId: currentId,
        type,
        ok: !!target,
        info: target
          ? `La hora objetivo (${fmtLogDate(target)}) ya pasó al llegar aquí: continúa de inmediato`
          : 'Este flujo se disparó SIN cita en el contexto (p. ej. trigger de chat/etiqueta): el paso no puede calcular la espera y continúa',
      });
      currentId = nxt;
    } else if (type === 'window') {
      // Ventana horaria: la franja configurada es la de SILENCIO. Dentro de ella
      // el contacto espera a que TERMINE (no se pierde); fuera, el flujo sigue.
      // La ventana además QUEDA VIGENTE para todos los envíos posteriores del
      // flujo (ver rememberQuietWindow): si no, un "Esperar 5 horas" detrás del
      // nodo aterrizaba de lleno en el silencio y el mensaje salía igual.
      const win = windowOfNode(data);
      const nxt = nextNodeId(workflow, currentId);
      if (rememberQuietWindow(ctx, win)) {
        enrollment.context = ctx;
        enrollment.markModified('context');
      }
      const libre = isWindowActive(win) ? nextAllowedTime(win, new Date()) : null;
      if (isWindowActive(win) && !libre) {
        // Silencio de 24 h los 7 días: esperar sería no continuar jamás.
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: `La ventana calla las 24 h de los 7 días (${describeWindow(win)}): se ignora y el flujo continúa`,
        });
        currentId = nxt;
      } else if (libre && libre.getTime() > Date.now()) {
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: `En horario de silencio (${describeWindow(win)}): continúa el ${fmtLogDate(libre)}`,
        });
        enrollment.currentNodeId = nxt;
        enrollment.nextRunAt = libre;
        enrollment.status = 'waiting';
        await enrollment.save();
        return;
      } else {
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: isWindowActive(win)
            ? `Fuera del horario de silencio (${describeWindow(win)}): continúa`
            : 'Ventana sin días u horas válidas: no restringe nada y el flujo continúa',
        });
        currentId = nxt;
      }
    } else if (type === 'wait_reply') {
      enrollment.currentNodeId = nextNodeId(workflow, currentId);
      enrollment.nextRunAt = new Date(Date.now() + Number(data.timeoutMinutes || 720) * 60000);
      enrollment.status = 'waiting';
      enrollment.waitingForReply = true;
      enrollment.markModified('context');
      await enrollment.save();
      return;
    } else if (type === 'condition') {
      // Se evalúan las ramas EN ORDEN (if / else-if): la primera que se cumple
      // manda. Si ninguna se cumple, sale por 'no' ("si no"). Cada rama puede
      // llevar VARIAS condiciones combinadas con Y (todas) u O (cualquiera).
      const hit = matchBranch(data, { patient, conversation: convRef.current, context: ctx });
      pushLog(enrollment, { nodeId: currentId, type, info: hit ? `Rama ${hit.name}` : 'Rama No (si no)' });
      currentId = nextNodeId(workflow, currentId, hit ? hit.id : 'no');
    } else if (type === 'split') {
      // Bifurcación: reparte el contacto por una de las rutas (cada ruta es una
      // salida con su propio sourceHandle = route.id). Dos modos:
      //  - 'clinic': por la SUCURSAL del contacto (la del Excel importado / evento).
      //  - 'random' (defecto): reparto aleatorio ponderado por % (A/B).
      // Si la ruta elegida no está conectada, el flujo termina (rama vacía).
      let route;
      if (data.distribution === 'clinic') {
        const cid = ctx.eventClinicId || String(enrollment.clinic || '');
        route = pickClinicRoute(data.routes, cid);
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: route ? `Sucursal → «${route.name || route.id}»` : 'Sin ruta para esa sucursal',
        });
      } else {
        route = pickSplitRoute(data.routes);
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: route ? `Ruta «${route.name || route.id}»` : 'Sin rutas configuradas',
        });
      }
      currentId = route ? nextNodeId(workflow, currentId, route.id) : null;
    } else if (type === 'goal') {
      if (evaluateCondition(data, { patient, conversation: convRef.current, context: ctx })) {
        pushLog(enrollment, { nodeId: currentId, type, info: 'Objetivo cumplido: fin del flujo' });
        break;
      }
      currentId = nextNodeId(workflow, currentId);
    } else {
      // VENTANAS DE SILENCIO (la del workflow y las de los nodos "Ventana horaria"
      // ya recorridos): si este paso manda algo y hay silencio, el contacto se
      // queda aquí hasta que termine (el paso NO se salta: se ejecuta entero
      // cuando abre). Es lo que impide que un "Esperar" posterior a la ventana
      // acabe soltando el WhatsApp de madrugada.
      const hold = sendWindowHold(workflow, type, new Date(), ctx, currentId);
      if (hold) {
        pushLog(enrollment, {
          nodeId: currentId,
          type,
          info: `En horario de silencio (${describeQuiet(quietWindowsFor(workflow, ctx, currentId))}): se enviará el ${fmtLogDate(hold)}`,
        });
        enrollment.currentNodeId = currentId; // se re-ejecuta ESTE paso al abrir
        enrollment.nextRunAt = hold;
        enrollment.status = 'waiting';
        await enrollment.save();
        return;
      }
      // Un paso que falla NO aborta el flujo: se registra y se continúa. Así un
      // envío saltado (ventana 24h, sin teléfono) queda visible en el registro.
      try {
        const configuredWorkflowButtons = type === 'send_message'
          ? data.buttons
          : type === 'send_template'
            ? (Array.isArray(data.buttons) ? data.buttons.filter((button) => button?.type === 'quick_reply') : [])
            : [];
        const workflowButtons = configuredWorkflowButtons?.length
          ? await prepareWorkflowButtons({ enrollment, nodeId: currentId, buttons: configuredWorkflowButtons, patient, ctx })
          : [];
        // eslint-disable-next-line no-await-in-loop
        const raw = await performAction(
          { ...data, type },
          {
            clinicId: enrollment.clinic,
            patient,
            phone,
            ctx,
            convRef,
            automationName: workflow.name || '',
            workflowButtons,
          }
        );
        // Los pasos que no envían devuelven un texto pelado; los de envío, { info, code }.
        const fail = typeof raw === 'string' ? { info: raw, code: '' } : raw;
        // Canal caído (QR desconectado, sesión recargada a mitad del envío):
        // reintentar ESTE nodo, no quemar el turno del contacto.
        if (fail && scheduleSendRetry(enrollment, fail, { nodeId: currentId })) {
          enrollment.currentNodeId = currentId;
          // eslint-disable-next-line no-await-in-loop
          await enrollment.save();
          return;
        }
        clearSendRetries(enrollment);
        if (fail && ctx.pendingWorkflowButtons?.nodeId === currentId) {
          delete ctx.pendingWorkflowButtons;
          enrollment.context = ctx;
          enrollment.markModified('context');
        }
        pushLog(enrollment, { nodeId: currentId, type, ok: !fail, info: fail?.info || '' });
        if (!fail && workflowButtons.length) {
          // Un mensaje con botones (o una plantilla con respuestas rápidas)
          // es una bifurcación: espera el clic/respuesta.
          // `default` cubre otra respuesta y el vencimiento del tiempo.
          enrollment.currentNodeId = nextNodeIdExact(workflow, currentId, 'default');
          enrollment.nextRunAt = new Date(Date.now() + Number(data.buttonTimeoutMinutes || 1440) * 60000);
          enrollment.status = 'waiting';
          enrollment.waitingForReply = true;
          pushLog(enrollment, {
            nodeId: currentId,
            type,
            info: `${type === 'send_template' ? 'Plantilla' : 'Mensaje'} enviado: esperando uno de ${workflowButtons.length} botones`,
          });
          // eslint-disable-next-line no-await-in-loop
          await enrollment.save();
          return;
        }
      } catch (err) {
        pushLog(enrollment, { nodeId: currentId, type, ok: false, info: `Error: ${err.message}` });
        console.error('[workflowEngine] action error', enrollment._id, type, err.message);
      }
      currentId = nextNodeId(workflow, currentId);
      // Persistir tras CADA acción: si el proceso se reinicia (deploy) a mitad
      // del flujo, la recuperación continúa desde aquí y no repite envíos.
      enrollment.currentNodeId = currentId;
      // eslint-disable-next-line no-await-in-loop
      await enrollment.save();
    }
  }

  enrollment.currentNodeId = null;
  enrollment.status = 'done';
  await enrollment.save();
  await Workflow.updateOne({ _id: workflow._id }, { $inc: { 'stats.completed': 1 } });
}

/**
 * Ejecuta una inscripción desde su stepIndex hasta encontrar una espera o
 * terminar. Persiste el estado en cada parada.
 */
async function executeEnrollment(enrollment) {
  const workflow = await Workflow.findById(enrollment.workflow);
  if (!workflow || !workflow.active) {
    enrollment.status = 'cancelled';
    await enrollment.save();
    return;
  }
  const patient = enrollment.patient
    ? await Patient.findById(enrollment.patient) // CRM global: paciente de cualquier sucursal
    : null;
  const ctx = enrollment.context || {};
  const phone = ctx.phone || patient?.whatsapp || patient?.phone || '';
  // Si el flujo nació de un chat (mensaje/etiqueta/cambio de etapa), la inscripción
  // YA sabe de qué conversación exacta vino (enrollForChatMessage/enrollForOpportunityStage
  // guardan `enrollment.conversation`) — y por tanto de qué CANAL (whatsapp/messenger/
  // instagram). Usar esa en vez de re-adivinarla por teléfono: loadConversationForPatient
  // fuerza `channel: 'whatsapp'` cuando hay paciente, así que un paciente que además
  // tiene chat de WhatsApp guardado perdía su conversación de Messenger/Instagram y la
  // automatización terminaba respondiendo por el canal equivocado (o fallando: el
  // "teléfono" real ahí es un PSID/IGSID, no un número de WhatsApp).
  let conversation = enrollment.conversation
    ? await Conversation.findOne({ _id: enrollment.conversation, clinic: enrollment.clinic })
    : null;
  if (!conversation) {
    conversation = await loadConversationForPatient(enrollment.clinic, phone, patient?._id);
  }

  // Si el scheduler despertó una espera de botones, se agotó el tiempo: la salida
  // default ya está en currentNodeId. Un clic real elimina este marcador antes.
  if (enrollment.waitingForReply && ctx.pendingWorkflowButtons) {
    ctx.lastButtonOutcome = 'timeout';
    delete ctx.pendingWorkflowButtons;
    enrollment.context = ctx;
    enrollment.markModified('context');
  }

  // Estamos ejecutando activamente: ya no esperamos respuesta (se reactivará si
  // un próximo paso wait_reply vuelve a pausar).
  enrollment.waitingForReply = false;
  // La espera en la que estaba pausada (si la hubo) ya venció: limpiar el marcador.
  if (ctx.waitNodeId != null || ctx.waitStepIndex != null) {
    delete ctx.waitNodeId;
    delete ctx.waitStepIndex;
    enrollment.context = ctx;
    enrollment.markModified('context');
  }

  // Workflows de grafo (nodes/edges): recorrido por aristas con ramificaciones.
  if ((workflow.nodes || []).length > 0) {
    return executeGraphEnrollment(enrollment, workflow, patient, { phone, ctx, conversation });
  }

  let i = enrollment.stepIndex;
  let transitions = 0;
  const now = new Date();

  while (i < workflow.steps.length) {
    if (++transitions > MAX_STEP_TRANSITIONS) break;
    const step = workflow.steps[i];

    // Ventanas de silencio (también en los flujos lineales antiguos): dentro de la
    // franja el contacto espera aquí a que termine.
    const hold = sendWindowHold(workflow, step.type, new Date(), ctx);
    if (hold) {
      pushLog(enrollment, {
        stepIndex: i,
        type: step.type,
        info: `En horario de silencio (${describeQuiet(quietWindowsFor(workflow, ctx))}): se enviará el ${fmtLogDate(hold)}`,
      });
      enrollment.stepIndex = i;
      enrollment.nextRunAt = hold;
      enrollment.status = 'waiting';
      // eslint-disable-next-line no-await-in-loop
      await enrollment.save();
      return;
    }

    if (step.type === 'send_message') {
      // eslint-disable-next-line no-await-in-loop
      const r = await messaging.send({
        clinicId: enrollment.clinic,
        channel: conversation?.channel || 'whatsapp',
        conversation,
        to: phone,
        patient,
        // eslint-disable-next-line no-await-in-loop
        body: await renderText(step.body, patient, ctx),
        mediaUrl: step.mediaUrl || null,
        mediaType: step.mediaType || null,
        buttons: step.buttons || [],
        isAutoReply: true,
        whatsappAccount: ctx.whatsappAccountId || null,
      });
      const fail = sendFail(r, conversation?.channel || 'whatsapp');
      if (fail && scheduleSendRetry(enrollment, fail, { stepIndex: i })) {
        enrollment.stepIndex = i; // reintentar este mismo paso
        // eslint-disable-next-line no-await-in-loop
        await enrollment.save();
        return;
      }
      clearSendRetries(enrollment);
      pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail?.info || '' });
      i++;
    } else if (step.type === 'send_media') {
      if (!step.mediaUrl) {
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: false, info: 'El nodo no tiene imagen o video adjunto.' });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const r = await messaging.send({
          clinicId: enrollment.clinic,
          channel: conversation?.channel || 'whatsapp',
          conversation,
          to: phone,
          patient,
          body: '',
          mediaUrl: step.mediaUrl,
          mediaType: step.mediaType || 'image',
          isAutoReply: true,
          whatsappAccount: ctx.whatsappAccountId || null,
        });
        const fail = sendFail(r, conversation?.channel || 'whatsapp');
        if (fail && scheduleSendRetry(enrollment, fail, { stepIndex: i })) {
          enrollment.stepIndex = i;
          // eslint-disable-next-line no-await-in-loop
          await enrollment.save();
          return;
        }
        clearSendRetries(enrollment);
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail?.info || '' });
      }
      i++;
    } else if (step.type === 'send_template') {
      // Meta no tiene plantillas HSM fuera de WhatsApp, pero SÍ se puede mandar el
      // TEXTO de la plantilla como mensaje normal por Messenger/Instagram. Otros
      // canales (TikTok, no es de Meta; email; etc.) fallan claro en vez de
      // intentarlo por WhatsApp (mandaría a un PSID/IGSID/open_id como teléfono).
      const stepChannel = conversation?.channel || 'whatsapp';
      if (!TEMPLATE_CHANNELS.has(stepChannel)) {
        pushLog(enrollment, {
          stepIndex: i,
          type: step.type,
          ok: false,
          info: `Este chat es de ${CHANNEL_LABELS[stepChannel] || stepChannel}: las plantillas no están disponibles ahí todavía. Usa el paso "Enviar mensaje" en su lugar.`,
        });
      } else {
        // eslint-disable-next-line no-await-in-loop
        const r = await messaging.send({
          clinicId: enrollment.clinic,
          channel: stepChannel,
          conversation,
          to: phone,
          patient,
          template: { name: step.templateName, language: step.templateLanguage || 'es' },
          appointmentId: ctx.appointmentId || null,
          isAutoReply: true,
          whatsappAccount: ctx.whatsappAccountId || null,
          contactId: ctx.contactId || null,
        });
        const fail = sendFail(r, stepChannel);
        if (fail && scheduleSendRetry(enrollment, fail, { stepIndex: i })) {
          enrollment.stepIndex = i;
          // eslint-disable-next-line no-await-in-loop
          await enrollment.save();
          return;
        }
        clearSendRetries(enrollment);
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail?.info || '' });
      }
      i++;
    } else if (step.type === 'send_email') {
      const to = patient?.email;
      if (to) {
        // eslint-disable-next-line no-await-in-loop
        const r = await messaging.send({
          clinicId: enrollment.clinic,
          channel: 'email',
          to,
          patient,
          // eslint-disable-next-line no-await-in-loop
          subject: await renderText(step.emailSubject || 'Mensaje de tu clínica', patient, ctx),
          // eslint-disable-next-line no-await-in-loop
          body: await renderText(step.body, patient, ctx),
        });
        const fail = sendFail(r, 'email');
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail?.info || '' });
      } else {
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: false, info: 'El paciente no tiene email registrado.' });
      }
      i++;
    } else if (step.type === 'assign_agent') {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone);
      if (conversation) {
        let agent = null;
        if (step.assignMode === 'user') {
          // eslint-disable-next-line no-await-in-loop
          agent = await findAssignableAgent(step.assignUser);
        } else {
          // eslint-disable-next-line no-await-in-loop
          agent = await pickRoundRobinAgent(enrollment.clinic);
        }
        if (agent) {
          conversation.assignedTo = agent._id;
          conversation.assignedToName = agent.name;
          conversation.assignedAt = new Date();
          conversation.workflowRestrictedTo = step.assignMode === 'user' ? agent._id : null;
          conversation.workflowRestrictedAt = step.assignMode === 'user' ? new Date() : null;
          conversation.workflowRestrictionActive = step.assignMode === 'user'
            ? applyAgentRestrictionState(conversation, agent)
            : false;
          // eslint-disable-next-line no-await-in-loop
          await conversation.save();
          if (step.assignMode !== 'user' || conversation.workflowRestrictionActive) {
            emitToUser(agent._id, 'chat:assigned', { conversationId: conversation._id });
          }
          emitChatAssignment({
            conversationId: conversation._id,
            assignedTo: agent._id,
            assignedToName: agent.name,
            restrictedTo: conversation.workflowRestrictedTo,
            restrictionActive: conversation.workflowRestrictionActive,
          });
        }
      }
      i++;
    } else if (step.type === 'create_task') {
      let assignTo = step.assignUser || null;
      if (!assignTo) {
        // eslint-disable-next-line no-await-in-loop
        const a = await pickRoundRobinAgent(enrollment.clinic);
        assignTo = a?._id || null;
      }
      const offset = Number(step.taskDueOffsetMinutes || 0);
      // eslint-disable-next-line no-await-in-loop
      const task = await AgentTask.create({
        clinic: enrollment.clinic,
        // eslint-disable-next-line no-await-in-loop
        title: await renderText(step.taskTitle || 'Tarea automática', patient, ctx),
        conversation: conversation?._id || null,
        patient: patient?._id || null,
        assignedTo: assignTo,
        dueAt: offset ? new Date(Date.now() + offset * 60000) : null,
      });
      if (assignTo) emitToUser(assignTo, 'task:assigned', { id: task._id, title: task.title });
      i++;
    } else if (step.type === 'webhook') {
      if (step.webhookUrl) {
        try {
          const method = step.webhookMethod || 'POST';
          const payload = {
            event: 'workflow',
            workflowId: String(enrollment.workflow),
            patient: patient
              ? {
                  id: String(patient._id),
                  firstName: patient.firstName,
                  lastName: patient.lastName,
                  phone: patient.phone,
                  email: patient.email,
                }
              : null,
            conversationId: conversation?._id ? String(conversation._id) : null,
            context: ctx,
          };
          // eslint-disable-next-line no-await-in-loop
          await fetch(step.webhookUrl, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
          });
        } catch (err) {
          console.error('[workflowEngine] webhook error', err.message);
        }
      }
      i++;
    } else if (step.type === 'request_review') {
      const reviewChannel = conversation?.channel || 'whatsapp';
      const token = ReviewRequest.newToken();
      // eslint-disable-next-line no-await-in-loop
      await ReviewRequest.create({
        clinic: enrollment.clinic,
        patient: patient?._id || null,
        appointment: ctx.appointmentId || null,
        conversation: conversation?._id || null,
        token,
        channel: reviewChannel,
      });
      const base = process.env.PUBLIC_API_URL || '';
      const link = base ? `${base}/api/public/review/${token}` : '';
      // eslint-disable-next-line no-await-in-loop
      const text = await renderText(
        step.body || '¡Hola {{nombre}}! ¿Cómo fue tu experiencia con nosotros? Califícanos aquí:',
        patient,
        ctx
      );
      // eslint-disable-next-line no-await-in-loop
      await messaging.send({
        clinicId: enrollment.clinic,
        channel: reviewChannel,
        conversation,
        to: phone,
        patient,
        body: link ? `${text}\n${link}` : text,
        isAutoReply: true,
      });
      i++;
    } else if (step.type === 'ai_reply') {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone);
      if (conversation) {
        const { suggestReply } = require('./aiAssistant');
        // eslint-disable-next-line no-await-in-loop
        const r = await suggestReply({ clinicId: enrollment.clinic, conversationId: conversation._id });
        if (r.ok && r.suggestion) {
          // eslint-disable-next-line no-await-in-loop
          await messaging.send({
            clinicId: enrollment.clinic,
            channel: conversation.channel || 'whatsapp',
            to: phone,
            patient,
            conversation,
            body: r.suggestion,
            isAutoReply: true,
          });
        }
      }
      i++;
    } else if (step.type === 'wait') {
      const mins = Number(step.waitMinutes || 0);
      if (mins > 0) {
        enrollment.stepIndex = i + 1;
        enrollment.nextRunAt = new Date(Date.now() + mins * 60000);
        enrollment.status = 'waiting';
        await enrollment.save();
        return;
      }
      i++;
    } else if (step.type === 'wait_until') {
      const target = computeWaitUntil(step, ctx);
      if (target && target.getTime() > now.getTime()) {
        pushLog(enrollment, { stepIndex: i, type: step.type, info: `Esperando hasta ${fmtLogDate(target)}` });
        enrollment.stepIndex = i + 1;
        enrollment.nextRunAt = target;
        enrollment.status = 'waiting';
        ctx.waitStepIndex = i;
        enrollment.context = ctx;
        enrollment.markModified('context');
        await enrollment.save();
        return;
      }
      pushLog(enrollment, {
        stepIndex: i,
        type: step.type,
        ok: !!target,
        info: target
          ? `La hora objetivo (${fmtLogDate(target)}) ya pasó al llegar aquí: continúa de inmediato`
          : 'Este flujo se disparó SIN cita en el contexto: el paso no puede calcular la espera y continúa',
      });
      i++; // fecha ya pasada → continuar
    } else if (step.type === 'wait_reply') {
      // Pausa hasta que el paciente responda (resumeOnReply) o venza el timeout.
      enrollment.stepIndex = i + 1;
      enrollment.nextRunAt = new Date(Date.now() + Number(step.timeoutMinutes || 720) * 60000);
      enrollment.status = 'waiting';
      enrollment.waitingForReply = true;
      enrollment.markModified('context');
      await enrollment.save();
      return;
    } else if (step.type === 'set_appointment_status') {
      if (ctx.appointmentId && step.appointmentStatus) {
        // eslint-disable-next-line no-await-in-loop
        const appt = await Appointment.findOne({ _id: ctx.appointmentId, clinic: enrollment.clinic });
        if (appt && !['completada', 'asistida'].includes(appt.status)) {
          appt.status = step.appointmentStatus;
          // eslint-disable-next-line no-await-in-loop
          await appt.save();
          emitToClinic(enrollment.clinic, 'appointment:updated', appt);
        }
      }
      i++;
    } else if (step.type === 'condition') {
      const pass = evaluateCondition(step, { patient, conversation, context: ctx });
      pushLog(enrollment, { stepIndex: i, type: step.type, info: pass ? 'Rama Sí' : 'Rama No' });
      if (pass) {
        i++;
      } else if (step.onFailGoTo != null && step.onFailGoTo >= 0) {
        i = step.onFailGoTo;
      } else {
        break; // termina
      }
    } else if (step.type === 'goal') {
      if (evaluateCondition(step, { patient, conversation, context: ctx })) break; // objetivo cumplido → fin
      i++;
    } else if (step.type === 'add_tag' && step.tag) {
      // Sin `&& patient`: los contactos del CRM no tienen paciente, pero la
      // etiqueta debe verse igual en la conversación (applyTag tolera paciente nulo).
      // eslint-disable-next-line no-await-in-loop
      await applyTag(patient, conversation, step.tag);
      i++;
    } else if (step.type === 'remove_tag' && step.tag) {
      // eslint-disable-next-line no-await-in-loop
      await applyTag(patient, conversation, step.tag, { remove: true });
      i++;
    } else if (step.type === 'move_stage' && step.stage) {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone, patient?._id);
      // eslint-disable-next-line no-await-in-loop
      if (conversation) await applyOpportunityStage(conversation, step.stage, workflow.name || '');
      i++;
    } else if (step.type === 'create_opportunity') {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone, patient?._id);
      // eslint-disable-next-line no-await-in-loop
      const fail = await applyOpportunity(conversation, step, {
        clinicId: enrollment.clinic, patient, ctx, automationName: workflow.name || '',
      });
      pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail?.info || '' });
      i++;
    } else {
      i++; // paso desconocido → saltar
    }

    if (LINEAR_ACTION_TYPES.has(step.type) && enrollment.stepIndex !== i) {
      enrollment.stepIndex = i;
      // eslint-disable-next-line no-await-in-loop
      await enrollment.save();
    }
  }

  enrollment.stepIndex = workflow.steps.length;
  enrollment.status = 'done';
  await enrollment.save();
  await Workflow.updateOne({ _id: workflow._id }, { $inc: { 'stats.completed': 1 } });
}

/**
 * Crea inscripciones para los workflows activos que coincidan con un evento y
 * las ejecuta hasta su primera espera.
 * payload: { clinicId, patientId, appointmentId?, appointmentDate?, services?:[id], isFirstVisit? }
 */
async function enrollForEvent(eventType, payload = {}) {
  const { patientId } = payload;
  if (!patientId) return;
  // CRM global: los workflows viven en la clínica ancla del call center, y se disparan
  // aunque el evento (cita/venta/cumpleaños) haya ocurrido en otra sucursal.
  const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
  if (!clinicId) return;
  // Lógica OR: el evento coincide con `trigger` (legacy) o con cualquier `triggers[]`.
  const workflows = await Workflow.find({
    clinic: clinicId,
    active: true,
    $or: [{ 'trigger.type': eventType }, { 'triggers.type': eventType }],
  });
  if (!workflows.length) return;

  const patient = await Patient.findById(patientId); // global
  if (!patient) return;
  // Sin teléfono TAMBIÉN se inscribe: hay pasos que no envían mensajes (etiquetas,
  // tareas) y el fallo de los envíos queda registrado en el log de la inscripción.
  const phone = patient.whatsapp || patient.phone || '';

  const services = (payload.services || []).map((s) => String(s));

  // Rastro visible (Workflows → Actividad) de POR QUÉ cada workflow inscribió o
  // no: antes un salto por duplicado o por filtro era invisible y parecía que
  // "el trigger no funciona". Nunca debe tumbar la inscripción (fire and forget).
  const patientName = `${patient.firstName || ''} ${patient.lastName || ''}`.trim();
  const trace = (wf, decision, detail) => {
    try {
      require('../models/WorkflowTriggerEvent')
        .create({ clinic: clinicId, workflow: wf._id, patient: patient._id, patientName, eventType, decision, detail })
        .catch(() => {});
    } catch {
      /* noop */
    }
  };

  // Igual que en los disparadores de chat: los "no coincidió" se juntan en UNA
  // fila al final. El motivo es el mismo para todos (lo dictó el evento, no el
  // workflow), así que una fila con la lista completa dice exactamente lo mismo
  // que N filas repetidas. Ver el comentario del modelo WorkflowTriggerEvent.
  const noMatch = [];

  for (const wf of workflows) {
    // Un workflow puede tener varios flujos (nodos trigger) independientes; cada
    // flujo cuyo disparador coincida se inscribe por separado.
    const flows = matchingFlows(wf, (tr) => triggerMatchesEvent(tr, eventType, payload, services));
    if (!flows.length) {
      noMatch.push({ workflow: wf._id, name: wf.name || '' });
      continue;
    }
    for (const flow of flows) {
      // Anti-duplicado: una inscripción viva por (workflow, paciente, flujo).
      // OJO: en eventos de CITA el duplicado es por cita Y por tipo de evento
      // (context.appointmentId + eventType), y cuenta CUALQUIER estado (también
      // 'done'): el mismo evento de la misma cita ejecuta el flujo UNA sola vez
      // aunque se repita (doble clic en "No asistió", asistencia marcada por dos
      // caminos, reintentos). Cada mensaje cuesta dinero: un envío por evento.
      // Una cita NUEVA sí genera su propia ejecución (dedup por cita, no por
      // paciente: antes "agendé 3 citas y no llegó nada").
      const dedup = {
        workflow: wf._id,
        patient: patient._id,
        startNodeId: flow.startNodeId,
        status: { $in: ['active', 'waiting'] },
      };
      if (payload.appointmentId) {
        dedup['context.appointmentId'] = String(payload.appointmentId);
        dedup['context.eventType'] = eventType;
        delete dedup.status; // una sola vez por (cita, evento), para siempre
      }
      // Cumpleaños: una sola vez AL DÍA aunque el job vuelva a correr (el server
      // se reinicia con cada deploy y re-ejecuta el chequeo al arrancar). La
      // inscripción del saludo ya terminó ('done'), así que el dedup por
      // inscripciones vivas no bastaba y el paciente recibía saludos repetidos.
      if (eventType === 'patient_birthday') {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0); // día calendario Ecuador (TZ del proceso)
        delete dedup.status;
        dedup.createdAt = { $gte: dayStart };
      }
      // eslint-disable-next-line no-await-in-loop
      const existing = await WorkflowEnrollment.findOne(dedup);
      if (existing) {
        trace(
          wf,
          'skipped_duplicate',
          payload.appointmentId
            ? 'Este flujo ya se ejecutó para esta cita con este mismo activador: no se repite (un envío por cita y por tipo de evento).'
            : 'El paciente ya tiene una inscripción activa/en espera en este flujo; el evento no crea otra hasta que termine.'
        );
        continue;
      }

      let enrollment;
      try {
        // eslint-disable-next-line no-await-in-loop
        enrollment = await WorkflowEnrollment.create({
          clinic: clinicId,
          workflow: wf._id,
          patient: patient._id,
          stepIndex: 0,
          currentNodeId: flow.currentNodeId,
          startNodeId: flow.startNodeId,
          status: 'active',
          nextRunAt: new Date(),
          context: {
            phone,
            eventType, // parte de la clave anti-duplicado (una vez por cita y evento)
            // Sucursal donde ocurrió el evento (las condiciones por sucursal la leen).
            eventClinicId: payload.clinicId ? String(payload.clinicId) : null,
            appointmentId: payload.appointmentId || null,
            appointmentDate: payload.appointmentDate || null,
          },
        });
      } catch (e) {
        if (e.code === 11000) continue; // carrera anti-duplicado
        throw e;
      }
      trace(wf, 'enrolled', 'Inscripción creada; los pasos y sus resultados quedan en "Inscritos" → registro de ejecución.');
      // eslint-disable-next-line no-await-in-loop
      await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
      // Un error en ESTE flujo no debe impedir que los demás workflows del evento
      // se inscriban. processDueEnrollments recupera las inscripciones atascadas.
      // eslint-disable-next-line no-await-in-loop
      await executeEnrollment(enrollment).catch((err) =>
        console.error('[workflowEngine] event enrollment error', enrollment._id, err.message)
      );
    }
  }

  // UNA fila con todos los que no coincidieron.
  if (noMatch.length) {
    traceNoMatchGroup({
      clinicId,
      workflows: noMatch,
      patient: patient._id,
      patientName,
      eventType,
      detail:
        'El evento ocurrió pero el disparador no coincidió: revisa la audiencia ("solo pacientes nuevos/existentes"), el filtro de servicio o el filtro de sucursal del nodo disparador.',
    });
  }
}

/**
 * Inscribe workflows disparados por un mensaje de chat entrante
 * (inbound_message / keyword / new_conversation). Reemplaza a MessageFlow.
 * Lo invoca el ingest de mensajes entrantes del chatController.
 */
async function enrollForChatMessage({ clinicId, conversation, patient, phone, text, isNew, referral }) {
  if (!clinicId || !conversation) return { enrolled: 0 };
  const types = ['inbound_message', 'keyword', 'new_conversation', 'ctwa_ad'];
  const workflows = await Workflow.find({
    clinic: clinicId,
    active: true,
    $or: [{ 'trigger.type': { $in: types } }, { 'triggers.type': { $in: types } }],
  });
  if (!workflows.length) return { enrolled: 0 };

  // Anuncio del que vino ESTE mensaje (click-to-WhatsApp): el webhook lo trae en
  // referral.source_id → adId. Se usa el del mensaje y no conv.attribution para que
  // el trigger dispare solo al llegar desde el anuncio (no en cada mensaje posterior).
  const msgAdId = String(referral?.adId || '').trim();
  // Título del anuncio (headline). Meta lo manda en referral.headline; `campaign`
  // es el fallback (headline||body) que guarda el webhook.
  const msgAdText = String(referral?.headline || referral?.campaign || '').toLowerCase();

  // El ID configurado es el del Administrador de Anuncios. Meta puede mandar en
  // el referral el ID del anuncio O el de su publicación efectiva; Marketing API
  // resuelve ambos como aliases para que el ID se configure una sola vez.
  const configuredAdIds = [...new Set(workflows
    .flatMap((wf) => getAllChatTriggers(wf))
    .filter((tr) => tr?.type === 'ctwa_ad')
    .flatMap((tr) => String(tr.adFilter || '').split(','))
    .map((id) => id.trim())
    .filter(Boolean))];
  let configuredAdAliases = new Map(configuredAdIds.map((id) => [id, new Set([id])]));
  if (msgAdId && configuredAdIds.some((id) => id !== msgAdId)) {
    try {
      configuredAdAliases = await require('./metaAds').resolveAdAliases(configuredAdIds);
    } catch {
      /* matching exacto disponible como respaldo */
    }
  }

  const matchesChat = (tr) => {
    if (!tr || !types.includes(tr.type)) return false;
    if (tr.type === 'new_conversation' && !isNew) return false;
    if (tr.type === 'keyword' && !keywordMatchesTrigger(tr, text)) return false;
    if (tr.type === 'ctwa_ad') {
      if (!msgAdId) return false; // este mensaje no vino de un anuncio
      const wantedIds = String(tr.adFilter || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const wantedText = String(tr.adTextFilter || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      // Si hay algún filtro, el mensaje debe casar por ID O por texto del título.
      // Si no hay ninguno → cualquier anuncio dispara.
      if (wantedIds.length || wantedText.length) {
        const idOk = wantedIds.some((id) => configuredAdAliases.get(id)?.has(msgAdId));
        const textOk = wantedText.some((t) => msgAdText.includes(t));
        if (!idOk && !textOk) return false;
      }
    }
    // Audiencia: new = sin paciente vinculado, existing = con paciente.
    if (tr.audience === 'new' && patient) return false;
    if (tr.audience === 'existing' && !patient) return false;
    return true;
  };

  const destPhone = phone || conversation.phone || '';

  // Rastro visible en Workflows → Actividad para los triggers de CHAT (antes solo
  // los eventos de cita/venta se registraban): así se puede auditar si el
  // disparador por anuncio (ctwa_ad) inscribió, se saltó o no coincidió.
  const patientName =
    `${patient?.firstName || ''} ${patient?.lastName || ''}`.trim() ||
    conversation.contactName || destPhone;
  const trace = (wf, eventType, decision, detail) => {
    try {
      require('../models/WorkflowTriggerEvent')
        .create({ clinic: clinicId, workflow: wf._id, patient: patient?._id || patient || null, patientName, eventType, decision, detail })
        .catch(() => {});
    } catch { /* noop */ }
  };
  // Tipo de evento representativo para el rastro (prioriza ctwa_ad si vino de anuncio).
  const traceType = msgAdId ? 'ctwa_ad' : (isNew ? 'new_conversation' : 'inbound_message');

  // Los "no coincidió" se ACUMULAN y se escriben en UNA sola fila al final, en vez
  // de una por workflow. Con 17 automatizaciones de anuncio activas, cada mensaje
  // entrante escribía hasta 17 filas que decían lo mismo y repetían el mismo
  // párrafo de ayuda (medido: 4 816 filas/día, el 93% de la colección). El motivo
  // es común a todas —depende del mensaje, no del workflow—, así que una fila con
  // la lista completa conserva la misma información. Ver WorkflowTriggerEvent.
  const noMatch = [];

  let enrolled = 0;
  for (const wf of workflows) {
    // Cada flujo (nodo trigger) de chat que coincida se inscribe por separado.
    const flows = matchingFlows(wf, matchesChat);
    if (!flows.length) {
      // Solo interesa el rastro de "no coincidió" para workflows del MISMO tipo de
      // disparo que este mensaje (p.ej. si vino de anuncio, los ctwa_ad que no
      // casaron por adFilter), para no llenar la Actividad de ruido.
      const relevant = getAllChatTriggers(wf).some((tr) => tr.type === traceType);
      if (relevant) noMatch.push({ workflow: wf._id, name: wf.name || '' });
      continue;
    }
    for (const flow of flows) {
      // Anti-duplicado: una inscripción viva por (workflow, conversación, flujo).
      // eslint-disable-next-line no-await-in-loop
      const existing = await WorkflowEnrollment.findOne({
        workflow: wf._id,
        conversation: conversation._id,
        startNodeId: flow.startNodeId,
        status: { $in: ['active', 'waiting'] },
      });
      if (existing) {
        trace(wf, traceType, 'skipped_duplicate', 'Este chat ya tiene una inscripción activa/en espera en este flujo; no se crea otra hasta que termine.');
        continue;
      }

      let enrollment;
      try {
        // eslint-disable-next-line no-await-in-loop
        enrollment = await WorkflowEnrollment.create({
          clinic: clinicId,
          workflow: wf._id,
          patient: patient?._id || patient || null,
          conversation: conversation._id,
          stepIndex: 0,
          currentNodeId: flow.currentNodeId,
          startNodeId: flow.startNodeId,
          status: 'active',
          nextRunAt: new Date(),
          context: { phone: destPhone, conversationId: String(conversation._id) },
        });
      } catch (e) {
        if (e.code === 11000) continue;
        throw e;
      }
      trace(wf, traceType, 'enrolled', 'Inscripción creada desde el chat; los pasos y resultados quedan en "Inscritos" → registro de ejecución.');
      // eslint-disable-next-line no-await-in-loop
      await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
      // eslint-disable-next-line no-await-in-loop
      await executeEnrollment(enrollment).catch((err) =>
        console.error('[workflowEngine] chat enrollment error', enrollment._id, err.message)
      );
      enrolled++;
    }
  }

  // UNA fila con todos los que no coincidieron (ver el comentario de `noMatch`).
  if (noMatch.length) {
    traceNoMatchGroup({
      clinicId,
      workflows: noMatch,
      patient: patient?._id || patient || null,
      patientName,
      eventType: traceType,
      detail:
        traceType === 'ctwa_ad'
          ? `El mensaje llegó desde el anuncio ${msgAdId} (título: "${msgAdText || '—'}"), pero no coincidió con el/los anuncios ni con el/los texto(s) del disparador (o la audiencia no encajó). Si configuraste el ID del Administrador de Anuncios, verifica la conexión de Marketing API para que el sistema resuelva automáticamente sus aliases.`
          : 'El mensaje llegó pero el disparador de chat no coincidió (audiencia o palabra clave).',
    });
  }
  return { enrolled };
}

/**
 * Escribe UNA fila de rastro para todos los workflows que no coincidieron con el
 * mismo evento, en vez de una por workflow.
 *
 * Es "dispara y olvida" (sin `await`) a propósito: es un cuaderno de diagnóstico,
 * y el mensaje del paciente jamás debe esperar por él ni fallar si falla.
 */
function traceNoMatchGroup({ clinicId, workflows, patient, patientName, eventType, detail }) {
  if (!clinicId || !workflows?.length) return;
  try {
    require('../models/WorkflowTriggerEvent')
      .create({
        clinic: clinicId,
        workflow: null,
        workflows,
        count: workflows.length,
        patient: patient || null,
        patientName,
        eventType,
        decision: 'no_match',
        detail,
      })
      .catch(() => {});
  } catch {
    /* noop */
  }
}

/**
 * Inscribe los workflows disparados por un CAMBIO DE ETAPA de la oportunidad de
 * un chat (trigger 'opportunity_stage'). Lo invocan las mutaciones de oportunidad
 * del chatController vía el evento de dominio OPPORTUNITY_STAGE_CHANGED cuando un
 * agente mueve la oportunidad en el chat/Kanban. NO se dispara desde el paso
 * move_stage (evita cascadas workflow→workflow).
 * payload: { clinicId, conversationId, patientId?, phone?, stage }
 */
async function enrollForOpportunityStage(payload = {}) {
  const { conversationId, stage } = payload;
  const clinicId = payload.clinicId ? String(payload.clinicId) : null;
  if (!clinicId || !conversationId || !stage) return { enrolled: 0 };
  const workflows = await Workflow.find({
    clinic: clinicId,
    active: true,
    $or: [{ 'trigger.type': 'opportunity_stage' }, { 'triggers.type': 'opportunity_stage' }],
  });
  if (!workflows.length) return { enrolled: 0 };

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return { enrolled: 0 };
  const patient = conversation.patient ? await Patient.findById(conversation.patient) : null;
  const phone = payload.phone || conversation.phone || '';

  const matches = (tr) => {
    if (!tr || tr.type !== 'opportunity_stage') return false;
    const want = String(tr.stageFilter || '').trim();
    if (want && want !== stage) return false; // filtro por etapa (vacío = cualquiera)
    // Audiencia: new = sin paciente vinculado, existing = con paciente.
    if (tr.audience === 'new' && patient) return false;
    if (tr.audience === 'existing' && !patient) return false;
    return true;
  };

  const patientName =
    `${patient?.firstName || ''} ${patient?.lastName || ''}`.trim() ||
    conversation.contactName || phone;
  const trace = (wf, decision, detail) => {
    try {
      require('../models/WorkflowTriggerEvent')
        .create({ clinic: clinicId, workflow: wf._id, patient: patient?._id || conversation.patient || null, patientName, eventType: 'opportunity_stage', decision, detail })
        .catch(() => {});
    } catch { /* noop */ }
  };

  let enrolled = 0;
  for (const wf of workflows) {
    const flows = matchingFlows(wf, matches);
    if (!flows.length) continue; // otra etapa u otra audiencia: sin ruido en Actividad
    for (const flow of flows) {
      // Anti-duplicado: una inscripción viva por (workflow, conversación, flujo, etapa).
      // No se repite mientras siga activa/en espera para esta misma etapa; una etapa
      // distinta (o volver a entrar tras terminar) sí crea una nueva.
      // eslint-disable-next-line no-await-in-loop
      const existing = await WorkflowEnrollment.findOne({
        workflow: wf._id,
        conversation: conversation._id,
        startNodeId: flow.startNodeId,
        'context.stage': stage,
        status: { $in: ['active', 'waiting'] },
      });
      if (existing) {
        trace(wf, 'skipped_duplicate', `Ya hay una inscripción activa/en espera de este flujo para la etapa "${stage}".`);
        continue;
      }
      let enrollment;
      try {
        // eslint-disable-next-line no-await-in-loop
        enrollment = await WorkflowEnrollment.create({
          clinic: clinicId,
          workflow: wf._id,
          patient: patient?._id || conversation.patient || null,
          conversation: conversation._id,
          stepIndex: 0,
          currentNodeId: flow.currentNodeId,
          startNodeId: flow.startNodeId,
          status: 'active',
          nextRunAt: new Date(),
          context: { phone, conversationId: String(conversation._id), stage },
        });
      } catch (e) {
        if (e.code === 11000) continue;
        throw e;
      }
      trace(wf, 'enrolled', `La oportunidad entró a la etapa "${stage}"; inscripción creada.`);
      // eslint-disable-next-line no-await-in-loop
      await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
      // eslint-disable-next-line no-await-in-loop
      await executeEnrollment(enrollment).catch((err) =>
        console.error('[workflowEngine] opportunity_stage enrollment error', enrollment._id, err.message)
      );
      enrolled++;
    }
  }
  return { enrolled };
}

// Todos los disparadores de chat de un workflow (de sus nodos trigger + legacy),
// para decidir si registrar un "no coincidió" del tipo de mensaje actual.
function getAllChatTriggers(wf) {
  const triggerNodes = (wf.nodes || []).filter((n) => n.type === 'trigger');
  if (triggerNodes.length) return triggerNodes.flatMap((tn) => triggersOfNode(wf, tn));
  return getTriggers(wf);
}

// Cuánto se "bloquea" una inscripción al reclamarla, para que si el proceso muere
// a mitad de ejecución (o un paso tarda), otro tick la retome pasado ese tiempo.
const CLAIM_LOCK_MS = 2 * 60 * 1000;
const MAX_PER_TICK = 100;

/**
 * Job: reanuda inscripciones cuya espera ya venció. Recupera además las que
 * quedaron atascadas en 'active' (p.ej. si el proceso murió o un paso lanzó un
 * error a mitad de ejecución): tras 5 min sin avanzar se reintenta.
 *
 * RECLAMO ATÓMICO (crítico): en lugar de `find()` + procesar, tomamos cada
 * inscripción con `findOneAndUpdate` empujando su `nextRunAt` al futuro. Es una
 * operación atómica a nivel de documento en Mongo: si DOS ticks —o DOS procesos
 * apuntando a la MISMA base (p.ej. un segundo backend en el VPS, o un dev local
 * sobre la base de prod)— corren a la vez, el primero "gana" el documento y el
 * segundo ya NO lo ve vencido. Sin esto, ambos procesaban la misma inscripción y
 * el mensaje se ENVIABA DUPLICADO (uno la enviaba, otro la reprogramaba a +5 min
 * → reenvío cada 5 min). El lock también recupera solo si el proceso muere.
 */
async function processDueEnrollments() {
  let processed = 0;
  for (let i = 0; i < MAX_PER_TICK; i++) {
    const now = new Date();
    // eslint-disable-next-line no-await-in-loop
    const enrollment = await WorkflowEnrollment.findOneAndUpdate(
      {
        $or: [
          { status: 'waiting', nextRunAt: { $lte: now } },
          { status: 'active', updatedAt: { $lte: new Date(now.getTime() - 5 * 60000) } },
        ],
      },
      // Empuja nextRunAt (lock de las 'waiting') y bumpea updatedAt vía timestamps
      // (lock de las 'active' atascadas). executeEnrollment lo sobreescribe luego.
      { $set: { nextRunAt: new Date(now.getTime() + CLAIM_LOCK_MS) } },
      { sort: { nextRunAt: 1 }, new: true }
    );
    if (!enrollment) break; // no quedan vencidas
    // eslint-disable-next-line no-await-in-loop
    await executeEnrollment(enrollment).catch((err) => {
      console.error('[workflowEngine] enrollment error', enrollment._id, err.message);
    });
    processed++;
  }
  return { processed };
}

/**
 * Reanuda las inscripciones que esperaban respuesta del paciente cuando llega un
 * mensaje entrante. Clasifica la respuesta (yes/no/other) en el contexto para que
 * los pasos `condition` posteriores puedan ramificar.
 * Lo invoca el ingest de mensajes entrantes (chatController).
 */
async function resumeOnReply({ clinicId, patientId, phone, text, interactiveReply = null }) {
  const q = { clinic: clinicId, status: 'waiting', waitingForReply: true };
  if (patientId) q.patient = patientId;
  else if (phone) q['context.phone'] = messaging.normalizePhone(phone);
  else return { resumed: 0 };

  const enrollments = await WorkflowEnrollment.find(q);
  if (!enrollments.length) return { resumed: 0 };

  const reply = classifyReply(text);
  let resumed = 0;
  for (const enrollment of enrollments) {
    const ctx = enrollment.context || {};
    const pending = ctx.pendingWorkflowButtons;
    let clickedButton = null;
    // La respuesta llegó pero el flujo no tiene a dónde ir: se CIERRA aquí (ver más
    // abajo). Solo se decide cuando el workflow existe de verdad.
    let deadEnd = false;
    if (pending?.buttons?.length) {
      const incomingId = String(interactiveReply?.id || '');
      // Un payload Cloud identifica también la inscripción. No debe despertar
      // otros workflows del mismo contacto que estén esperando a la vez.
      if (incomingId.startsWith('wf:') && !incomingId.startsWith(`wf:${String(enrollment._id)}:`)) continue;
      const incomingText = String(interactiveReply?.title || text || '').trim().toLowerCase();
      clickedButton = pending.buttons.find((button) =>
        (incomingId && (incomingId === button.providerId || incomingId === button.id))
        || (incomingText && incomingText === String(button.text || '').trim().toLowerCase())
      ) || null;
      const workflow = await Workflow.findById(enrollment.workflow);
      enrollment.currentNodeId = workflow
        ? nextNodeIdExact(workflow, pending.nodeId, clickedButton?.id || 'default')
        : null;
      deadEnd = !!workflow && !enrollment.currentNodeId;
      ctx.lastButtonId = clickedButton?.id || '';
      ctx.lastButtonText = clickedButton?.text || String(text || '').slice(0, 200);
      ctx.lastButtonOutcome = clickedButton ? 'reply' : 'other_reply';
      delete ctx.pendingWorkflowButtons;
    }
    enrollment.context = {
      ...ctx,
      lastReply: reply,
      lastReplyText: String(text || '').slice(0, 200),
    };
    enrollment.markModified('context');
    // Sin paso al que seguir, el flujo TERMINA. Antes se reactivaba con
    // currentNodeId a null y el motor lo tomaba por "aún no ha empezado": cada
    // mensaje que escribía el contacto le devolvía otra copia del mensaje.
    if (deadEnd) {
      // eslint-disable-next-line no-await-in-loop
      await finishDeadEnd(enrollment, enrollment.workflow, {
        nodeId: pending.nodeId,
        info: clickedButton
          ? `Botón «${clickedButton.text}» sin ningún paso conectado: fin del flujo.`
          : 'La respuesta no coincide con ningún botón y la salida "otra respuesta / tiempo" no lleva a ningún paso: fin del flujo (no se reenvía el mensaje).',
      });
      resumed += 1;
      continue;
    }
    enrollment.waitingForReply = false;
    enrollment.status = 'active';
    enrollment.nextRunAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
    resumed += 1;
    // eslint-disable-next-line no-await-in-loop
    await executeEnrollment(enrollment).catch((err) =>
      console.error('[workflowEngine] resume error', enrollment._id, err.message)
    );
  }
  return { resumed };
}

/**
 * Registra un clic en un botón URL/llamar y continúa por la arista de ese
 * botón. Devuelve siempre el destino permitido para que la ruta pública redirija.
 */
async function resumeOnButtonClick(token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{48}$/i.test(clean)) return { found: false, destination: '' };
  const enrollment = await WorkflowEnrollment.findOne({
    'context.workflowButtonLinks.token': clean,
  });
  if (!enrollment) return { found: false, destination: '' };
  const pending = enrollment.context?.pendingWorkflowButtons;
  const link = enrollment.context?.workflowButtonLinks?.find((item) => item.token === clean);
  const button = pending?.buttons?.find((item) => item.token === clean) || null;
  const destination = safeButtonDestination({ type: link?.type, url: link?.destination });
  if (!link || !destination) return { found: false, destination: '' };

  let resumed = false;
  if (button && enrollment.status === 'waiting' && enrollment.waitingForReply) {
    const workflow = await Workflow.findById(enrollment.workflow);
    const target = workflow ? nextNodeIdExact(workflow, pending.nodeId, button.id) : null;
    const update = await WorkflowEnrollment.updateOne(
      {
        _id: enrollment._id,
        status: 'waiting',
        waitingForReply: true,
        'context.pendingWorkflowButtons.buttons.token': clean,
      },
      {
        $set: {
          status: 'active',
          waitingForReply: false,
          currentNodeId: target,
          nextRunAt: new Date(),
          'context.lastButtonId': button.id,
          'context.lastButtonText': button.text,
          'context.lastButtonOutcome': 'click',
        },
        $unset: { 'context.pendingWorkflowButtons': 1 },
      }
    );
    resumed = update.modifiedCount === 1;
    if (resumed) {
      const claimed = await WorkflowEnrollment.findById(enrollment._id);
      await executeEnrollment(claimed).catch((err) =>
        console.error('[workflowEngine] button click resume error', enrollment._id, err.message)
      );
    }
  }
  return { found: true, destination, resumed };
}

/**
 * Cita REAGENDADA: las inscripciones vivas de esa cita siguen apuntando a la
 * fecha vieja, así que el recordatorio saldría el día/hora equivocados. Actualiza
 * el contexto y, si la inscripción está pausada en un "esperar hasta la cita"
 * (marcador waitNodeId/waitStepIndex), recalcula nextRunAt con la nueva fecha.
 */
async function syncEnrollmentsForAppointment(payload = {}) {
  if (!payload.appointmentId || !payload.appointmentDate) return;
  const enrollments = await WorkflowEnrollment.find({
    status: { $in: ['active', 'waiting'] },
    'context.appointmentId': String(payload.appointmentId),
  });
  for (const enrollment of enrollments) {
    const ctx = enrollment.context || {};
    ctx.appointmentDate = payload.appointmentDate;
    enrollment.context = ctx;
    enrollment.markModified('context');
    if (enrollment.status === 'waiting' && !enrollment.waitingForReply && (ctx.waitNodeId != null || ctx.waitStepIndex != null)) {
      // eslint-disable-next-line no-await-in-loop
      const wf = await Workflow.findById(enrollment.workflow);
      let stepCfg = null;
      if (wf && ctx.waitNodeId != null) {
        const node = getNode(wf, ctx.waitNodeId);
        if (node && node.type === 'wait_until') stepCfg = node.data || {};
      } else if (wf && Array.isArray(wf.steps) && wf.steps[ctx.waitStepIndex]?.type === 'wait_until') {
        stepCfg = wf.steps[ctx.waitStepIndex];
      }
      if (stepCfg) {
        const target = computeWaitUntil(stepCfg, ctx);
        if (target) {
          enrollment.nextRunAt = target.getTime() > Date.now() ? target : new Date();
          pushLog(enrollment, {
            nodeId: ctx.waitNodeId || null,
            stepIndex: ctx.waitStepIndex ?? null,
            type: 'wait_until',
            info: `Cita reagendada: la espera se movió a ${fmtLogDate(enrollment.nextRunAt)}`,
          });
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
  }
}

// Etapas en las que el contacto YA hizo lo que la promoción perseguía: seguir
// ofreciéndole agendar es hablarle de algo que ya resolvió.
const BOOKED_STAGES = new Set(['agendado', 'ganado']);
// Margen para no matar lo que ESTE MISMO hecho acaba de arrancar. Agendar dispara
// a la vez el evento de la cita (que inscribe los flujos "cuando agenda una cita
// → mándale la preparación") y el cambio de etapa a 'agendado'. Los handlers del
// bus no se esperan unos a otros, así que sin este margen la parada podía cancelar
// la inscripción recién creada por su propio evento. Una promoción en curso lleva
// horas o días viva: un minuto la distingue de sobra.
const JUST_ENROLLED_MS = 60 * 1000;

/**
 * El contacto AGENDÓ (o compró) a mitad de una automatización: se detienen sus
 * flujos vivos para que no le sigan llegando los "¿te gustaría agendar?" que
 * quedaban por delante. Lo reportó la clínica en ago-2026: una promoción con
 * esperas de 15 h seguía su curso aunque el paciente ya tuviera la cita.
 *
 * SOLO reacciona al CAMBIO de etapa, nunca al estado: quien ya estaba agendado
 * ANTES de entrar al flujo no se toca — es justo el caso del recordatorio de
 * cita 24 h, que se manda precisamente a quien tiene cita. Y un flujo puede
 * excluirse con `stopOnBooking: false`.
 *
 * Tampoco toca lo que acaba de nacer de este mismo hecho (ver JUST_ENROLLED_MS):
 * agendar inscribe flujos de "cita agendada" en el mismo instante y no tendría
 * ningún sentido cancelarlos con el evento gemelo.
 */
async function cancelEnrollmentsOnBooking(payload = {}) {
  const stage = String(payload.stage || '').trim();
  if (!BOOKED_STAGES.has(stage)) return { cancelled: 0 };
  const phone = payload.phone ? messaging.normalizePhone(payload.phone) : '';
  const identity = [
    payload.conversationId ? { conversation: payload.conversationId } : null,
    payload.patientId ? { patient: payload.patientId } : null,
    phone ? { 'context.phone': phone } : null,
  ].filter(Boolean);
  if (!identity.length) return { cancelled: 0 };

  const enrollments = await WorkflowEnrollment.find({
    status: { $in: ['active', 'waiting'] },
    createdAt: { $lt: new Date(Date.now() - JUST_ENROLLED_MS) },
    $or: identity,
  });
  if (!enrollments.length) return { cancelled: 0 };

  // Flujos que piden expresamente seguir enviando aunque el contacto agende.
  const excluidos = new Set(
    (await Workflow.find({ _id: { $in: enrollments.map((e) => e.workflow) }, stopOnBooking: false })
      .select('_id')
      .lean()
    ).map((w) => String(w._id))
  );

  let cancelled = 0;
  for (const enrollment of enrollments) {
    if (excluidos.has(String(enrollment.workflow))) continue;
    // La inscripción que nació de ESTA etapa (flujo "cuando agenda → …") se queda.
    if (String(enrollment.context?.stage || '') === stage) continue;
    enrollment.status = 'cancelled';
    enrollment.waitingForReply = false;
    pushLog(enrollment, {
      nodeId: enrollment.currentNodeId,
      type: 'stop',
      info: `El contacto pasó a «${stage}»: la automatización se detiene para no seguir ofreciéndole algo que ya tiene. (Se desactiva por flujo con "seguir enviando aunque agende".)`,
    });
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
    cancelled += 1;
  }
  return { cancelled };
}

/**
 * Cita CANCELADA: una inscripción pausada en "esperar hasta la cita" enviaría el
 * recordatorio de una cita que ya no existe. Se anula y queda constancia en el log.
 * Solo toca inscripciones con el marcador de wait_until (no las que esperan
 * respuesta ni las de otros flujos del mismo paciente).
 */
async function cancelWaitingEnrollmentsForAppointment(payload = {}) {
  if (!payload.appointmentId) return;
  const enrollments = await WorkflowEnrollment.find({
    status: 'waiting',
    waitingForReply: false,
    'context.appointmentId': String(payload.appointmentId),
    $or: [
      { 'context.waitNodeId': { $exists: true, $ne: null } },
      { 'context.waitStepIndex': { $exists: true, $ne: null } },
    ],
  });
  for (const enrollment of enrollments) {
    enrollment.status = 'cancelled';
    pushLog(enrollment, {
      nodeId: enrollment.context?.waitNodeId || null,
      stepIndex: enrollment.context?.waitStepIndex ?? null,
      type: 'wait_until',
      info: 'Cita cancelada: se anuló la espera para no enviar un recordatorio obsoleto.',
    });
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
  }
}

/** Suscribe el motor al bus de eventos de dominio (llamar una vez al arrancar). */
function subscribeDomainEvents() {
  // Mantenimiento de esperas ligadas a la cita: ANTES de inscribir los flujos del
  // propio evento, para que un reagendamiento/cancelación no dispare recordatorios
  // con la fecha vieja ni deje esperas huérfanas.
  onDomainEvent(DOMAIN_EVENTS.APPOINTMENT_RESCHEDULED, (payload) => syncEnrollmentsForAppointment(payload));
  onDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CANCELLED, (payload) => cancelWaitingEnrollmentsForAppointment(payload));
  const map = {
    [DOMAIN_EVENTS.APPOINTMENT_CREATED]: 'appointment_created',
    [DOMAIN_EVENTS.APPOINTMENT_ATTENDED]: 'appointment_attended',
    [DOMAIN_EVENTS.APPOINTMENT_NO_SHOW]: 'appointment_no_show',
    [DOMAIN_EVENTS.APPOINTMENT_CANCELLED]: 'appointment_cancelled',
    [DOMAIN_EVENTS.APPOINTMENT_CONFIRMED]: 'appointment_confirmed',
    [DOMAIN_EVENTS.APPOINTMENT_RESCHEDULED]: 'appointment_rescheduled',
    [DOMAIN_EVENTS.TREATMENT_ABANDONED]: 'treatment_abandoned',
    [DOMAIN_EVENTS.PATIENT_BIRTHDAY]: 'patient_birthday',
    [DOMAIN_EVENTS.PATIENT_CREATED]: 'patient_created',
    [DOMAIN_EVENTS.SALE_CREATED]: 'sale_created',
    [DOMAIN_EVENTS.PAYMENT_RECEIVED]: 'payment_received',
    [DOMAIN_EVENTS.QUOTATION_SENT]: 'quotation_sent',
    [DOMAIN_EVENTS.TAG_ADDED]: 'tag_added',
  };
  Object.entries(map).forEach(([event, triggerType]) => {
    onDomainEvent(event, (payload) => enrollForEvent(triggerType, payload));
  });
  // Cambio de etapa de oportunidad (chat/Kanban): inscribe los flujos con trigger
  // 'opportunity_stage'. No pasa por enrollForEvent (necesita la conversación, no
  // el paciente) sino por su propio enrolador basado en el chat.
  // Antes de inscribir: se DETIENEN las promociones en curso del contacto que
  // acaba de agendar (los handlers del bus no se esperan entre sí, así que lo que
  // de verdad protege a la inscripción nueva es el margen de cancelEnrollmentsOnBooking).
  onDomainEvent(DOMAIN_EVENTS.OPPORTUNITY_STAGE_CHANGED, (payload) => cancelEnrollmentsOnBooking(payload));
  onDomainEvent(DOMAIN_EVENTS.OPPORTUNITY_STAGE_CHANGED, (payload) => enrollForOpportunityStage(payload));
}

module.exports = {
  classifyReply,
  computeWaitUntil,
  sendWindowHold,
  windowOfNode,
  evaluateCondition,
  evaluateSingleCondition,
  evaluateConditionGroup,
  branchesOf,
  matchBranch,
  applyOpportunityStage,
  applyOpportunity,
  keywordMatchesTrigger,
  getTriggers,
  triggersOfNode,
  matchingFlows,
  triggerMatchesEvent,
  pickRoundRobinAgent,
  personalize,
  renderText,
  executeEnrollment,
  executeGraphEnrollment,
  findStartNode,
  nextNodeId,
  nextNodeIdExact,
  pickSplitRoute,
  pickClinicRoute,
  enrollForEvent,
  enrollForChatMessage,
  enrollForOpportunityStage,
  processDueEnrollments,
  resumeOnReply,
  resumeOnButtonClick,
  syncEnrollmentsForAppointment,
  cancelWaitingEnrollmentsForAppointment,
  cancelEnrollmentsOnBooking,
  subscribeDomainEvents,
};
