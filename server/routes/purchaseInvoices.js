const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/purchaseInvoiceController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/recurring-accounts', requireRole('admin', 'contabilidad'), c.recurringAccounts);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);
router.post('/:id/authorize', requireRole('admin', 'contabilidad'), c.authorize);
router.post('/:id/journal', requireRole('admin', 'contabilidad'), c.editJournal);
router.post('/import-txt', requireRole('admin', 'contabilidad'), c.importTxt);
router.post('/import-xml', requireRole('admin', 'contabilidad'), c.importXml);

module.exports = router;
