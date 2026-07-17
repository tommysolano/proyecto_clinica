const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const imp = require('../controllers/contactImportController');
const c = require('../controllers/contactController');

router.use(auth, requireClinic);
// Los contactos son del call center (bandeja única), igual que los chats: se
// trabajan sobre la sede ancla y no por sucursal.
router.use(require('../middleware/callCenterScope'));

const CRM_ROLES = ['admin', 'marketing', 'call_center'];

// Importaciones. Las rutas concretas van antes que las paramétricas.
router.get('/imports/template', requireRole(...CRM_ROLES), imp.template);
router.get('/imports', requireRole(...CRM_ROLES), imp.list);
router.post('/imports/analyze', requireRole('admin', 'marketing'), imp.uploadMiddleware, imp.analyze);
router.post('/imports', requireRole('admin', 'marketing'), imp.create);
router.get('/imports/:id', requireRole(...CRM_ROLES), imp.get);
router.get('/imports/:id/errors.csv', requireRole(...CRM_ROLES), imp.errorsCsv);
router.post('/imports/:id/revert', requireRole('admin', 'marketing'), imp.revert);

router.get('/stats', requireRole(...CRM_ROLES), imp.stats);
router.get('/tags', requireRole(...CRM_ROLES), c.tags);

// Grupos (listas fijas y grupos por filtro). Antes que /:id.
router.get('/groups', requireRole(...CRM_ROLES), c.listGroups);
router.post('/groups', requireRole('admin', 'marketing'), c.createGroup);
router.get('/groups/:id/preview', requireRole(...CRM_ROLES), c.previewGroup);
router.put('/groups/:id', requireRole('admin', 'marketing'), c.updateGroup);
router.delete('/groups/:id', requireRole('admin', 'marketing'), c.deleteGroup);

// Acciones en lote sobre el filtro completo (no solo la página visible).
router.post('/bulk', requireRole('admin', 'marketing'), c.bulk);

// Envío masivo por goteo. Solo admin/marketing: gasta mensajes y arriesga el número.
const drip = require('../controllers/dripController');
router.get('/drips', requireRole(...CRM_ROLES), drip.list);
router.post('/drips', requireRole('admin', 'marketing'), drip.create);
router.get('/drips/:id', requireRole(...CRM_ROLES), drip.get);
router.get('/drips/:id/preview', requireRole(...CRM_ROLES), drip.preview);
router.post('/drips/:id/start', requireRole('admin', 'marketing'), drip.start);
router.post('/drips/:id/pause', requireRole('admin', 'marketing'), drip.pause);
router.delete('/drips/:id', requireRole('admin', 'marketing'), drip.remove);

router.get('/', requireRole(...CRM_ROLES), c.list);
router.post('/', requireRole(...CRM_ROLES), c.create);
router.get('/:id', requireRole(...CRM_ROLES), c.get);
router.put('/:id', requireRole(...CRM_ROLES), c.update);
router.delete('/:id', requireRole('admin', 'marketing'), c.remove);
router.post('/:id/opt-out', requireRole(...CRM_ROLES), c.setOptOut);

module.exports = router;
