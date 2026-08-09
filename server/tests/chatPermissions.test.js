/**
 * Permisos privados del chat asignado. Los chats libres pertenecen a la bandeja
 * compartida; al asignarlos, solo el responsable y los supervisores conservan acceso.
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

test('canReplyConversation: un asesor solo responde chats libres o asignados a él', () => {
  assert.equal(chatCtrl.canReplyConversation(ana, chatDeJaime), false);
  assert.equal(chatCtrl.canReplyConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(ana, chatSinAsignar), true);
  assert.equal(chatCtrl.canReplyConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canReplyConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (p. ej. doctor) no puede responder.
  assert.equal(chatCtrl.canReplyConversation(doctor, chatDeJaime), false);
});

test('canMutateConversation: la asignación también protege las acciones del chat', () => {
  assert.equal(chatCtrl.canMutateConversation(ana, chatDeJaime), false);
  assert.equal(chatCtrl.canMutateConversation(jaime, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(ana, chatSinAsignar), true);
  // Admin, marketing y super-admin siempre.
  assert.equal(chatCtrl.canMutateConversation(admin, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(marketing, chatDeJaime), true);
  assert.equal(chatCtrl.canMutateConversation(superadmin, chatDeJaime), true);
  // Un rol ajeno al CRM (doctor) sigue fuera.
  assert.equal(chatCtrl.canMutateConversation(doctor, chatDeJaime), false);
});
