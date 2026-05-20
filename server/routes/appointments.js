const router = require('express').Router();
const {
  getAppointments,
  getAppointment,
  createAppointment,
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
  nurseAttend,
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
router.put('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero'), updateAppointment);
router.post('/:id/start', requireRole('admin', 'doctor'), startConsultation);
router.post('/:id/end', requireRole('admin', 'doctor'), endConsultation);
router.post('/:id/confirm', requireRole('admin', 'cajero', 'call_center', 'enfermero'), markConfirmed);
router.post('/:id/attended', requireRole('admin', 'cajero', 'enfermero'), markAttended);
router.post('/:id/assign-doctor', requireRole('admin', 'cajero', 'enfermero'), assignDoctor);
router.post('/:id/no-show', requireRole('admin', 'cajero', 'enfermero'), markNoShow);
router.post('/:id/nurse-attend', requireRole('admin', 'enfermero'), nurseAttend);
router.delete('/:id', requireRole('admin', 'cajero', 'call_center'), deleteAppointment);

module.exports = router;
