const mongoose = require('mongoose');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const AgentTask = require('../models/AgentTask');
const User = require('../models/User');
const ReviewRequest = require('../models/ReviewRequest');
const messaging = require('./messaging');
const { emitToClinic, emitToUser, emitToCallCenter } = require('../realtime');
const { DOMAIN_EVENTS, onDomainEvent } = require('./events');

const MAX_STEP_TRANSITIONS = 100; // guarda contra bucles por onFailGoTo mal formado
const MAX_LOG_ENTRIES = 60; // tope del registro de ejecución por inscripción

// Motivos por los que messaging.send salta/falla un envío, en lenguaje del usuario.
const SEND_FAIL_REASONS = {
  out_of_window: 'WhatsApp: fuera de la ventana de 24h (el paciente no ha escrito recientemente). Usa el paso "Enviar plantilla" con una plantilla aprobada.',
  provider_unavailable: 'Canal no disponible: no hay número de WhatsApp conectado/configurado.',
  invalid_recipient: 'El contacto no tiene un teléfono/destino válido ni una conversación previa de WhatsApp.',
  opt_out: 'El paciente pidió no recibir mensajes (opt-out).',
  no_whatsapp_consent: 'El paciente tiene desactivado el consentimiento de WhatsApp (ficha del paciente → Marketing).',
  no_email_consent: 'El paciente no aceptó recibir emails.',
  blocked: 'La conversación está bloqueada.',
  template_header_missing: 'La plantilla requiere una imagen/archivo de cabecera que no está guardado.',
  qr_not_connected: 'El número QR por el que saldría este mensaje está desconectado: reconéctalo en Configuración del Call Center.',
  qr_invalid_number: 'El teléfono del paciente no está en WhatsApp.',
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

// Fecha legible (hora Ecuador) para el registro de ejecución.
const fmtLogDate = (d) =>
  d.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Interpreta el resultado de messaging.send: null = éxito, string = motivo del fallo. */
function sendFailureInfo(result) {
  if (!result || result.ok) return null;
  const reason = result.reason || result.errorCode || 'error';
  return SEND_FAIL_REASONS[reason] || result.errorMessage || `No se pudo enviar (${reason}).`;
}

/**
 * Agente call_center con MENOS conversaciones abiertas asignadas (reparto
 * equitativo). Devuelve { _id, name } o null si no hay agentes.
 */
async function pickRoundRobinAgent(clinicId) {
  const agents = await User.find({
    active: true,
    'clinics.clinic': clinicId,
    'clinics.role': 'call_center',
  }).select('_id name');
  if (!agents.length) return null;
  const counts = await Conversation.aggregate([
    { $match: { clinic: new mongoose.Types.ObjectId(clinicId), status: 'open', assignedTo: { $ne: null } } },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);
  const byAgent = new Map(counts.map((c) => [String(c._id), c.count]));
  agents.sort((a, b) => (byAgent.get(String(a._id)) || 0) - (byAgent.get(String(b._id)) || 0));
  return agents[0];
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
 * Evalúa un predicado de condition/goal contra el paciente y la conversación.
 * PURO y testeable.
 */
function evaluateCondition(step, { patient, conversation, context } = {}) {
  const tags = patient?.tags || [];
  const stage = conversation?.opportunity?.stage || '';
  const source = patient?.source || '';
  const lastReply = context?.lastReply || '';
  const value = step.value;

  switch (step.field) {
    case 'tag':
      if (step.op === 'exists') return tags.length > 0;
      if (step.op === 'neq') return !tags.includes(value);
      return tags.includes(value); // eq / contains
    case 'stage':
      if (step.op === 'exists') return !!stage;
      if (step.op === 'neq') return stage !== value;
      return stage === value;
    case 'source':
      if (step.op === 'neq') return source !== value;
      return source === value;
    case 'lastReply':
      if (step.op === 'exists') return !!lastReply && lastReply !== 'other';
      if (step.op === 'neq') return lastReply !== value;
      return lastReply === value; // eq → 'yes' | 'no' | 'other'
    case 'hasPatient':
      return !!patient;
    default:
      return true;
  }
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
  return Conversation.findOne({ clinic: clinicId, phone: messaging.normalizePhone(phone) });
}

// ─────────── Ejecución de acciones (compartida por grafo) ───────────

/**
 * Ejecuta UNA acción de efecto secundario (no de control de flujo). La usa el
 * runner de grafo. `convRef` = { current } comparte la conversación cargada
 * perezosamente entre nodos. Replica la lógica del runner lineal.
 * Devuelve null si todo salió bien, o un string con el motivo del fallo (para
 * el registro de ejecución). Los errores inesperados se propagan (throw).
 */
async function performAction(step, { clinicId, patient, phone, ctx, convRef }) {
  const loadConv = async () => {
    if (!convRef.current) convRef.current = await loadConversationForPatient(clinicId, phone, patient?._id);
    return convRef.current;
  };
  switch (step.type) {
    case 'send_message': {
      // Se envía a la CONVERSACIÓN existente del paciente (imprescindible con
      // números ocultos/LID, donde el teléfono de la ficha no sirve de destino);
      // si no hay ninguna, messaging la crea a partir del teléfono.
      const r = await messaging.send({
        clinicId,
        channel: 'whatsapp',
        conversation: await loadConv(),
        to: phone,
        patient,
        body: personalize(step.body, patient),
        isAutoReply: true,
      });
      return sendFailureInfo(r);
    }
    case 'send_template': {
      // Sin vars posicionales: messaging rellena cada variable por su NOMBRE
      // (paciente + datos reales de la cita vía appointmentId del contexto).
      const r = await messaging.send({
        clinicId,
        channel: 'whatsapp',
        conversation: await loadConv(),
        to: phone,
        patient,
        template: { name: step.templateName, language: step.templateLanguage || 'es' },
        appointmentId: ctx.appointmentId || null,
        isAutoReply: true,
      });
      return sendFailureInfo(r);
    }
    case 'send_email': {
      const to = patient?.email;
      if (!to) return 'El paciente no tiene email registrado.';
      const r = await messaging.send({ clinicId, channel: 'email', to, patient, subject: personalize(step.emailSubject || 'Mensaje de tu clínica', patient), body: personalize(step.body, patient) });
      return sendFailureInfo(r);
    }
    case 'assign_agent': {
      const conversation = await loadConv();
      if (conversation) {
        let agent = null;
        if (step.assignMode === 'user' && step.assignUser) agent = await User.findById(step.assignUser).select('_id name');
        else agent = await pickRoundRobinAgent(clinicId);
        if (agent) {
          conversation.assignedTo = agent._id;
          conversation.assignedToName = agent.name;
          conversation.assignedAt = new Date();
          await conversation.save();
          emitToUser(agent._id, 'chat:assigned', { conversationId: conversation._id });
        }
      }
      break;
    }
    case 'create_task': {
      let assignTo = step.assignUser || null;
      if (!assignTo) { const a = await pickRoundRobinAgent(clinicId); assignTo = a?._id || null; }
      const offset = Number(step.taskDueOffsetMinutes || 0);
      const task = await AgentTask.create({
        clinic: clinicId,
        title: personalize(step.taskTitle || 'Tarea automática', patient),
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
      const token = ReviewRequest.newToken();
      await ReviewRequest.create({ clinic: clinicId, patient: patient?._id || null, appointment: ctx.appointmentId || null, conversation: convRef.current?._id || null, token, channel: 'whatsapp' });
      const base = process.env.PUBLIC_API_URL || '';
      const link = base ? `${base}/api/public/review/${token}` : '';
      const text = personalize(step.body || '¡Hola {{nombre}}! ¿Cómo fue tu experiencia con nosotros? Califícanos aquí:', patient);
      const r = await messaging.send({ clinicId, channel: 'whatsapp', conversation: await loadConv(), to: phone, patient, body: link ? `${text}\n${link}` : text, isAutoReply: true });
      return sendFailureInfo(r);
    }
    case 'ai_reply': {
      const conversation = await loadConv();
      if (!conversation) return 'No hay conversación abierta con el paciente para responder con IA.';
      const { suggestReply } = require('./aiAssistant');
      const r = await suggestReply({ clinicId, conversationId: conversation._id });
      if (r.ok && r.suggestion) {
        const sent = await messaging.send({ clinicId, channel: conversation.channel || 'whatsapp', to: phone, patient, conversation, body: r.suggestion, isAutoReply: true });
        return sendFailureInfo(sent);
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
      if (step.stage) {
        const conversation = await loadConv();
        if (conversation) {
          conversation.opportunity = { ...(conversation.opportunity?.toObject ? conversation.opportunity.toObject() : conversation.opportunity || {}), isOpportunity: true, stage: step.stage };
          await conversation.save();
        }
      }
      break;
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

/**
 * Ejecuta una inscripción de un workflow de GRAFO recorriendo aristas desde
 * `enrollment.currentNodeId` (o desde el nodo inicial). Las condiciones bifurcan
 * por las aristas 'yes'/'no'. Persiste el estado en cada espera.
 */
async function executeGraphEnrollment(enrollment, workflow, patient, { phone, ctx, conversation }) {
  const convRef = { current: conversation };
  let currentId = enrollment.currentNodeId;
  if (!currentId) {
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
    } else if (type === 'wait_reply') {
      enrollment.currentNodeId = nextNodeId(workflow, currentId);
      enrollment.nextRunAt = new Date(Date.now() + Number(data.timeoutMinutes || 720) * 60000);
      enrollment.status = 'waiting';
      enrollment.waitingForReply = true;
      enrollment.markModified('context');
      await enrollment.save();
      return;
    } else if (type === 'condition') {
      const pass = evaluateCondition(data, { patient, conversation: convRef.current, context: ctx });
      pushLog(enrollment, { nodeId: currentId, type, info: pass ? 'Rama Sí' : 'Rama No' });
      currentId = nextNodeId(workflow, currentId, pass ? 'yes' : 'no');
    } else if (type === 'goal') {
      if (evaluateCondition(data, { patient, conversation: convRef.current, context: ctx })) {
        pushLog(enrollment, { nodeId: currentId, type, info: 'Objetivo cumplido: fin del flujo' });
        break;
      }
      currentId = nextNodeId(workflow, currentId);
    } else {
      // Un paso que falla NO aborta el flujo: se registra y se continúa. Así un
      // envío saltado (ventana 24h, sin teléfono) queda visible en el registro.
      try {
        // eslint-disable-next-line no-await-in-loop
        const fail = await performAction({ ...data, type }, { clinicId: enrollment.clinic, patient, phone, ctx, convRef });
        pushLog(enrollment, { nodeId: currentId, type, ok: !fail, info: fail || '' });
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
  let conversation = await loadConversationForPatient(enrollment.clinic, phone, patient?._id);

  // Estamos ejecutando activamente: ya no esperamos respuesta (se reactivará si
  // un próximo paso wait_reply vuelve a pausar).
  enrollment.waitingForReply = false;

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

    if (step.type === 'send_message') {
      // eslint-disable-next-line no-await-in-loop
      const r = await messaging.send({
        clinicId: enrollment.clinic,
        channel: 'whatsapp',
        conversation,
        to: phone,
        patient,
        body: personalize(step.body, patient),
        isAutoReply: true,
      });
      const fail = sendFailureInfo(r);
      pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail || '' });
      i++;
    } else if (step.type === 'send_template') {
      // eslint-disable-next-line no-await-in-loop
      const r = await messaging.send({
        clinicId: enrollment.clinic,
        channel: 'whatsapp',
        conversation,
        to: phone,
        patient,
        template: { name: step.templateName, language: step.templateLanguage || 'es' },
        appointmentId: ctx.appointmentId || null,
        isAutoReply: true,
      });
      const fail = sendFailureInfo(r);
      pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail || '' });
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
          subject: personalize(step.emailSubject || 'Mensaje de tu clínica', patient),
          body: personalize(step.body, patient),
        });
        const fail = sendFailureInfo(r);
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: !fail, info: fail || '' });
      } else {
        pushLog(enrollment, { stepIndex: i, type: step.type, ok: false, info: 'El paciente no tiene email registrado.' });
      }
      i++;
    } else if (step.type === 'assign_agent') {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone);
      if (conversation) {
        let agent = null;
        if (step.assignMode === 'user' && step.assignUser) {
          // eslint-disable-next-line no-await-in-loop
          agent = await User.findById(step.assignUser).select('_id name');
        } else {
          // eslint-disable-next-line no-await-in-loop
          agent = await pickRoundRobinAgent(enrollment.clinic);
        }
        if (agent) {
          conversation.assignedTo = agent._id;
          conversation.assignedToName = agent.name;
          conversation.assignedAt = new Date();
          // eslint-disable-next-line no-await-in-loop
          await conversation.save();
          emitToUser(agent._id, 'chat:assigned', { conversationId: conversation._id });
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
        title: personalize(step.taskTitle || 'Tarea automática', patient),
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
      const token = ReviewRequest.newToken();
      // eslint-disable-next-line no-await-in-loop
      await ReviewRequest.create({
        clinic: enrollment.clinic,
        patient: patient?._id || null,
        appointment: ctx.appointmentId || null,
        conversation: conversation?._id || null,
        token,
        channel: 'whatsapp',
      });
      const base = process.env.PUBLIC_API_URL || '';
      const link = base ? `${base}/api/public/review/${token}` : '';
      const text = personalize(
        step.body || '¡Hola {{nombre}}! ¿Cómo fue tu experiencia con nosotros? Califícanos aquí:',
        patient
      );
      // eslint-disable-next-line no-await-in-loop
      await messaging.send({
        clinicId: enrollment.clinic,
        channel: 'whatsapp',
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
    } else if (step.type === 'add_tag' && step.tag && patient) {
      // eslint-disable-next-line no-await-in-loop
      await applyTag(patient, conversation, step.tag);
      i++;
    } else if (step.type === 'remove_tag' && step.tag && patient) {
      // eslint-disable-next-line no-await-in-loop
      await applyTag(patient, conversation, step.tag, { remove: true });
      i++;
    } else if (step.type === 'move_stage' && step.stage) {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone, patient?._id);
      if (conversation) {
        conversation.opportunity = {
          ...(conversation.opportunity?.toObject ? conversation.opportunity.toObject() : conversation.opportunity || {}),
          isOpportunity: true,
          stage: step.stage,
        };
        // eslint-disable-next-line no-await-in-loop
        await conversation.save();
      }
      i++;
    } else {
      i++; // paso desconocido → saltar
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

  for (const wf of workflows) {
    // Un workflow puede tener varios flujos (nodos trigger) independientes; cada
    // flujo cuyo disparador coincida se inscribe por separado.
    const flows = matchingFlows(wf, (tr) => triggerMatchesEvent(tr, eventType, payload, services));
    if (!flows.length) {
      trace(
        wf,
        'no_match',
        'El evento ocurrió pero el disparador no coincidió: revisa la audiencia ("solo pacientes nuevos/existentes") o el filtro de servicio del nodo disparador.'
      );
      continue;
    }
    for (const flow of flows) {
      // Anti-duplicado: una inscripción viva por (workflow, paciente, flujo).
      // OJO: en eventos de CITA el duplicado es por cita (context.appointmentId):
      // cada cita nueva debe generar su propio recordatorio/confirmación aunque
      // haya otra inscripción viva de una cita anterior (antes se saltaba en
      // silencio y "agendé 3 citas y no llegó nada").
      const dedup = {
        workflow: wf._id,
        patient: patient._id,
        startNodeId: flow.startNodeId,
        status: { $in: ['active', 'waiting'] },
      };
      if (payload.appointmentId) dedup['context.appointmentId'] = String(payload.appointmentId);
      // eslint-disable-next-line no-await-in-loop
      const existing = await WorkflowEnrollment.findOne(dedup);
      if (existing) {
        trace(
          wf,
          'skipped_duplicate',
          payload.appointmentId
            ? 'Esta misma cita ya tiene una inscripción viva en este flujo; no se crea otra.'
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

  const matchesChat = (tr) => {
    if (!tr || !types.includes(tr.type)) return false;
    if (tr.type === 'new_conversation' && !isNew) return false;
    if (tr.type === 'keyword' && !keywordMatchesTrigger(tr, text)) return false;
    if (tr.type === 'ctwa_ad') {
      if (!msgAdId) return false; // este mensaje no vino de un anuncio
      const wanted = String(tr.adFilter || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (wanted.length && !wanted.includes(msgAdId)) return false;
    }
    // Audiencia: new = sin paciente vinculado, existing = con paciente.
    if (tr.audience === 'new' && patient) return false;
    if (tr.audience === 'existing' && !patient) return false;
    return true;
  };

  const destPhone = phone || conversation.phone || '';
  let enrolled = 0;
  for (const wf of workflows) {
    // Cada flujo (nodo trigger) de chat que coincida se inscribe por separado.
    const flows = matchingFlows(wf, matchesChat);
    for (const flow of flows) {
      // Anti-duplicado: una inscripción viva por (workflow, conversación, flujo).
      // eslint-disable-next-line no-await-in-loop
      const existing = await WorkflowEnrollment.findOne({
        workflow: wf._id,
        conversation: conversation._id,
        startNodeId: flow.startNodeId,
        status: { $in: ['active', 'waiting'] },
      });
      if (existing) continue;

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
      // eslint-disable-next-line no-await-in-loop
      await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
      // eslint-disable-next-line no-await-in-loop
      await executeEnrollment(enrollment).catch((err) =>
        console.error('[workflowEngine] chat enrollment error', enrollment._id, err.message)
      );
      enrolled++;
    }
  }
  return { enrolled };
}

/**
 * Job: reanuda inscripciones cuya espera ya venció. Recupera además las que
 * quedaron atascadas en 'active' (p.ej. si el proceso murió o un paso lanzó un
 * error a mitad de ejecución): tras 5 min sin avanzar se reintenta.
 */
async function processDueEnrollments() {
  const due = await WorkflowEnrollment.find({
    $or: [
      { status: 'waiting', nextRunAt: { $lte: new Date() } },
      { status: 'active', updatedAt: { $lte: new Date(Date.now() - 5 * 60000) } },
    ],
  })
    .sort({ nextRunAt: 1 })
    .limit(100);
  for (const enrollment of due) {
    // eslint-disable-next-line no-await-in-loop
    await executeEnrollment(enrollment).catch((err) => {
      console.error('[workflowEngine] enrollment error', enrollment._id, err.message);
    });
  }
  return { processed: due.length };
}

/**
 * Reanuda las inscripciones que esperaban respuesta del paciente cuando llega un
 * mensaje entrante. Clasifica la respuesta (yes/no/other) en el contexto para que
 * los pasos `condition` posteriores puedan ramificar.
 * Lo invoca el ingest de mensajes entrantes (chatController).
 */
async function resumeOnReply({ clinicId, patientId, phone, text }) {
  const q = { clinic: clinicId, status: 'waiting', waitingForReply: true };
  if (patientId) q.patient = patientId;
  else if (phone) q['context.phone'] = messaging.normalizePhone(phone);
  else return { resumed: 0 };

  const enrollments = await WorkflowEnrollment.find(q);
  if (!enrollments.length) return { resumed: 0 };

  const reply = classifyReply(text);
  for (const enrollment of enrollments) {
    enrollment.context = {
      ...(enrollment.context || {}),
      lastReply: reply,
      lastReplyText: String(text || '').slice(0, 200),
    };
    enrollment.markModified('context');
    enrollment.waitingForReply = false;
    enrollment.status = 'active';
    enrollment.nextRunAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await enrollment.save();
    // eslint-disable-next-line no-await-in-loop
    await executeEnrollment(enrollment).catch((err) =>
      console.error('[workflowEngine] resume error', enrollment._id, err.message)
    );
  }
  return { resumed: enrollments.length };
}

/** Suscribe el motor al bus de eventos de dominio (llamar una vez al arrancar). */
function subscribeDomainEvents() {
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
}

module.exports = {
  classifyReply,
  computeWaitUntil,
  evaluateCondition,
  keywordMatchesTrigger,
  getTriggers,
  triggersOfNode,
  matchingFlows,
  triggerMatchesEvent,
  pickRoundRobinAgent,
  personalize,
  executeEnrollment,
  executeGraphEnrollment,
  findStartNode,
  nextNodeId,
  enrollForEvent,
  enrollForChatMessage,
  processDueEnrollments,
  resumeOnReply,
  subscribeDomainEvents,
};
