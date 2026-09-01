const router = require('express').Router();
const {
  getOrCreateByPatient,
  updateByPatient,
  addFollowUp,
  updateFollowUp,
  deleteFollowUp,
  printFollowUp,
  printMspForm,
  uploadAttachmentMiddleware,
  uploadFollowUpAttachment,
  downloadFollowUpAttachment,
  deleteFollowUpAttachment,
  administerSerum,
  undoSerumAdministration,
  printHcu005,
} = require('../controllers/clinicalRecordController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// 'enfermero' entra aquí desde ago-2026: el enfermero atiende igual que el
// doctor —pone el suero, cura, aplica el tratamiento— y tiene que poder escribir
// lo que hizo. Antes el sistema le generaba un seguimiento automático y él no
// podía ni abrir la ficha.
const allRoles = requireRole('admin', 'cajero', 'doctor', 'enfermero');
// Quien ATIENDE al paciente: doctores, especialidades y enfermería. Es quien
// redacta lo que hizo. Mostrador (cajero) no: documenta por otro.
const rolesQueAtienden = requireRole('admin', 'doctor', 'enfermero');

/**
 * HISTORIA CLÍNICA COMPLETA en el formulario oficial MSP HCU-form.005
 * (Evolución y prescripciones). Va ANTES de '/:patientId' para que Express no
 * se coma la ruta... no hace falta: el segmento fijo va después del parámetro,
 * así que se declara aquí con su propio sufijo.
 *
 * Mismo criterio que la HCU-form.002: la hoja lleva la CÉDULA del paciente en la
 * cabecera, que es dato de administración, así que enfermería no la descarga
 * aunque sí lea la historia dentro de la app.
 */
router.get('/:patientId/hcu005', requireRole('admin', 'cajero', 'doctor'), printHcu005);

router.get('/:patientId', allRoles, getOrCreateByPatient);
router.put('/:patientId', allRoles, updateByPatient);
/**
 * Escribir un seguimiento. Enfermería SÍ, desde sep-2026.
 *
 * Antes no podía: el sistema le generaba una nota automática al cerrar el turno
 * y ahí acababa su registro. Eso dejaba fuera el caso más común de la clínica —
 * el paciente que llega prepagado, pasa directo a que le pongan el suero y nunca
 * tuvo cita— y obligaba a inventarle una cita para poder anotar la aplicación.
 * Ahora el enfermero busca al paciente y escribe lo que aplicó; si no había
 * cita, el sistema la registra solo (ver `crearCitaAtencionInmediata`).
 *
 * Mostrador (cajero) sigue pudiendo escribir: documenta por otro cuando hace
 * falta, y por eso no se le crea cita automática.
 */
router.post('/:patientId/follow-ups', requireRole('admin', 'cajero', 'doctor', 'enfermero'), addFollowUp);

/**
 * EDITAR un seguimiento ya guardado: el autor o el administrador. La comprobación
 * fina («¿lo escribiste tú?») está en el controlador, porque el rol no basta:
 * un doctor no puede corregir la consulta de otro doctor.
 *
 * Mostrador queda fuera a propósito: puede registrar por otro, pero no reescribir
 * una consulta médica.
 */
router.put('/:patientId/follow-ups/:followUpId', rolesQueAtienden, updateFollowUp);

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
/**
 * La hoja MSP NO es para enfermería, aunque desde ago-2026 sí lea la historia
 * clínica dentro de la app. El motivo no es lo clínico: la hoja oficial lleva la
 * CÉDULA del paciente en su cabecera («N.º historia clínica única»), que es un
 * dato de contacto reservado al administrador (ver `hideContactData` y
 * `patients.contactData`). Abrirla dejaba salir por el PDF exactamente lo que la
 * API le oculta, y recortarla no es opción: es un documento legal y va completo
 * o no va.
 */
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
