const { nowHHMM, localDayAtNoon } = require('./appointmentDate');
const { asignarTurnos, completarTurno } = require('./appointmentTurns');
const { esPrimeraVisita } = require('./firstVisit');

/**
 * LA CITA DE UNA ATENCIÓN SIN CITA.
 *
 * Hay consultas que empiezan sin haber pasado por la agenda: en óptica el
 * cliente entra por la puerta, y en enfermería el paciente llega a que le pongan
 * un suero. Obligar a quien atiende a salir, agendar una cita a la hora que ya
 * es y volver, es papeleo puro — y desde que la agenda va por espacios de tiempo
 * ni siquiera se puede: agendar a las 14:07 lo rechaza la propia validación.
 *
 * Pero la cita TIENE que existir. No es burocracia: de ella cuelgan la agenda,
 * los reportes, las comisiones, «paciente nuevo» y el cobro. Un seguimiento sin
 * cita es una atención que ocurrió y que el sistema no vio.
 *
 * FUENTE ÚNICA a propósito: la usan la atención inmediata de óptica
 * (`createWalkIn`), el guardado de un seguimiento sin cita (`addFollowUp`) y el
 * suero que mostrador receta para que lo ponga enfermería (mismo `addFollowUp`,
 * con `sinDueno`). Que cada una construyera su cita a mano es como acaban tres
 * flujos gemelos separándose en silencio.
 *
 * @param {object} opts
 * @param {'abierta'|'cerrada'} opts.estado  'abierta' = el profesional va a
 *        atender ahora (queda 'asistida' y su turno en marcha). 'cerrada' = ya
 *        atendió y el seguimiento está escrito (queda 'completada').
 * @param {string} [opts.followUpId] seguimiento que escribió, si ya está hecho.
 * @param {'doctor'|'enfermeria'} [opts.kind] qué clase de turno se abre. El
 *        enfermero que aplica un suero sin cita NO puede quedar como el doctor
 *        de la cita: `apt.doctor` es el espejo del turno médico, y de ahí salen
 *        las comisiones de médico y los reportes por doctor. Le pagaríamos como
 *        a un doctor y las estadísticas dirían que atendió una consulta.
 * @param {boolean} [opts.sinDueno] el turno nace SIN dueño: sale a la bandeja de
 *        todos los enfermeros y lo toma el primero que lo vea. Es lo que pasa
 *        cuando quien escribe NO es quien va a atender — mostrador receta un
 *        suero y lo pone enfermería. Solo tiene sentido con `kind:'enfermeria'`:
 *        la cola de doctores va nombrada (`asignarTurnos` descarta un paso de
 *        doctor sin usuario y la cita nacería sin turnos, invisible para todos).
 * @param {number} [opts.seguimientosDeEstaAtencion] cuántas consultas de la
 *        historia son de esta misma atención, para no contarlas como pasado al
 *        decidir si el paciente es nuevo (ver utils/firstVisit.js).
 */
async function crearCitaAtencionInmediata({
  Appointment,
  clinicId,
  patientId,
  user,
  role,
  serviceItem = null,
  serviceName = '',
  reason = 'Atención inmediata',
  estado = 'abierta',
  followUpId = null,
  kind = 'doctor',
  sinDueno = false,
  seguimientosDeEstaAtencion = 0,
}) {
  const ahora = new Date();
  const esEnfermeria = kind === 'enfermeria';
  // Un turno sin dueño solo existe en enfermería (ver `sinDueno` arriba).
  const paraLaBandeja = sinDueno && esEnfermeria;
  const primeraVisita = await esPrimeraVisita(patientId, {
    ignoraSeguimientos: seguimientosDeEstaAtencion,
  });

  const apt = new Appointment({
    clinic: clinicId,
    patient: patientId,
    /**
     * EL DÍA, no el instante. `date` guarda el día a las 12:00 como cualquier
     * cita agendada, y la hora real va en `startTime`.
     *
     * Con `new Date()` a secas la hora se colaba dentro del campo del día, y el
     * filtro de la agenda —que arranca el rango en la fecha normalizada— dejaba
     * fuera todo lo registrado ANTES del mediodía: la atención existía, salía el
     * aviso, y en la lista del día no aparecía nadie.
     */
    date: localDayAtNoon(ahora),
    startTime: nowHHMM(),
    /**
     * Se salta 'pendiente' a propósito: el paciente ya está delante. Además
     * evita que `autoNoShow` la marque como ausente por su hora de inicio —una
     * cita creada a la hora que es sería ausente un minuto después—.
     */
    status: 'asistida',
    reason,
    serviceItem: serviceItem || null,
    serviceName: serviceName || '',
    isFirstVisit: primeraVisita,
    createdBy: user._id,
    createdByName: user.name || '',
    createdByRole: role || null,
    /**
     * El reloj solo arranca si hay alguien atendiendo. En la cita que se deja
     * PREPARADA para enfermería todavía no ha entrado nadie: ponerle hora de
     * inicio diría en la agenda «atendida a las 10:12» de un suero que sigue sin
     * poner, y el turno lo sellará su hora de verdad cuando lo reclamen.
     */
    consultationStartedAt: paraLaBandeja ? undefined : ahora,
  });

  // Un único turno, el suyo —de doctor o de enfermería, según quién atendió— y
  // con su nombre puesto: al guardar el seguimiento la cita se cierra sola como
  // cualquier otra. Si es para la bandeja, va sin dueño y lo toma quien pueda.
  asignarTurnos(apt, {
    pasos: [{
      kind: esEnfermeria ? 'enfermeria' : 'doctor',
      user: paraLaBandeja ? null : user._id,
      serviceName,
      serviceItem,
    }],
    por: user._id,
  });
  if (apt.turns[0] && !paraLaBandeja) apt.turns[0].startedAt = ahora;

  if (estado === 'cerrada') {
    // Ya atendió: el turno se cierra aquí mismo, con su seguimiento colgado, y
    // la cita nace completada. Sin esto quedaría una cita abierta para siempre
    // en la agenda de alguien que ya terminó.
    completarTurno(apt, { userId: user._id, followUpId });
    apt.status = 'completada';
    apt.consultationEndedAt = ahora;
  }

  await apt.save();
  return apt;
}

module.exports = { crearCitaAtencionInmediata };
