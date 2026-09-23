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
  getFollowUpsByAppointment,
} = require('../controllers/clinicalRecordController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

// 'enfermero' entra aquí desde ago-2026: el enfermero atiende igual que el
// doctor —pone el suero, cura, aplica el tratamiento— y tiene que poder escribir
// lo que hizo. Antes el sistema le generaba un seguimiento automático y él no
// podía ni abrir la ficha.
const allRoles = requireRole('admin', 'cajero', 'doctor', 'enfermero');
/**
 * QUIEN LEE LA HISTORIA, que ya no es lo mismo que quien la escribe.
 *
 * El CALL CENTER entra aquí desde sep-2026, y SOLO a leer. No es un permiso
 * cómodo, es el trabajo: el paciente llama preguntando qué le recetaron, cuándo
 * fue su última consulta o si tiene que volver, y la asesora tenía que
 * interrumpir a un doctor para responder algo que está escrito. Ve lo mismo que
 * cualquier otro rol no administrativo: sin datos de contacto (`hideContactData`)
 * y sin lo que escribió el terapeuta, que es reservado (`hideTherapyNotes`).
 *
 * MARKETING entra por lo mismo (sep-2026): atiende el WhatsApp de la clínica
 * codo con codo con el call center —comparten la bandeja de /chats y las dos
 * agendan desde ahí—, y quien contesta a un paciente que pregunta por su
 * tratamiento necesita leer lo que está escrito, venga la pregunta por donde
 * venga. Con el MISMO recorte y sin poder escribir nada.
 *
 * Escribir, corregir, administrar sueros o borrar sigue siendo de quien atiende:
 * eso lo defienden las rutas de abajo, que NO llevan este grupo.
 */
const rolesQueLeen = requireRole('admin', 'cajero', 'doctor', 'enfermero', 'call_center', 'marketing');
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

/**
 * LO QUE SE ESCRIBIÓ EN UNA CITA CONCRETA (para la agenda).
 *
 * Va antes de '/:patientId' por claridad, aunque Express no las confunda: esta
 * tiene dos segmentos y aquella uno.
 *
 * Con los roles de QUIEN ATIENDE, y no con los de la agenda, que son más: este
 * atajo es el «ver la receta» de la fila de la cita. El call center y marketing
 * leen la historia desde sep-2026 (ver `rolesQueLeen`), pero por la FICHA DEL
 * PACIENTE —o por el chat, que abre esa misma ficha—, no por la agenda: ahí su
 * trabajo es la cita, no la consulta.
 */
router.get('/by-appointment/:appointmentId', allRoles, getFollowUpsByAppointment);

router.get('/:patientId', rolesQueLeen, getOrCreateByPatient);
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
 * falta, y por eso no se le crea una cita a SU nombre. La excepción es el suero:
 * ahí no está documentando, está mandando al paciente a que se lo pongan, así
 * que la cita se crea con un turno de ENFERMERÍA sin dueño y les sale en la
 * bandeja (ver `addFollowUp`).
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
// La receta impresa: el call center también se la manda al paciente que la pide.
router.get('/:patientId/follow-ups/:followUpId/print', rolesQueLeen, printFollowUp);
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
  rolesQueLeen,
  downloadFollowUpAttachment
);
// El administrador puede retirar cualquiera. Cada profesional también puede
// retirar los que él mismo subió; el controlador comprueba `uploadedBy`.
router.delete(
  '/:patientId/follow-ups/:followUpId/attachments/:attachmentId',
  allRoles,
  deleteFollowUpAttachment
);

module.exports = router;
