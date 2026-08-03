const router = require('express').Router();
const ctrl = require('../controllers/trashController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
// CRM global: opera sobre la clínica ancla del call center (no por sucursal),
// igual que segmentos/plantillas/workflows.
router.use(require('../middleware/callCenterScope'));

// admin/marketing: son los roles con permiso de borrado sobre los 5 tipos que
// cubre la papelera (Workflow y SavedReply también los borra call_center,
// pero no Segmento/Plantilla/Contacto — se deja fuera para no filtrarle
// restauración de cosas que no podría borrar).
const ROLES = ['admin', 'marketing'];

router.get('/', requireRole(...ROLES), ctrl.list);
router.post('/:id/restore', requireRole(...ROLES), ctrl.restore);
router.delete('/:id', requireRole(...ROLES), ctrl.purgeNow);

module.exports = router;
