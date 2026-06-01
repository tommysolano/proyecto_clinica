const router = require('express').Router();
const ctrl = require('../controllers/chatController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// Webhook público (sin auth) — WhatsApp Business API (legacy / dev)
router.get('/webhook', ctrl.webhookVerify);
router.post('/webhook', ctrl.webhookReceive);

// Webhooks por canal con clinicId en URL (sin auth — los invoca Meta/TikTok).
router.get('/webhook/whatsapp/:clinicId', ctrl.webhookWhatsappVerify);
router.post('/webhook/whatsapp/:clinicId', ctrl.webhookWhatsappReceive);
router.get('/webhook/messenger/:clinicId', ctrl.webhookMessengerVerify);
router.post('/webhook/messenger/:clinicId', ctrl.webhookMessengerReceive);
router.get('/webhook/instagram/:clinicId', ctrl.webhookInstagramVerify);
router.post('/webhook/instagram/:clinicId', ctrl.webhookInstagramReceive);
router.get('/webhook/tiktok/:clinicId', ctrl.webhookTiktokVerify);
router.post('/webhook/tiktok/:clinicId', ctrl.webhookTiktokReceive);

// El resto requiere auth + clínica
router.use(auth, requireClinic);

const CALL_CENTER_ROLES = ['admin', 'call_center', 'marketing'];

// IMPORTANTE: rutas específicas ANTES de las paramétricas (/:id/...)
router.get('/stats', requireRole(...CALL_CENTER_ROLES), ctrl.getStats);

// Mensajes guardados (canned/saved replies)
router.get('/saved-replies', requireRole(...CALL_CENTER_ROLES), ctrl.listSavedReplies);
router.post('/saved-replies', requireRole(...CALL_CENTER_ROLES), ctrl.createSavedReply);
router.put('/saved-replies/:id', requireRole(...CALL_CENTER_ROLES), ctrl.updateSavedReply);
router.delete('/saved-replies/:id', requireRole(...CALL_CENTER_ROLES), ctrl.deleteSavedReply);

// Mensajes automáticos (legacy)
router.get('/auto-messages', requireRole(...CALL_CENTER_ROLES), ctrl.listAutoMessages);
router.post('/auto-messages', requireRole(...CALL_CENTER_ROLES), ctrl.createAutoMessage);
router.put('/auto-messages/:id', requireRole(...CALL_CENTER_ROLES), ctrl.updateAutoMessage);
router.delete('/auto-messages/:id', requireRole(...CALL_CENTER_ROLES), ctrl.deleteAutoMessage);

// Flujos de mensajes (carpetas + flujos con pasos)
const flowCtrl = require('../controllers/flowController');
router.get('/flow-folders', requireRole(...CALL_CENTER_ROLES), flowCtrl.listFolders);
router.post('/flow-folders', requireRole(...CALL_CENTER_ROLES), flowCtrl.createFolder);
router.put('/flow-folders/:id', requireRole(...CALL_CENTER_ROLES), flowCtrl.renameFolder);
router.delete('/flow-folders/:id', requireRole(...CALL_CENTER_ROLES), flowCtrl.deleteFolder);
router.get('/flows', requireRole(...CALL_CENTER_ROLES), flowCtrl.listFlows);
router.post('/flows', requireRole(...CALL_CENTER_ROLES), flowCtrl.createFlow);
router.get('/flows/:id', requireRole(...CALL_CENTER_ROLES), flowCtrl.getFlow);
router.put('/flows/:id', requireRole(...CALL_CENTER_ROLES), flowCtrl.updateFlow);
router.delete('/flows/:id', requireRole(...CALL_CENTER_ROLES), flowCtrl.deleteFlow);

// Galería de imágenes
router.get('/gallery', requireRole(...CALL_CENTER_ROLES), ctrl.listGallery);
router.post('/gallery', requireRole(...CALL_CENTER_ROLES), ctrl.uploadGallery);
router.delete('/gallery/:id', requireRole(...CALL_CENTER_ROLES), ctrl.deleteGalleryItem);

// Vista global de oportunidades
router.get('/opportunities/all', requireRole(...CALL_CENTER_ROLES), ctrl.listAllOpportunities);
router.post('/opportunities/bulk-whatsapp', requireRole(...CALL_CENTER_ROLES), ctrl.bulkWhatsappOpportunities);

router.get('/', requireRole(...CALL_CENTER_ROLES), ctrl.listConversations);
router.post('/', requireRole(...CALL_CENTER_ROLES), ctrl.createConversation);
router.post('/simulate', requireRole(...CALL_CENTER_ROLES), ctrl.simulateIncoming);

router.get('/:id', requireRole(...CALL_CENTER_ROLES), ctrl.getConversation);
router.put('/:id', requireRole(...CALL_CENTER_ROLES), ctrl.updateConversation);
router.post('/:id/assign', requireRole(...CALL_CENTER_ROLES), ctrl.assignConversation);
router.post('/:id/featured', requireRole(...CALL_CENTER_ROLES), ctrl.toggleFeatured);
router.post('/:id/block', requireRole(...CALL_CENTER_ROLES), ctrl.toggleBlocked);
router.post('/:id/opportunity', requireRole(...CALL_CENTER_ROLES), ctrl.setOpportunity);
router.delete('/:id/opportunity', requireRole(...CALL_CENTER_ROLES), ctrl.removeOpportunity);
router.post('/:id/opportunities', requireRole(...CALL_CENTER_ROLES), ctrl.addOpportunity);
router.put('/:id/opportunities/:idx', requireRole(...CALL_CENTER_ROLES), ctrl.updateOpportunityAt);
router.delete('/:id/opportunities/:idx', requireRole(...CALL_CENTER_ROLES), ctrl.removeOpportunityAt);

router.get('/:id/messages', requireRole(...CALL_CENTER_ROLES), ctrl.listMessages);
router.post('/:id/messages', requireRole(...CALL_CENTER_ROLES), ctrl.sendMessage);
router.post('/:id/send-image', requireRole(...CALL_CENTER_ROLES), ctrl.sendGalleryImage);
router.post(
  '/:id/register-patient',
  requireRole(...CALL_CENTER_ROLES),
  ctrl.registerPatientFromChat
);
router.post(
  '/:id/appointment',
  requireRole(...CALL_CENTER_ROLES),
  ctrl.createAppointmentFromChat
);
router.post(
  '/:id/quotation',
  requireRole(...CALL_CENTER_ROLES),
  ctrl.createQuotationFromChat
);

module.exports = router;
