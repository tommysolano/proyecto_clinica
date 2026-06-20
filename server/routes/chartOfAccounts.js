const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/chartOfAccountController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/next-code', requireRole('admin', 'contabilidad'), c.suggestChild);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.delete('/:id', requireRole('admin', 'contabilidad'), c.remove);
router.post('/seed', requireRole('admin', 'contabilidad'), c.seed);

module.exports = router;
