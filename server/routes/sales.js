const router = require('express').Router();
const { getSales, getSale, createSale, cancelSale } = require('../controllers/saleController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Listado de ventas: solo admin y contabilidad. El cajero NO puede ver el historial.
router.get('/', requireRole('admin', 'contabilidad'), getSales);
router.get('/:id', requireRole('admin', 'contabilidad', 'cajero'), getSale);
router.post('/', requireRole('admin', 'cajero'), createSale);
router.put('/:id/cancel', requireRole('admin'), cancelSale);

module.exports = router;
