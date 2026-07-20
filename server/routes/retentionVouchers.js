const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/retentionVoucherController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/config', requireRole('admin', 'contabilidad'), c.config);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/from-purchase/:purchaseId', requireRole('admin', 'contabilidad'), c.emitFromPurchase);
router.post('/:id/retry', requireRole('admin', 'contabilidad'), c.retry);

module.exports = router;
