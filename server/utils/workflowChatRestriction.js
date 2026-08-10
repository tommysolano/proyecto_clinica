/**
 * Privacidad temporal de los chats asignados a un asesor especifico desde un
 * workflow.
 *
 * `workflowRestrictedTo` identifica de forma permanente al responsable. Este
 * modulo materializa en `workflowRestrictionActive` si SU horario esta activo en
 * este instante:
 *
 *   - en turno: solo responsable + marketing/admin;
 *   - fuera de turno: todos los DEMAS call center + marketing/admin.
 *
 * No se borra la asignacion al salir: al entrar en la siguiente franja el chat se
 * vuelve a reservar automaticamente para el mismo asesor.
 */
const Conversation = require('../models/Conversation');
const User = require('../models/User');
const { isWorkingAt } = require('./agentSchedule');

const ownerIdOf = (conv) => conv?.workflowRestrictedTo?._id || conv?.workflowRestrictedTo || null;

function restrictionIsActive(conv) {
  return !!ownerIdOf(conv) && conv?.workflowRestrictionActive !== false;
}

function agentKeepsExclusiveQueue(agent, at = new Date()) {
  if (!agent?.active) return false;
  const stillCallCenter = (agent.clinics || []).some((entry) => entry?.role === 'call_center');
  return stillCallCenter && isWorkingAt(agent.callCenterSchedule, at);
}

function applyAgentRestrictionState(conversation, agent, at = new Date()) {
  const owner = ownerIdOf(conversation);
  const active = !!owner && agentKeepsExclusiveQueue(agent, at);
  conversation.workflowRestrictionActive = active;
  return active;
}

/**
 * Recalcula los chats de uno o todos los asesores y avisa a las bandejas que
 * deben agregarlos/retirarlos. Es idempotente: solo escribe y emite al cruzar una
 * frontera del horario.
 */
async function syncWorkflowChatRestrictions({ agentId = null, at = new Date(), emit = true } = {}) {
  const rawOwners = agentId
    ? [agentId]
    : await Conversation.distinct('workflowRestrictedTo', { workflowRestrictedTo: { $ne: null } });
  const ownerIds = [...new Set(rawOwners.map(String).filter(Boolean))];
  if (!ownerIds.length) return { owners: 0, changed: 0 };

  const agents = await User.find({ _id: { $in: ownerIds } })
    .select('_id active clinics callCenterSchedule')
    .lean();
  const byId = new Map(agents.map((agent) => [String(agent._id), agent]));
  let changed = 0;

  for (const ownerId of ownerIds) {
    const active = agentKeepsExclusiveQueue(byId.get(ownerId), at);
    // `$ne` incluye los documentos antiguos que aun no tienen el campo.
    // eslint-disable-next-line no-await-in-loop
    const conversations = await Conversation.find({
      workflowRestrictedTo: ownerId,
      workflowRestrictionActive: { $ne: active },
    }).select('_id assignedTo assignedToName');
    if (!conversations.length) continue;

    const ids = conversations.map((conv) => conv._id);
    // eslint-disable-next-line no-await-in-loop
    await Conversation.updateMany(
      { _id: { $in: ids } },
      { $set: { workflowRestrictionActive: active } }
    );
    changed += ids.length;

    if (emit) {
      const { emitChatAssignment } = require('../realtime');
      for (const conv of conversations) {
        emitChatAssignment({
          conversationId: conv._id,
          assignedTo: conv.assignedTo,
          assignedToName: conv.assignedToName,
          restrictedTo: ownerId,
          restrictionActive: active,
        });
      }
    }
  }

  return { owners: ownerIds.length, changed };
}

module.exports = {
  ownerIdOf,
  restrictionIsActive,
  agentKeepsExclusiveQueue,
  applyAgentRestrictionState,
  syncWorkflowChatRestrictions,
};
