const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/costCenterController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.delete('/:id', requireRole('admin', 'contabilidad'), c.remove);

module.exports = router;
