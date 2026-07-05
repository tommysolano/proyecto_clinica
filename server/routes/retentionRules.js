const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/retentionRuleController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.post('/seed', requireRole('admin', 'contabilidad'), c.seed);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.patch('/:id/toggle', requireRole('admin', 'contabilidad'), c.toggle);

module.exports = router;
