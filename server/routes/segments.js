const router = require('express').Router();
const ctrl = require('../controllers/segmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/', requireRole(...ROLES), ctrl.create);
router.post('/preview', requireRole(...ROLES), ctrl.preview);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.get('/:id/resolve', requireRole(...ROLES), ctrl.resolve);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
