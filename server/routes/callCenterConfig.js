const router = require('express').Router();
const ctrl = require('../controllers/callCenterConfigController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// Solo admin, marketing y super-admin pueden acceder.
const ALLOWED = ['admin', 'marketing'];

router.use(auth, requireClinic, requireRole(...ALLOWED));

router.get('/', ctrl.get);
router.get('/webhook-urls', ctrl.getWebhookUrls);
router.put('/', ctrl.update);
router.put('/reputation', ctrl.updateReputation);
router.post('/ai/test', ctrl.testAi);

// WhatsApp: números globales del call center (multi-número + Cloud API / QR).
router.get('/whatsapp/app-config', ctrl.getWhatsappAppConfig);
router.put('/whatsapp/app-config', ctrl.updateWhatsappAppConfig);
router.get('/whatsapp/accounts', ctrl.listWhatsappAccounts);
router.post('/whatsapp/accounts', ctrl.createWhatsappAccount);
router.put('/whatsapp/accounts/:id', ctrl.updateWhatsappAccount);
router.delete('/whatsapp/accounts/:id', ctrl.deleteWhatsappAccount);
router.post('/whatsapp/accounts/:id/default', ctrl.setDefaultWhatsappAccount);
router.post('/whatsapp/accounts/:id/connect', ctrl.connectWhatsappAccount);
router.post('/whatsapp/accounts/:id/disconnect', ctrl.disconnectWhatsappAccount);
router.post('/whatsapp/accounts/:id/test', ctrl.testWhatsappAccount);

router.post('/:channel/test', ctrl.testConnection);

module.exports = router;
