const router = require('express').Router();
const {
  getOrCreateByPatient,
  updateByPatient,
  addFollowUp,
  deleteFollowUp,
  printFollowUp,
  printMspForm,
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
router.get('/:patientId/follow-ups/:followUpId/msp', allRoles, printMspForm);
// Borrar un seguimiento: SOLO administradores. Antes también podían los
// doctores —y `requireRole` expande 'doctor' a todas las especialidades, así que
// en la práctica podía cualquier profesional— pero un seguimiento es historia
// clínica: se corrige añadiendo otro, no borrando el anterior. El frontend ya
// solo enseñaba el botón al admin; esto cierra la puerta de verdad.
router.delete('/:patientId/follow-ups/:followUpId', requireRole('admin'), deleteFollowUp);

// Adjuntos PDF (ecografías, bioresonancias, etc.) por seguimiento.
// Disponible para todos los usuarios con acceso a seguimientos (admin, cajero, doctor, optica).
router.post(
  '/:patientId/follow-ups/:followUpId/attachments',
  allRoles,
  uploadAttachmentMiddleware,
  uploadFollowUpAttachment
);
router.get(
  '/:patientId/follow-ups/:followUpId/attachments/:attachmentId',
  allRoles,
  downloadFollowUpAttachment
);
// Borrar un adjunto va con el mismo criterio que borrar el seguimiento: es parte
// de la historia clínica (una ecografía, un examen) y solo el admin la retira.
// El botón ya se enseñaba únicamente al admin; la ruta estaba abierta.
router.delete(
  '/:patientId/follow-ups/:followUpId/attachments/:attachmentId',
  requireRole('admin'),
  deleteFollowUpAttachment
);

module.exports = router;
