const router = require('express').Router();
const ctrl = require('../controllers/invoiceController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
router.use(require('../middleware/accountingScope')({ reads: true }));

const allow = requireRole('admin', 'cajero', 'contabilidad');

router.get('/', allow, ctrl.list);
router.get('/sri-status', allow, ctrl.sriStatus);
router.get('/bulk-pdf', allow, ctrl.bulkPdf);
router.get('/:id', allow, ctrl.get);
router.get('/:id/pdf', allow, ctrl.getRidePdf);
router.post('/from-sale/:saleId', requireRole('admin', 'cajero'), ctrl.emitFromSale);
router.post('/retry-pending', allow, ctrl.retryPending);
router.post('/:id/retry', allow, ctrl.retry);
router.post('/:id/email', allow, ctrl.queueEmail);
// Anular factura: admin (y super admin) y contabilidad (nov-2026).
router.post('/:id/anular', requireRole('admin', 'contabilidad'), ctrl.anular);

module.exports = router;
