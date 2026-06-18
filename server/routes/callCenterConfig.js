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
router.post('/:channel/test', ctrl.testConnection);

module.exports = router;
