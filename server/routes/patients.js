const router = require('express').Router();
const {
  getPatients,
  getPatient,
  createPatient,
  updatePatient,
  deletePatient,
  searchReferralCandidates,
  getPatientPurchases,
  bulkTag,
} = require('../controllers/patientController');
const patientImport = require('../controllers/patientImportController');
const scanReview = require('../controllers/scanReviewController');
const observations = require('../controllers/patientObservationController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Etiquetado masivo para segmentación de marketing.
router.post('/bulk-tag', requireRole('admin', 'marketing'), bulkTag);

// Carga masiva por Excel: datos generales + ficha clínica + seguimientos.
// Va antes de '/:id' para que "import-template" no se lea como un id.
router.get('/import-template', requireRole('admin'), patientImport.downloadTemplate);
router.post('/import', requireRole('admin'), patientImport.uploadMiddleware, patientImport.importPatients);

// Revisión de las fichas físicas escaneadas que se importaron con datos dudosos.
// Va antes de '/:id' para que "scan-review" no se lea como un id de paciente.
router.get('/scan-review', requireRole('admin', 'cajero', 'call_center'), scanReview.listScanImports);
router.get('/scan-review/count', requireRole('admin', 'cajero', 'call_center'), scanReview.countPendingScanImports);
router.patch('/:id/scan-review', requireRole('admin', 'cajero', 'call_center'), scanReview.saveScanReview);

// Buscador de referidores (pacientes + personal) — usado al crear un paciente.
router.get('/referral-options', requireRole('admin', 'cajero', 'call_center', 'marketing'), searchReferralCandidates);

// Nota: la consulta de cédula/RUC al SRI vive en /api/lookup/tax-id/:id
// (endpoint genérico, reutilizado por todos los formularios del sistema).

// Cajeros, admins, doctores, call_center, enfermero y marketing ven pacientes.
// contabilidad: solo el listado (lo usa el buscador de paciente en "Nueva venta").
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing', 'contabilidad'), getPatients);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getPatient);
// Compras y aplicaciones del paciente (bloque dentro de Seguimientos). Es
// información ECONÓMICA —qué compró, cuánto pagó—: solo administración y
// contabilidad. Quien atiende ve el avance del tratamiento en la propia ficha.
router.get('/:id/purchases', requireRole('admin', 'contabilidad'), getPatientPurchases);
// Crear / editar: incluye doctor (con restricción de campos sensibles en el controller)
// 'doctor' EXPANDE a las especialidades (óptica incluida): en óptica el paciente
// llega sin cita previa y quien lo registra es el propio optómetra.
router.post('/', requireRole('admin', 'cajero', 'call_center', 'doctor'), createPatient);
router.put('/:id', requireRole('admin', 'cajero', 'call_center', 'doctor'), updatePatient);
router.delete('/:id', requireRole('admin'), deletePatient);

// ─── Observaciones (bitácora libre del paciente) ────────────────────────────
//
// Las ESCRIBE cualquiera que pueda abrir la ficha; quién puede MODIFICAR cada una
// (su autor, o el admin) lo decide el controlador, no la ruta: depende de la
// observación concreta, no del rol.
const observationRoles = requireRole(
  'admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'
);
const uploadObservationFiles = observations.handleUploadErrors(observations.uploadMiddleware);

router.get('/:id/observations', observationRoles, observations.validateIds, observations.list);
router.post('/:id/observations', observationRoles, observations.validateIds, uploadObservationFiles, observations.create);
router.put('/:id/observations/:obsId', observationRoles, observations.validateIds, observations.update);
router.delete('/:id/observations/:obsId', observationRoles, observations.validateIds, observations.remove);
router.post(
  '/:id/observations/:obsId/attachments',
  observationRoles,
  observations.validateIds,
  uploadObservationFiles,
  observations.addAttachments
);
router.get(
  '/:id/observations/:obsId/attachments/:attId',
  observationRoles,
  observations.validateIds,
  observations.downloadAttachment
);
router.delete(
  '/:id/observations/:obsId/attachments/:attId',
  observationRoles,
  observations.validateIds,
  observations.deleteAttachment
);

module.exports = router;
