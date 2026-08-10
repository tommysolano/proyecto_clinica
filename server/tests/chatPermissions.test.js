/**
 * La asignacion operativa sigue compartida. Solo el candado independiente que
 * crea un workflow para un asesor especifico restringe el chat.
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
const chatPrivadoDeJaime = { assignedTo: 'jaime', workflowRestrictedTo: 'jaime' };
const chatDeJaimeFueraDeTurno = {
  assignedTo: 'jaime',
  workflowRestrictedTo: 'jaime',
  workflowRestrictionActive: false,
};
const chatSinAsignar = { assignedTo: null };

test('canReplyConversation: la asignacion normal es compartida y la de workflow especifico es privada', () => {
  assert.equal(chatCtrl.canReplyConversation(ana, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(ana, chatPrivadoDeJaime), false);
  assert.equal(chatCtrl.canReplyConversation(jaime, chatPrivadoDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(ana, chatDeJaimeFueraDeTurno), true);
  assert.equal(chatCtrl.canReplyConversation(jaime, chatDeJaimeFueraDeTurno), false);
  assert.equal(chatCtrl.canReplyConversation(ana, chatSinAsignar), true);
  assert.equal(chatCtrl.canReplyConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (p. ej. doctor) no puede responder.
  assert.equal(chatCtrl.canReplyConversation(doctor, chatDeJaime), false);
});

test('canMutateConversation: solo la restriccion del workflow protege las acciones', () => {
  assert.equal(chatCtrl.canMutateConversation(ana, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(ana, chatPrivadoDeJaime), false);
  assert.equal(chatCtrl.canMutateConversation(jaime, chatPrivadoDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(ana, chatDeJaimeFueraDeTurno), true);
  assert.equal(chatCtrl.canMutateConversation(jaime, chatDeJaimeFueraDeTurno), false);
  assert.equal(chatCtrl.canMutateConversation(ana, chatSinAsignar), true);
  // Admin, marketing y super-admin siempre.
  assert.equal(chatCtrl.canMutateConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (doctor) sigue fuera.
  assert.equal(chatCtrl.canMutateConversation(doctor, chatDeJaime), false);
});
