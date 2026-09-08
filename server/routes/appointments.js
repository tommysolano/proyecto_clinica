const router = require('express').Router();
const {
  getAppointments,
  getAppointment,
  createAppointment,
  exportAppointments,
  createWalkIn,
  updateAppointment,
  deleteAppointment,
  getTodayAppointments,
  getAppointmentPdf,
  startConsultation,
  endConsultation,
  getStats,
  markAttended,
  updateServiceAndValue,
  markNoShow,
  markConfirmed,
  assignDoctor,
  nurseClaim,
  nurseComplete,
} = require('../controllers/appointmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/today', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getTodayAppointments);
router.get('/stats', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getStats);
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getAppointments);
router.get('/:id', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getAppointment);
router.get(
  '/:id/pdf',
  requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero'),
  getAppointmentPdf
);
/**
 * EL EXCEL DE LA AGENDA. Va por POST porque lleva los ids de las citas que la
 * pantalla está enseñando (un mes son cientos y no caben en una URL), y así el
 * archivo dice EXACTAMENTE lo que el usuario tiene delante: la agenda filtra en
 * el navegador y rehacer aquí ese filtrado se desincroniza a la primera.
 *
 * Mostrador entra con administración: es quien cuadra el día y quien tenía que
 * pedirle el archivo a un administrador cada vez. No lleva datos de contacto
 * (ver services/agendaWorkbook.js), así que no abre nada que no vea ya.
 */
router.post('/export.xlsx', requireRole('admin', 'cajero'), exportAppointments);

/**
 * ODONTOLOGÍA AGENDA (sep-2026, a petición del usuario).
 *
 * Va ENUMERADA, no por 'doctor': ese se expande a TODAS las especialidades
 * (ver constants/roles.js) y agendar no se le abre a quien no lo ha pedido.
 *
 * El motivo es el de su consulta: el paciente sale del sillón con el control a
 * quince días y quien lo sabe es quien acaba de atenderlo. Hasta ahora tenía que
 * bajar al mostrador a que se lo agendaran — y desde «Clientes», al registrar un
 * paciente y marcar «agendar cita», se llevaba un 403 con el paciente ya creado.
 *
 * Lo que NO se le abre es editar la cita después (`PUT /:id`): eso sigue siendo
 * de mostrador, por lo mismo que se le quitó al doctor en su día — el formulario
 * entero incluye fecha, hora, paciente y precio de una visita que suele ser
 * suya.
 */
router.post('/', requireRole('admin', 'cajero', 'call_center', 'odontologia'), createAppointment);
// ATENCIÓN INMEDIATA: crea la cita ya asignada a quien la pide. 'doctor' expande
// a las especialidades — nace para óptica, donde el paciente entra sin cita y lo
// registra el propio optómetra.
router.post('/walk-in', requireRole('admin', 'doctor'), createWalkIn);
/**
 * EDITAR LA CITA es de mostrador: fecha, hora, servicio, paciente, precio.
 *
 * 'doctor' y 'enfermero' estaban aquí de cuando esta ruta era también por donde
 * se atendía; hoy la consulta va por `/start` y `/end` y lo que se escribe va a
 * la ficha clínica. Lo único que les quedaba abierto era el formulario de la
 * cita, que no es trabajo clínico. El controlador aplica la misma regla.
 */
router.put('/:id', requireRole('admin', 'cajero', 'call_center'), updateAppointment);
router.post('/:id/start', requireRole('admin', 'doctor'), startConsultation);
router.post('/:id/end', requireRole('admin', 'doctor'), endConsultation);
router.post('/:id/confirm', requireRole('admin', 'cajero', 'call_center', 'enfermero'), markConfirmed);
router.post('/:id/attended', requireRole('admin', 'cajero', 'enfermero'), markAttended);
// Servicio y valor de la cita: SOLO mostrador (admin/cajero), y a diferencia del
// PUT general vale también con la cita ya completada. Es lo único que se puede
// corregir después de atender; quién atendió, nunca.
router.patch('/:id/service-value', requireRole('admin', 'cajero'), updateServiceAndValue);
router.post('/:id/assign-doctor', requireRole('admin', 'cajero', 'enfermero'), assignDoctor);
router.post('/:id/no-show', requireRole('admin', 'cajero', 'enfermero'), markNoShow);
router.post('/:id/nurse-claim', requireRole('admin', 'enfermero'), nurseClaim);
router.post('/:id/nurse-complete', requireRole('admin', 'enfermero'), nurseComplete);
router.delete('/:id', requireRole('admin', 'cajero', 'call_center'), deleteAppointment);

module.exports = router;
