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

// Cajeros, admins, doctores y call_center ven pacientes
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center'), getPatients);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center'), getPatient);
// Cajeros, admins y call_center pueden crear / editar pacientes
router.post('/', requireRole('admin', 'cajero', 'call_center'), createPatient);
router.put('/:id', requireRole('admin', 'cajero', 'call_center'), updatePatient);
router.delete('/:id', requireRole('admin'), deletePatient);

module.exports = router;
