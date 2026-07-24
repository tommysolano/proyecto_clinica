/**
 * Permisos del chat compartido del call center.
 *
 * Bug auditado: un agente veía el chat de un compañero (asignado a otro) y al
 * intentar ENVIAR texto recibía "No puedes enviar mensajes en esta conversación",
 * mientras que el dueño (admin) sí podía. No era un problema de "computadora":
 * enviar texto exigía tener el chat asignado (pero enviar imágenes no). Ahora
 * responder es de toda la bandeja.
 *
 * Evolución: administrar (crear/modificar/eliminar oportunidades, editar, destacar,
 * bloquear) TAMPOCO depende de la asignación. La asignación solo hace que el chat
 * aparezca en "mis chats asignados"; cualquier agente del CRM puede hacer todas las
 * acciones sobre cualquier chat. Solo los roles ajenos al CRM (doctor) quedan fuera.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const chatCtrl = require('../controllers/chatController');

const superadmin = { user: { _id: 'super', isSuperAdmin: true } };
const admin = { user: { _id: 'owner' }, role: 'admin' };
const marketing = { user: { _id: 'mkt' }, role: 'marketing' };
const jaime = { user: { _id: 'jaime' }, role: 'call_center' };
const ana = { user: { _id: 'ana' }, role: 'call_center' };
const doctor = { user: { _id: 'doc' }, role: 'doctor' };

const chatDeJaime = { assignedTo: 'jaime' };
const chatSinAsignar = { assignedTo: null };

test('canReplyConversation: cualquier agente del call center responde cualquier chat (bandeja compartida)', () => {
  // El caso del bug: Ana respondiendo el chat asignado a Jaime.
  assert.equal(chatCtrl.canReplyConversation(ana, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (p. ej. doctor) no puede responder.
  assert.equal(chatCtrl.canReplyConversation(doctor, chatDeJaime), false);
});

test('canMutateConversation: administrar es de toda la bandeja (la asignación NO es candado)', () => {
  // Ana SÍ puede administrar el chat de Jaime (crear/editar/borrar oportunidad, etc.),
  // aunque esté asignado a él: la asignación solo controla en qué lista aparece.
  assert.equal(chatCtrl.canMutateConversation(ana, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(ana, chatSinAsignar), true);
  // Admin, marketing y super-admin siempre.
  assert.equal(chatCtrl.canMutateConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (doctor) sigue fuera.
  assert.equal(chatCtrl.canMutateConversation(doctor, chatDeJaime), false);
});
