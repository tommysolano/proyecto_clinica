const router = require('express').Router();
const ctrl = require('../controllers/campaignController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/', requireRole(...ROLES), ctrl.create);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.post('/:id/cancel', requireRole(...ROLES), ctrl.cancel);

module.exports = router;
