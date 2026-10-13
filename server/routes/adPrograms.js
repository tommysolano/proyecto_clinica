const router = require('express').Router();
const ctrl = require('../controllers/adProgramController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// Analíticas del CRM por programa de publicidad: los mismos roles que ven la
// página (admin y marketing, ver la ruta /analytics del cliente).
router.use(auth, requireClinic, requireRole('admin', 'marketing'));
// CRM global (oct-2026): los programas, los chats y las automatizaciones viven
// en la clínica ancla del call center, no en la sucursal activa. Sin esto, al
// cambiar de Central a Laboratorio la página se quedaba vacía.
router.use(require('../middleware/callCenterScope'));

router.get('/', ctrl.list);
router.get('/ad-sources', ctrl.adSources);
router.get('/analytics', ctrl.analytics);
router.get('/ad-chats', ctrl.adChats);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
