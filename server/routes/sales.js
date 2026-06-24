const router = require('express').Router();
const { getSales, getSale, createSale, cancelSale, collectSale, editJournalSale } = require('../controllers/saleController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Listado de ventas: solo admin y contabilidad. El cajero NO puede ver el historial.
router.get('/', requireRole('admin', 'contabilidad'), getSales);
router.get('/:id', requireRole('admin', 'contabilidad', 'cajero'), getSale);
router.post('/', requireRole('admin', 'cajero'), createSale);
router.post('/:id/collect', requireRole('admin', 'contabilidad', 'cajero'), collectSale);
router.post('/:id/journal', requireRole('admin', 'contabilidad'), editJournalSale);
router.put('/:id/cancel', requireRole('admin'), cancelSale);

module.exports = router;
