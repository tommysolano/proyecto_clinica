const router = require('express').Router();
const {
  getAppointments,
  getAppointment,
  createAppointment,
  createWalkIn,
  updateAppointment,
  deleteAppointment,
  getTodayAppointments,
  getAppointmentPdf,
  startConsultation,
  endConsultation,
  getStats,
  markAttended,
  markNoShow,
  markConfirmed,
  assignDoctor,
  nurseClaim,
  nurseComplete,
} = require('../controllers/appointmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/today', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getTodayAppointments);
router.get('/stats', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getStats);
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getAppointments);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getAppointment);
router.get(
  '/:id/pdf',
  requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero'),
  getAppointmentPdf
);
router.post('/', requireRole('admin', 'cajero', 'call_center'), createAppointment);
// ATENCIÓN INMEDIATA: crea la cita ya asignada a quien la pide. 'doctor' expande
// a las especialidades — nace para óptica, donde el paciente entra sin cita y lo
// registra el propio optómetra.
router.post('/walk-in', requireRole('admin', 'doctor'), createWalkIn);
router.put('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero'), updateAppointment);
router.post('/:id/start', requireRole('admin', 'doctor'), startConsultation);
router.post('/:id/end', requireRole('admin', 'doctor'), endConsultation);
router.post('/:id/confirm', requireRole('admin', 'cajero', 'call_center', 'enfermero'), markConfirmed);
router.post('/:id/attended', requireRole('admin', 'cajero', 'enfermero'), markAttended);
router.post('/:id/assign-doctor', requireRole('admin', 'cajero', 'enfermero'), assignDoctor);
router.post('/:id/no-show', requireRole('admin', 'cajero', 'enfermero'), markNoShow);
router.post('/:id/nurse-claim', requireRole('admin', 'enfermero'), nurseClaim);
router.post('/:id/nurse-complete', requireRole('admin', 'enfermero'), nurseComplete);
router.delete('/:id', requireRole('admin', 'cajero', 'call_center'), deleteAppointment);

module.exports = router;
