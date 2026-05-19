const router = require('express').Router();
const ctrl = require('../controllers/treatmentController');
const reminders = require('../controllers/treatmentRemindersController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/', requireRole('admin', 'cajero', 'doctor', 'marketing', 'enfermero'), ctrl.list);
router.get(
  '/reminders.xlsx',
  requireRole('admin', 'doctor', 'marketing', 'cajero'),
  reminders.exportRemindersExcel
);
router.post(
  '/whatsapp-broadcast',
  requireRole('admin', 'doctor', 'marketing'),
  reminders.whatsappBroadcast
);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'marketing', 'enfermero'), ctrl.get);
router.post('/', requireRole('admin', 'doctor'), ctrl.create);
router.put('/:id', requireRole('admin', 'doctor'), ctrl.update);
router.delete('/:id', requireRole('admin'), ctrl.remove);
router.post('/:id/complete-item', requireRole('admin', 'doctor', 'cajero'), ctrl.completeItem);

module.exports = router;
