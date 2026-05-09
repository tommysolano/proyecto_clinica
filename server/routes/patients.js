const router = require('express').Router();
const {
  getPatients,
  getPatient,
  createPatient,
  updatePatient,
  deletePatient,
} = require('../controllers/patientController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// Cajeros, admins, doctores, call_center, enfermero y marketing ven pacientes
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getPatients);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getPatient);
// Crear / editar: incluye doctor (con restricción de campos sensibles en el controller)
router.post('/', requireRole('admin', 'cajero', 'call_center'), createPatient);
router.put('/:id', requireRole('admin', 'cajero', 'call_center', 'doctor'), updatePatient);
router.delete('/:id', requireRole('admin'), deletePatient);

module.exports = router;
