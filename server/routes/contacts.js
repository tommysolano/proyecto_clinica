const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const imp = require('../controllers/contactImportController');
const c = require('../controllers/contactController');

router.use(auth, requireClinic);
// Los contactos son del call center (bandeja única), igual que los chats: se
// trabajan sobre la sede ancla y no por sucursal.
router.use(require('../middleware/callCenterScope'));

const CRM_ROLES = ['admin', 'marketing', 'call_center'];
// El call center HACE los envíos masivos: importar el Excel, armar la campaña y
// arrancarla. Lo que NO puede es deshacer ni borrar en bloque (revertir una
// importación elimina contactos), que se queda en admin/marketing.
const SEND_ROLES = ['admin', 'marketing', 'call_center'];

// Importaciones. Las rutas concretas van antes que las paramétricas.
router.get('/imports/template', requireRole(...CRM_ROLES), imp.template);
router.get('/imports', requireRole(...CRM_ROLES), imp.list);
router.post('/imports/analyze', requireRole(...SEND_ROLES), imp.uploadMiddleware, imp.analyze);
router.post('/imports', requireRole(...SEND_ROLES), imp.create);
router.get('/imports/pending-enrollments', requireRole(...CRM_ROLES), imp.pendingEnrollments);
router.get('/imports/:id', requireRole(...CRM_ROLES), imp.get);
router.get('/imports/:id/errors.csv', requireRole(...CRM_ROLES), imp.errorsCsv);
router.post('/imports/:id/revert', requireRole('admin', 'marketing'), imp.revert);

router.get('/stats', requireRole(...CRM_ROLES), imp.stats);
router.get('/tags', requireRole(...CRM_ROLES), c.tags);
// Números para el selector de envío (sin credenciales): también para el call center.
router.get('/whatsapp-accounts', requireRole(...CRM_ROLES), c.whatsappAccounts);

// Grupos (listas fijas y grupos por filtro). Antes que /:id.
// Crear/editar grupos es parte de preparar un envío; borrarlos, no.
router.get('/groups', requireRole(...CRM_ROLES), c.listGroups);
router.post('/groups', requireRole(...SEND_ROLES), c.createGroup);
router.get('/groups/:id/preview', requireRole(...CRM_ROLES), c.previewGroup);
router.put('/groups/:id', requireRole(...SEND_ROLES), c.updateGroup);
router.delete('/groups/:id', requireRole('admin', 'marketing'), c.deleteGroup);

// Acciones en lote sobre el filtro completo (no solo la página visible).
// El borrado masivo se comprueba dentro del controlador: solo admin/marketing.
router.post('/bulk', requireRole(...SEND_ROLES), c.bulk);

// Envío masivo por goteo. Borrar una campaña sigue siendo de admin/marketing.
const drip = require('../controllers/dripController');
router.get('/drips', requireRole(...CRM_ROLES), drip.list);
router.post('/drips', requireRole(...SEND_ROLES), drip.create);
router.get('/drips/:id', requireRole(...CRM_ROLES), drip.get);
router.get('/drips/:id/preview', requireRole(...CRM_ROLES), drip.preview);
router.post('/drips/:id/start', requireRole(...SEND_ROLES), drip.start);
router.post('/drips/:id/pause', requireRole(...SEND_ROLES), drip.pause);
router.delete('/drips/:id', requireRole('admin', 'marketing'), drip.remove);

router.get('/', requireRole(...CRM_ROLES), c.list);
router.post('/', requireRole(...CRM_ROLES), c.create);
router.get('/:id', requireRole(...CRM_ROLES), c.get);
router.put('/:id', requireRole(...CRM_ROLES), c.update);
router.delete('/:id', requireRole('admin', 'marketing'), c.remove);
router.post('/:id/opt-out', requireRole(...CRM_ROLES), c.setOptOut);

module.exports = router;
