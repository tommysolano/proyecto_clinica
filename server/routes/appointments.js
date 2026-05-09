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
} = require('../controllers/appointmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/today', requireRole('admin', 'cajero', 'doctor', 'call_center'), getTodayAppointments);
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center'), getAppointments);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center'), getAppointment);
router.get(
  '/:id/pdf',
  requireRole('admin', 'cajero', 'doctor', 'call_center'),
  getAppointmentPdf
);
router.post('/', requireRole('admin', 'cajero', 'call_center'), createAppointment);
router.put('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center'), updateAppointment);
router.post('/:id/start', requireRole('admin', 'doctor'), startConsultation);
router.post('/:id/end', requireRole('admin', 'doctor'), endConsultation);
router.delete('/:id', requireRole('admin', 'cajero', 'call_center'), deleteAppointment);

module.exports = router;
