const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/deferredIncomeController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/:id/recognize', requireRole('admin', 'contabilidad'), c.recognize);

module.exports = router;
