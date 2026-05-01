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

// Cajeros, admins y doctores ven pacientes
router.get('/', requireRole('admin', 'cajero', 'doctor'), getPatients);
router.get('/:id', requireRole('admin', 'cajero', 'doctor'), getPatient);
// Cajeros y admins crean / editan
router.post('/', requireRole('admin', 'cajero'), createPatient);
router.put('/:id', requireRole('admin', 'cajero'), updatePatient);
router.delete('/:id', requireRole('admin'), deletePatient);

module.exports = router;
