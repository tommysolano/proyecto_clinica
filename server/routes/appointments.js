const router = require('express').Router();
const {
  getAppointments,
  getCalendarSummary,
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
  setSerumStatus,
  markNoShow,
  markConfirmed,
  assignDoctor,
  nurseClaim,
  nurseComplete,
  appointmentsByService,
} = require('../controllers/appointmentController');
const { auth, requireClinic, requireRole } = require('../middleware/auth');

router.use(auth, requireClinic);

router.get('/today', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getTodayAppointments);
router.get('/stats', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getStats);
/**
 * ANALÍTICAS: citas agendadas por servicio. Va por delante del `/:id` de abajo
 * (y con dos segmentos, así ni siquiera llega a rozarlo): administra y marketing
 * leen el informe, que es el mismo alcance con el que ven la agenda.
 */
router.get('/analytics/by-service', requireRole('admin', 'marketing'), appointmentsByService);
router.get('/', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getAppointments);
/**
 * RESUMEN DEL CALENDARIO: por día, solo total y contadores por estado. Va
 * ANTES de `/:id` para que no lo capture esa ruta (un id de ObjectId no puede
 * ser 'calendar-summary', pero Express igualmente se lo llevaría por orden).
 * Mismos roles que la lista: quien la ve puede contarla.
 */
router.get('/calendar-summary', requireRole('admin', 'cajero', 'doctor', 'call_center', 'enfermero', 'marketing'), getCalendarSummary);
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
 * MARKETING AGENDA DESDE LA AGENDA (sep-2026): ya editaba y borraba citas, pero
 * la CREACIÓN era de mostrador y le obligaba a pedirle a otro que la escribiera
 * — el mismo motivo por el que se le abrió editar (líneas abajo).
 *
 * Lo que NO se le abre a odontología es editar la cita después (`PUT /:id`):
 * eso sigue siendo de mostrador, por lo mismo que se le quitó al doctor en su
 * día — el formulario entero incluye fecha, hora, paciente y precio de una
 * visita que suele ser suya.
 */
router.post('/', requireRole('admin', 'cajero', 'call_center', 'marketing', 'odontologia', 'odontologia_neurofocal'), createAppointment);
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
 *
 * MARKETING se sumó (sep-2026): agenda y cierra citas desde el chat del CRM —
 * donde es supervisor de la bandeja— y también las elimina; si no puede
 * editarlas, no puede corregir lo que él mismo agendó. El controlador repite
 * la regla.
 */
router.put('/:id', requireRole('admin', 'cajero', 'call_center', 'marketing'), updateAppointment);
router.post('/:id/start', requireRole('admin', 'doctor'), startConsultation);
router.post('/:id/end', requireRole('admin', 'doctor'), endConsultation);
router.post('/:id/confirm', requireRole('admin', 'cajero', 'call_center', 'enfermero'), markConfirmed);
router.post('/:id/attended', requireRole('admin', 'cajero', 'enfermero'), markAttended);
// Servicio y valor de la cita: SOLO mostrador (admin/cajero), y a diferencia del
// PUT general vale también con la cita ya completada. Es lo único que se puede
// corregir después de atender; quién atendió, nunca.
router.patch('/:id/service-value', requireRole('admin', 'cajero'), updateServiceAndValue);
/**
 * EL SUERO QUE ENFERMERÍA APLICARÁ, decidido por mostrador (sep-2026).
 *
 * 'aplazado' marca que el paciente decidió no aplicarse el suero en esa visita:
 * la cita queda en la agenda general con su indicativo «Suero pendiente» y no
 * sale a la bandeja de enfermería hasta que se le asigne uno. Solo mostrador
 * tiene la palabra: es quien recibe al paciente y a quien va a cobrar.
 */
router.patch('/:id/serum-status', requireRole('admin', 'cajero'), setSerumStatus);
/**
 * ODONTOLOGÍA ATENDE DIRECTO (sep-2026): se suma a la cola de recepción.
 * El controlador solo le acepta la cita asignada a SÍ MISMO — no puede
 * repartir la atención de los demás. Ver `assignDoctor`.
 */
router.post('/:id/assign-doctor', requireRole('admin', 'cajero', 'enfermero', 'odontologia', 'odontologia_neurofocal'), assignDoctor);
router.post('/:id/no-show', requireRole('admin', 'cajero', 'enfermero'), markNoShow);
router.post('/:id/nurse-claim', requireRole('admin', 'enfermero'), nurseClaim);
router.post('/:id/nurse-complete', requireRole('admin', 'enfermero'), nurseComplete);
/**
 * ELIMINAR UNA CITA: ADMINISTRACIÓN Y MARKETING (sep-2026, a petición de los
 * usuarios).
 *
 * Se le quitó a mostrador y al call center, que la tenían. El motivo es que
 * eliminar dejó de ser reversible: antes la cita se quedaba en 'cancelada' y
 * cualquier error se veía y se arreglaba; ahora se borra de verdad y no hay
 * dónde ir a buscarla. Quien agenda todo el día tiene el reagendamiento y los
 * estados para lo suyo; borrar es una decisión de quien responde por la agenda.
 *
 * El controlador repite la regla: la ruta protege la pantalla, no a la API.
 */
router.delete('/:id', requireRole('admin', 'marketing'), deleteAppointment);

module.exports = router;
