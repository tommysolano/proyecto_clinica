const router = require('express').Router();
const ctrl = require('../controllers/messageTemplateController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
// CRM global: opera sobre la clínica ancla del call center (no por sucursal).
router.use(require('../middleware/callCenterScope'));

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/', requireRole(...ROLES), ctrl.create);
router.post('/upload-image', requireRole(...ROLES), ctrl.uploadHeaderImage);
router.post('/sync-whatsapp', requireRole(...ROLES), ctrl.syncWhatsapp);
router.get('/alerts', requireRole(...ROLES), ctrl.listAlerts);
router.post('/alerts/:id/read', requireRole(...ROLES), ctrl.markAlertRead);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.post('/:id/submit', requireRole(...ROLES), ctrl.submit);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
