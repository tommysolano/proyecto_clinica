const router = require('express').Router();
const ctrl = require('../controllers/whatsappSpendController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
// El gasto de WhatsApp es del CRM global (una sola WABA para toda la organización).
router.use(require('../middleware/callCenterScope'));

// Es información de costos: solo admin y marketing.
const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.get);
router.post('/sync', requireRole(...ROLES), ctrl.sync);

module.exports = router;
