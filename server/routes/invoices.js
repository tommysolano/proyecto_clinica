const router = require('express').Router();
const ctrl = require('../controllers/invoiceController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const allow = requireRole('admin', 'cajero', 'contabilidad');

router.get('/', allow, ctrl.list);
router.get('/:id', allow, ctrl.get);
router.get('/:id/pdf', allow, ctrl.getRidePdf);
router.post('/from-sale/:saleId', requireRole('admin', 'cajero'), ctrl.emitFromSale);
router.post('/:id/retry', requireRole('admin', 'cajero', 'contabilidad'), ctrl.retry);
router.post('/:id/anular', requireRole('admin'), ctrl.anular);

module.exports = router;
