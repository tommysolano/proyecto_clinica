const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/transferRequestController');

router.use(auth, requireClinic);

// Piden los usuarios con punto de emisión (cajeros, admin, contabilidad); el controlador
// comprueba además que su punto tenga bodega. Atender: admin y contabilidad (en el controlador).
const conPunto = requireRole('admin', 'contabilidad', 'cajero');

router.get('/context', conPunto, c.context);
router.get('/', conPunto, c.list);
router.post('/', conPunto, c.create);
router.post('/:id/approve', requireRole('admin', 'contabilidad'), c.approve);
router.post('/:id/reject', requireRole('admin', 'contabilidad'), c.reject);
router.post('/:id/cancel', conPunto, c.cancel);

module.exports = router;
