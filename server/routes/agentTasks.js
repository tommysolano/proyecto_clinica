const router = require('express').Router();
const ctrl = require('../controllers/agentTaskController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const ROLES = ['admin', 'call_center', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/', requireRole(...ROLES), ctrl.create);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
