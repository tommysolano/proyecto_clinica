const router = require('express').Router();
const {
  getOrCreateByPatient,
  updateByPatient,
  addFollowUp,
  deleteFollowUp,
} = require('../controllers/clinicalRecordController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const allRoles = requireRole('admin', 'cajero', 'doctor');

router.get('/:patientId', allRoles, getOrCreateByPatient);
router.put('/:patientId', allRoles, updateByPatient);
router.post('/:patientId/follow-ups', allRoles, addFollowUp);
router.delete('/:patientId/follow-ups/:followUpId', requireRole('admin', 'doctor'), deleteFollowUp);

module.exports = router;
