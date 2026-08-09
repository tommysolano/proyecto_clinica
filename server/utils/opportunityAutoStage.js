/**
 * AGENDAR UNA CITA MUEVE LA OPORTUNIDAD A "AGENDADO", se agende donde se agende.
 *
 * Hasta ahora eso solo pasaba al agendar DESDE EL CHAT. Una cita creada desde el
 * calendario, desde la ficha del paciente o por la reserva online dejaba la
 * oportunidad donde estaba ('interesado', 'contactado'…), así que el embudo
 * contaba menos "agendados" de los que había de verdad y los flujos con condición
 * "etapa = agendado" no se cumplían para esos pacientes. Es el mismo hecho de
 * negocio; el sitio desde el que se teclea la cita no debería cambiarlo.
 *
 * REGLAS, a propósito conservadoras:
 *  - Solo se MUEVEN oportunidades que ya existen. No se inventa una oportunidad
 *    por cada cita: el embudo es de captación, no la agenda del día — un paciente
 *    de control que nunca fue un lead no tiene por qué aparecer ahí.
 *  - No se tocan las CERRADAS ('ganado' / 'perdido'): una venta ya cerrada no
 *    retrocede a 'agendado' porque el paciente pida otra cita.
 *  - Es idempotente: la cita creada desde el chat ya la movió, y aquí la etapa ya
 *    coincide, así que no se vuelve a disparar el workflow.
 */
const { DOMAIN_EVENTS, onDomainEvent } = require('./events');
const opportunities = require('./opportunities');

const CLOSED = new Set(['ganado', 'perdido']);

/**
 * Chat del paciente al que pertenece la cita. Se prefiere el de la MISMA sede y,
 * dentro de esa, el de actividad más reciente (un paciente puede tener chat en
 * varias sedes).
 */
async function findConversationForPatient(patientId, clinicId) {
  const Conversation = require('../models/Conversation');
  const convs = await Conversation.find({ patient: patientId }).sort({ lastMessageAt: -1 }).limit(10);
  if (!convs.length) return null;
  const sameClinic = convs.find((c) => String(c.clinic) === String(clinicId));
  return sameClinic || convs[0];
}

async function markScheduled(payload = {}) {
  const { patientId, clinicId, appointmentId } = payload;
  if (!patientId || !clinicId) return { moved: false };
  const conv = await findConversationForPatient(patientId, clinicId);
  if (!conv) return { moved: false };

  const list = opportunities.opportunitiesOf(conv);
  if (!list.length) return { moved: false }; // sin oportunidad: no se inventa ninguna
  const primary = list[list.length - 1];
  if (CLOSED.has(String(primary.stage || ''))) return { moved: false };
  if (String(primary.stage || '') === 'agendado') return { moved: false };

  const result = opportunities.applyStage(conv, 'agendado', { appointment: appointmentId || null });
  if (!result.changed) return { moved: false };
  await conv.save();
  await opportunities.announceStageResult(
    conv,
    result,
    opportunities.systemActor('cita agendada')
  );

  try {
    require('../realtime').emitToCallCenter('chat:opportunity', { conversationId: conv._id });
  } catch {
    /* realtime opcional */
  }
  // Mismo evento de dominio que mover la etapa a mano: los flujos "cuando entra a
  // la etapa agendado" se disparan igual venga la cita de donde venga.
  try {
    require('./events').emitDomainEvent(DOMAIN_EVENTS.OPPORTUNITY_STAGE_CHANGED, {
      clinicId: String(conv.clinic),
      conversationId: String(conv._id),
      patientId: String(patientId),
      phone: conv.phone || '',
      stage: 'agendado',
    });
  } catch {
    /* la emisión nunca debe romper el guardado */
  }
  return { moved: true, conversationId: String(conv._id) };
}

/** Se registra una sola vez al arrancar (index.js). */
function subscribeDomainEvents() {
  onDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, (payload) =>
    markScheduled(payload).catch((err) =>
      console.error('[opportunityAutoStage] cita → agendado:', err.message)
    )
  );
}

module.exports = { markScheduled, subscribeDomainEvents };
