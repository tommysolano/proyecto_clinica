const router = require('express').Router();
const ctrl = require('../controllers/workflowController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);
// CRM global: opera sobre la clínica ancla del call center (no por sucursal).
router.use(require('../middleware/callCenterScope'));

const ROLES = ['admin', 'marketing', 'call_center'];

// Carga masiva por Excel (descargar plantilla + subir lleno). Antes de '/:id'.
const bulk = require('../controllers/marketingImportController');
router.get('/bulk/template', requireRole(...ROLES), bulk.downloadAutomatizacionesTemplate);
router.post('/bulk', requireRole(...ROLES), bulk.uploadMiddleware, bulk.importAutomatizacionesExcel);

router.get('/folders', requireRole(...ROLES), ctrl.listFolders);
router.post('/folders', requireRole(...ROLES), ctrl.createFolder);
router.put('/folders', requireRole(...ROLES), ctrl.renameFolder); // { path, name }
router.delete('/folders', requireRole(...ROLES), ctrl.deleteFolder); // ?path=Citas/Recordatorios&mode=

router.get('/', requireRole(...ROLES), ctrl.list);
// Públicos Personalizados de Meta (selector del nodo de Facebook).
router.get('/meta/custom-audiences', requireRole(...ROLES), ctrl.listMetaCustomAudiences);
router.get('/presets', requireRole(...ROLES), ctrl.listPresets);
router.post('/presets/:key', requireRole(...ROLES), ctrl.installPreset);
router.post('/', requireRole(...ROLES), ctrl.create);
router.get('/:id', requireRole(...ROLES), ctrl.get);
router.get('/:id/enrollments', requireRole(...ROLES), ctrl.enrollments);
// Cancela una inscripción viva (desbloquea al contacto para el próximo envío).
router.post('/:id/enrollments/:enrollId/cancel', requireRole(...ROLES), ctrl.cancelEnrollment);
router.get('/:id/activity', requireRole(...ROLES), ctrl.activity);
router.put('/:id', requireRole(...ROLES), ctrl.update);
router.delete('/:id', requireRole(...ROLES), ctrl.remove);

module.exports = router;
