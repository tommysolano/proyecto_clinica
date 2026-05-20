const router = require('express').Router();
const {
  getOrCreateByPatient,
  updateByPatient,
  addFollowUp,
  deleteFollowUp,
  printFollowUp,
  uploadAttachmentMiddleware,
  uploadFollowUpAttachment,
  downloadFollowUpAttachment,
  deleteFollowUpAttachment,
} = require('../controllers/clinicalRecordController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

const allRoles = requireRole('admin', 'cajero', 'doctor');

router.get('/:patientId', allRoles, getOrCreateByPatient);
router.put('/:patientId', allRoles, updateByPatient);
router.post('/:patientId/follow-ups', allRoles, addFollowUp);
router.get('/:patientId/follow-ups/:followUpId/print', allRoles, printFollowUp);
router.delete('/:patientId/follow-ups/:followUpId', requireRole('admin', 'doctor'), deleteFollowUp);

// Adjuntos PDF (ecografías, bioresonancias, etc.) por seguimiento
router.post(
  '/:patientId/follow-ups/:followUpId/attachments',
  requireRole('admin', 'doctor'),
  uploadAttachmentMiddleware,
  uploadFollowUpAttachment
);
router.get(
  '/:patientId/follow-ups/:followUpId/attachments/:attachmentId',
  allRoles,
  downloadFollowUpAttachment
);
router.delete(
  '/:patientId/follow-ups/:followUpId/attachments/:attachmentId',
  requireRole('admin', 'doctor'),
  deleteFollowUpAttachment
);

module.exports = router;
