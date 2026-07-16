const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const imp = require('../controllers/contactImportController');

router.use(auth, requireClinic);
// Los contactos son del call center (bandeja única), igual que los chats: se
// trabajan sobre la sede ancla y no por sucursal.
router.use(require('../middleware/callCenterScope'));

const CRM_ROLES = ['admin', 'marketing', 'call_center'];

// Importaciones. Las rutas concretas van antes que las paramétricas.
router.get('/imports', requireRole(...CRM_ROLES), imp.list);
router.post('/imports/analyze', requireRole('admin', 'marketing'), imp.uploadMiddleware, imp.analyze);
router.post('/imports', requireRole('admin', 'marketing'), imp.create);
router.get('/imports/:id', requireRole(...CRM_ROLES), imp.get);
router.get('/imports/:id/errors.csv', requireRole(...CRM_ROLES), imp.errorsCsv);
router.post('/imports/:id/revert', requireRole('admin', 'marketing'), imp.revert);

router.get('/stats', requireRole(...CRM_ROLES), imp.stats);

module.exports = router;
