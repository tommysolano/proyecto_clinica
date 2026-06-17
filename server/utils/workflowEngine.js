const mongoose = require('mongoose');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const messaging = require('./messaging');
const { DOMAIN_EVENTS, onDomainEvent } = require('./events');

const MAX_STEP_TRANSITIONS = 100; // guarda contra bucles por onFailGoTo mal formado

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
    return new Date(base.getTime() + Number(step.offsetMinutes || 0) * 60000);
  }
  return null;
}

/**
 * Evalúa un predicado de condition/goal contra el paciente y la conversación.
 * PURO y testeable.
 */
function evaluateCondition(step, { patient, conversation } = {}) {
  const tags = patient?.tags || [];
  const stage = conversation?.opportunity?.stage || '';
  const source = patient?.source || '';
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
    case 'hasPatient':
      return !!patient;
    default:
      return true;
  }
}

async function loadConversationForPatient(clinicId, phone) {
  if (!phone) return null;
  return Conversation.findOne({ clinic: clinicId, phone: messaging.normalizePhone(phone) });
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
    ? await Patient.findOne({ _id: enrollment.patient, clinic: enrollment.clinic })
    : null;
  const ctx = enrollment.context || {};
  const phone = ctx.phone || patient?.whatsapp || patient?.phone || '';
  let conversation = await loadConversationForPatient(enrollment.clinic, phone);

  let i = enrollment.stepIndex;
  let transitions = 0;
  const now = new Date();

  while (i < workflow.steps.length) {
    if (++transitions > MAX_STEP_TRANSITIONS) break;
    const step = workflow.steps[i];

    if (step.type === 'send_message') {
      // eslint-disable-next-line no-await-in-loop
      await messaging.send({
        clinicId: enrollment.clinic,
        channel: 'whatsapp',
        to: phone,
        patient,
        body: personalize(step.body, patient),
        isAutoReply: true,
      });
      i++;
    } else if (step.type === 'send_template') {
      // eslint-disable-next-line no-await-in-loop
      await messaging.send({
        clinicId: enrollment.clinic,
        channel: 'whatsapp',
        to: phone,
        patient,
        template: { name: step.templateName, language: step.templateLanguage || 'es', vars: [firstNameOf(patient)] },
        isAutoReply: true,
      });
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
        enrollment.stepIndex = i + 1;
        enrollment.nextRunAt = target;
        enrollment.status = 'waiting';
        await enrollment.save();
        return;
      }
      i++; // fecha ya pasada → continuar
    } else if (step.type === 'condition') {
      const pass = evaluateCondition(step, { patient, conversation });
      if (pass) {
        i++;
      } else if (step.onFailGoTo != null && step.onFailGoTo >= 0) {
        i = step.onFailGoTo;
      } else {
        break; // termina
      }
    } else if (step.type === 'goal') {
      if (evaluateCondition(step, { patient, conversation })) break; // objetivo cumplido → fin
      i++;
    } else if (step.type === 'add_tag' && step.tag && patient) {
      if (!patient.tags.includes(step.tag)) {
        patient.tags.push(step.tag);
        // eslint-disable-next-line no-await-in-loop
        await patient.save();
      }
      i++;
    } else if (step.type === 'remove_tag' && step.tag && patient) {
      patient.tags = (patient.tags || []).filter((t) => t !== step.tag);
      // eslint-disable-next-line no-await-in-loop
      await patient.save();
      i++;
    } else if (step.type === 'move_stage' && step.stage) {
      if (!conversation) conversation = await loadConversationForPatient(enrollment.clinic, phone);
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
  const { clinicId, patientId } = payload;
  if (!clinicId || !patientId) return;
  const workflows = await Workflow.find({ clinic: clinicId, active: true, 'trigger.type': eventType });
  if (!workflows.length) return;

  const patient = await Patient.findOne({ _id: patientId, clinic: clinicId });
  if (!patient) return;
  const phone = patient.whatsapp || patient.phone || '';
  if (!phone) return;

  const services = (payload.services || []).map((s) => String(s));

  for (const wf of workflows) {
    const tr = wf.trigger || {};
    // Filtro de audiencia (eventos de cita).
    if (tr.audience === 'new' && !payload.isFirstVisit) continue;
    if (tr.audience === 'existing' && payload.isFirstVisit) continue;
    // Filtro por servicio.
    if (tr.serviceFilter && !services.includes(String(tr.serviceFilter))) continue;

    // Anti-duplicado: ¿ya hay una inscripción viva para este paciente?
    // eslint-disable-next-line no-await-in-loop
    const existing = await WorkflowEnrollment.findOne({
      workflow: wf._id,
      patient: patient._id,
      status: { $in: ['active', 'waiting'] },
    });
    if (existing) continue;

    let enrollment;
    try {
      // eslint-disable-next-line no-await-in-loop
      enrollment = await WorkflowEnrollment.create({
        clinic: clinicId,
        workflow: wf._id,
        patient: patient._id,
        stepIndex: 0,
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
    // eslint-disable-next-line no-await-in-loop
    await Workflow.updateOne({ _id: wf._id }, { $inc: { 'stats.enrolled': 1 } });
    // eslint-disable-next-line no-await-in-loop
    await executeEnrollment(enrollment);
  }
}

/** Job: reanuda inscripciones cuya espera ya venció. */
async function processDueEnrollments() {
  const due = await WorkflowEnrollment.find({ status: 'waiting', nextRunAt: { $lte: new Date() } })
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

/** Suscribe el motor al bus de eventos de dominio (llamar una vez al arrancar). */
function subscribeDomainEvents() {
  const map = {
    [DOMAIN_EVENTS.APPOINTMENT_CREATED]: 'appointment_created',
    [DOMAIN_EVENTS.APPOINTMENT_ATTENDED]: 'appointment_attended',
    [DOMAIN_EVENTS.APPOINTMENT_NO_SHOW]: 'appointment_no_show',
    [DOMAIN_EVENTS.TREATMENT_ABANDONED]: 'treatment_abandoned',
    [DOMAIN_EVENTS.PATIENT_BIRTHDAY]: 'patient_birthday',
  };
  Object.entries(map).forEach(([event, triggerType]) => {
    onDomainEvent(event, (payload) => enrollForEvent(triggerType, payload));
  });
}

module.exports = {
  computeWaitUntil,
  evaluateCondition,
  personalize,
  executeEnrollment,
  enrollForEvent,
  processDueEnrollments,
  subscribeDomainEvents,
};
