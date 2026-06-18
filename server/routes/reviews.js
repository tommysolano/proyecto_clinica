const router = require('express').Router();
const ctrl = require('../controllers/reviewController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.get('/stats', requireRole(...ROLES), ctrl.stats);

module.exports = router;
