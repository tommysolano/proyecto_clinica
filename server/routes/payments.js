const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/paymentController');

router.use(auth, requireClinic);
router.get('/', requireRole('admin', 'contabilidad', 'cajero'), c.list);
// Excel del listado filtrado: va ANTES de '/:id' o 'export.xlsx' se tomaría por un id.
router.get('/export.xlsx', requireRole('admin', 'contabilidad'), c.paymentsExcel);
router.get('/:id', requireRole('admin', 'contabilidad', 'cajero'), c.get);
router.post('/', requireRole('admin', 'contabilidad', 'cajero'), c.create);
router.post('/bulk', requireRole('admin', 'contabilidad'), c.createBulk);
router.post('/:id/void', requireRole('admin', 'contabilidad'), c.void);

module.exports = router;
