const router = require('express').Router();
const { getSales, getSale, createSale, cancelSale, collectSale } = require('../controllers/saleController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Listado de ventas: solo admin y contabilidad. El cajero NO puede ver el historial.
router.get('/', requireRole('admin', 'contabilidad'), getSales);
router.get('/:id', requireRole('admin', 'contabilidad', 'cajero'), getSale);
router.post('/', requireRole('admin', 'cajero', 'contabilidad'), createSale);
router.post('/:id/collect', requireRole('admin', 'contabilidad', 'cajero'), collectSale);
// NO existe endpoint para editar el asiento de una venta: un asiento contabilizado es
// inmutable. Para corregirlo se ANULA la venta (que reversa sus asientos) y se rehace.
router.put('/:id/cancel', requireRole('admin'), cancelSale);

module.exports = router;
