const router = require('express').Router();
const ctrl = require('../controllers/bookingConfigController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.get);
router.put('/', requireRole(...ROLES), ctrl.update);
router.post('/regenerate-token', requireRole(...ROLES), ctrl.regenerateToken);

module.exports = router;
