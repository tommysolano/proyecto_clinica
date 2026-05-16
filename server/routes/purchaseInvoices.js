const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/purchaseInvoiceController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);
router.post('/import-txt', requireRole('admin', 'contabilidad'), c.importTxt);

module.exports = router;
