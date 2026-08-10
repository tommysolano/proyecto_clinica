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
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Etiquetado masivo para segmentación de marketing.
router.post('/bulk-tag', requireRole('admin', 'marketing'), bulkTag);

// Carga masiva por Excel: datos generales + ficha clínica + seguimientos.
// Va antes de '/:id' para que "import-template" no se lea como un id.
router.get('/import-template', requireRole('admin'), patientImport.downloadTemplate);
router.post('/import', requireRole('admin'), patientImport.uploadMiddleware, patientImport.importPatients);

// Buscador de referidores (pacientes + personal) — usado al crear un paciente.
router.get('/referral-options', requireRole('admin', 'cajero', 'call_center', 'marketing'), searchReferralCandidates);

// Nota: la consulta de cédula/RUC al SRI vive en /api/lookup/tax-id/:id
// (endpoint genérico, reutilizado por todos los formularios del sistema).

// Cajeros, admins, doctores, call_center, enfermero y marketing ven pacientes.
// contabilidad: solo el listado (lo usa el buscador de paciente en "Nueva venta").
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing', 'contabilidad'), getPatients);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getPatient);
// Compras y aplicaciones del paciente (para el seguimiento)
router.get('/:id/purchases', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getPatientPurchases);
// Crear / editar: incluye doctor (con restricción de campos sensibles en el controller)
router.post('/', requireRole('admin', 'cajero', 'call_center'), createPatient);
router.put('/:id', requireRole('admin', 'cajero', 'call_center', 'doctor'), updatePatient);
router.delete('/:id', requireRole('admin'), deletePatient);

module.exports = router;
