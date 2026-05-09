const router = require('express').Router();
const ctrl = require('../controllers/discountController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'cajero', 'contabilidad'), ctrl.list);
router.post('/applicable', requireRole('admin', 'cajero', 'contabilidad'), ctrl.applicable);
router.post('/', requireRole('admin'), ctrl.create);
router.put('/:id', requireRole('admin'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
