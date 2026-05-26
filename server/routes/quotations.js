const router = require('express').Router();
const ctrl = require('../controllers/quotationController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

// PDF público por token (enlace de WhatsApp) — SIN autenticación.
router.get('/public/:token/pdf', ctrl.publicPdf);

router.use(auth, requireClinic);

const EDIT_ROLES = ['admin', 'cajero', 'call_center', 'marketing'];
const VIEW_ROLES = ['admin', 'cajero', 'call_center', 'contabilidad', 'marketing'];

// Cajero, call_center y marketing pueden generar cotizaciones (con descarga en PDF).
router.get('/', requireRole(...VIEW_ROLES), ctrl.list);
router.get('/:id', requireRole(...VIEW_ROLES), ctrl.get);
router.get('/:id/pdf', requireRole(...VIEW_ROLES), ctrl.pdf);
router.get('/:id/whatsapp', requireRole(...VIEW_ROLES), ctrl.shareWhatsapp);
router.post('/', requireRole(...EDIT_ROLES), ctrl.create);
router.put('/:id', requireRole(...EDIT_ROLES), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
