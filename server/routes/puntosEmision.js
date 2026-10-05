const router = require('express').Router();
const ctrl = require('../controllers/puntoEmisionController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// El propio punto lo consulta quien vende/factura/maneja caja.
router.get('/mio', requireRole('admin', 'contabilidad', 'cajero'), ctrl.mine);
// Administrar puntos: mismos roles que la configuración SRI.
router.get('/', requireRole('admin', 'contabilidad'), ctrl.list);
router.post('/', requireRole('admin', 'contabilidad'), ctrl.create);
router.put('/:id', requireRole('admin', 'contabilidad'), ctrl.update);
router.delete('/:id', requireRole('admin', 'contabilidad'), ctrl.remove);

module.exports = router;
