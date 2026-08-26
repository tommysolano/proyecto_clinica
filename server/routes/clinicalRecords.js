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
  administerSerum,
  undoSerumAdministration,
} = require('../controllers/clinicalRecordController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// 'enfermero' entra aquí desde ago-2026: el enfermero atiende igual que el
// doctor —pone el suero, cura, aplica el tratamiento— y tiene que poder escribir
// lo que hizo. Antes el sistema le generaba un seguimiento automático y él no
// podía ni abrir la ficha.
const allRoles = requireRole('admin', 'cajero', 'doctor', 'enfermero');

router.get('/:patientId', allRoles, getOrCreateByPatient);
router.put('/:patientId', allRoles, updateByPatient);
// Escribir un seguimiento: enfermería NO. Entra a la ficha y ve el historial
// (en su caso, solo la receta), pero la consulta la redacta quien la atiende.
router.post('/:patientId/follow-ups', requireRole('admin', 'cajero', 'doctor'), addFollowUp);

// Administrar un suero: es el trabajo de enfermería, y el doctor también puede.
router.post(
  '/:patientId/follow-ups/:followUpId/receta/:itemId/administer',
  requireRole('admin', 'doctor', 'enfermero'),
  administerSerum
);
router.delete(
  '/:patientId/follow-ups/:followUpId/receta/:itemId/administer',
  requireRole('admin', 'doctor', 'enfermero'),
  undoSerumAdministration
);
router.get('/:patientId/follow-ups/:followUpId/print', allRoles, printFollowUp);
// La hoja MSP es la consulta ENTERA: no es para enfermería, que solo ve receta.
router.get('/:patientId/follow-ups/:followUpId/msp', requireRole('admin', 'cajero', 'doctor'), printMspForm);
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
