const router = require('express').Router();
const {
  getAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getTodayAppointments,
} = require('../controllers/appointmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/today', requireRole('admin', 'cajero', 'doctor'), getTodayAppointments);
router.get('/', requireRole('admin', 'cajero', 'doctor'), getAppointments);
router.get('/:id', requireRole('admin', 'cajero', 'doctor'), getAppointment);
router.post('/', requireRole('admin', 'cajero'), createAppointment);
router.put('/:id', requireRole('admin', 'cajero', 'doctor'), updateAppointment);
router.delete('/:id', requireRole('admin', 'cajero'), deleteAppointment);

module.exports = router;
