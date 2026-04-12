const router = require('express').Router();
const {
  getAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getTodayAppointments,
} = require('../controllers/appointmentController');
const { auth } = require('../middleware/auth');

router.use(auth);

router.get('/today', getTodayAppointments);
router.get('/', getAppointments);
router.get('/:id', getAppointment);
router.post('/', createAppointment);
router.put('/:id', updateAppointment);
router.delete('/:id', deleteAppointment);

module.exports = router;
