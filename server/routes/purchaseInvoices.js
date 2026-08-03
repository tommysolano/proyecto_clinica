const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/purchaseInvoiceController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad'), c.list);
router.get('/recurring-accounts', requireRole('admin', 'contabilidad'), c.recurringAccounts);
router.get('/:id', requireRole('admin', 'contabilidad'), c.get);
// Abonos (pagos totales/parciales) aplicados a la factura, con su saldo.
router.get('/:id/payments', requireRole('admin', 'contabilidad'), c.payments);
router.post('/', requireRole('admin', 'contabilidad'), c.create);
router.put('/:id', requireRole('admin', 'contabilidad'), c.update);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);
router.delete('/:id', requireRole('admin', 'contabilidad'), c.remove);
router.post('/:id/authorize', requireRole('admin', 'contabilidad'), c.authorize);
// NO existe endpoint para editar el asiento de una compra: un asiento contabilizado es
// inmutable. Para corregirlo se EDITA la factura (que reversa y regenera su asiento) o se anula.
// Reinicio de compras (limpiar importaciones erróneas) — solo admin, con confirmación
router.post('/wipe', requireRole('admin'), c.wipeAll);
router.post('/import-txt', requireRole('admin', 'contabilidad'), c.importTxt);
router.post('/import-xml', requireRole('admin', 'contabilidad'), c.importXml);

module.exports = router;
