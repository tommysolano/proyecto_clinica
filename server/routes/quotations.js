const router = require('express').Router();
const ctrl = require('../controllers/quotationController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Cajero y call_center pueden generar cotizaciones (con descarga en PDF).
router.get('/', requireRole('admin', 'cajero', 'call_center', 'contabilidad'), ctrl.list);
router.get('/:id', requireRole('admin', 'cajero', 'call_center', 'contabilidad'), ctrl.get);
router.get('/:id/pdf', requireRole('admin', 'cajero', 'call_center', 'contabilidad'), ctrl.pdf);
router.post('/', requireRole('admin', 'cajero', 'call_center'), ctrl.create);
router.put('/:id', requireRole('admin', 'cajero', 'call_center'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
