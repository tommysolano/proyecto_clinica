const router = require('express').Router();
const ctrl = require('../controllers/workflowController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.get('/presets', requireRole(...ROLES), ctrl.listPresets);
router.post('/presets/:key', requireRole(...ROLES), ctrl.installPreset);
router.post('/', requireRole(...ROLES), ctrl.create);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.get('/:id/enrollments', requireRole(...ROLES), ctrl.enrollments);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
