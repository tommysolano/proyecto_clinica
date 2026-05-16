const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/supplierController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.delete('/:id', requireRole('admin'), c.remove);

module.exports = router;
