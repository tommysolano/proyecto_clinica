const router = require('express').Router();
const ctrl = require('../controllers/chatController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// Webhook público (sin auth) — WhatsApp Business API
router.get('/webhook', ctrl.webhookVerify);
router.post('/webhook', ctrl.webhookReceive);

// El resto requiere auth + clínica
router.use(auth, requireClinic);

const CALL_CENTER_ROLES = ['admin', 'call_center', 'supervisor_call_center'];

router.get('/stats', requireRole(...CALL_CENTER_ROLES), ctrl.getStats);
router.get('/', requireRole(...CALL_CENTER_ROLES), ctrl.listConversations);
router.post('/', requireRole(...CALL_CENTER_ROLES), ctrl.createConversation);
router.post('/simulate', requireRole(...CALL_CENTER_ROLES), ctrl.simulateIncoming);

router.get('/:id', requireRole(...CALL_CENTER_ROLES), ctrl.getConversation);
router.put('/:id', requireRole(...CALL_CENTER_ROLES), ctrl.updateConversation);
router.post('/:id/assign', requireRole(...CALL_CENTER_ROLES), ctrl.assignConversation);
router.post('/:id/featured', requireRole(...CALL_CENTER_ROLES), ctrl.toggleFeatured);
router.post('/:id/opportunity', requireRole(...CALL_CENTER_ROLES), ctrl.setOpportunity);
router.delete('/:id/opportunity', requireRole(...CALL_CENTER_ROLES), ctrl.removeOpportunity);

router.get('/:id/messages', requireRole(...CALL_CENTER_ROLES), ctrl.listMessages);
router.post('/:id/messages', requireRole(...CALL_CENTER_ROLES), ctrl.sendMessage);

module.exports = router;
