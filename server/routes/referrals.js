const router = require('express').Router();
const ctrl = require('../controllers/referralController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/stats', requireRole('admin', 'doctor', 'marketing'), ctrl.stats);
router.get('/', requireRole('admin', 'doctor', 'marketing', 'cajero'), ctrl.list);
router.post('/', requireRole('admin', 'doctor'), ctrl.create);
router.put('/:id', requireRole('admin', 'doctor'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
