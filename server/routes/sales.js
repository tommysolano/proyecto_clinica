const router = require('express').Router();
const { getSales, getSale, createSale, cancelSale } = require('../controllers/saleController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'cajero', 'contabilidad'), getSales);
router.get('/:id', requireRole('admin', 'cajero', 'contabilidad'), getSale);
router.post('/', requireRole('admin', 'cajero'), createSale);
router.put('/:id/cancel', requireRole('admin'), cancelSale);

module.exports = router;
