const router = require('express').Router();
const { auth, requireClinic, requireRole } = require('../middleware/auth');
const c = require('../controllers/dataImportController');

router.use(auth, requireClinic);

// Plantillas Excel de carga masiva y su importación (solo admin/contabilidad).
router.get('/template/:type', requireRole('admin', 'contabilidad'), c.downloadTemplate);
router.post('/:type', requireRole('admin', 'contabilidad'), c.uploadMiddleware, c.importFile);

module.exports = router;
