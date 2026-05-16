const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/fiscalPeriodController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.post('/:id/close', requireRole('admin', 'contabilidad'), c.close);
router.post('/:id/reopen', requireRole('admin'), c.reopen);
router.post('/:id/lock', requireRole('admin'), c.lock);
router.post('/close-year', requireRole('admin'), c.closeYear);

module.exports = router;
