const Appointment = require('../models/Appointment');
const Product = require('../models/Product');
const Patient = require('../models/Patient');
// Se importa aunque no se use directamente aquí: `populate('serviceItem')` falla
// con "Schema hasn't been registered" si el modelo no se ha cargado nunca.
require('../models/AppointmentServiceItem');
// Igual con el consultorio (ya no se pide al agendar, pero las citas viejas lo
// tienen y el listado lo sigue poblando) y con la sucursal.
require('../models/Room');
const Clinic = require('../models/Clinic');
const { emitToClinic, emitToUser, emitToRole } = require('../realtime');
const {
  asignarTurnos,
  fijarDoctorDeLaCita,
  doctoresPendientes,
  doctorEnTurno,
  enfermeroEnTurno,
  turnoVigenteEsEnfermeria,
  filtroCitasDelDoctor,
  filtroCitasDeEnfermeria,
  sincronizarEspejo,
  turnoVigente,
} = require('../utils/appointmentTurns');
const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
const { crearCitaAtencionInmediata } = require('../utils/walkInAppointment');
// Buscar al paciente como lo dice la gente: por palabras sueltas y sin tildes el
// nombre, por dígitos el teléfono.
const { nameSearchFilter } = require('../utils/nameSearch');
const { phoneSearchRegex } = require('../utils/phoneNormalize');
const {
  nowHHMM,
  isPastLocalDate,
  isFutureLocalDate,
  isPastLocalDateTime,
  isValidSlotTime,
  slotMessage,
  isSameLocalDay,
  appointmentDateTime,
  PAST_DATE_MESSAGE,
  PAST_TIME_MESSAGE,
} = require('../utils/appointmentDate');
const { isDoctorRole } = require('../constants/roles');
const {
  sucursalesVisibles,
  alcanzaSucursal,
  validarSucursalDestino,
} = require('../utils/clinicScope');
const { esPrimeraVisita } = require('../utils/firstVisit');
const { registrarLlegada } = require('../utils/appointmentArrival');
const { resolverAgendadoPor } = require('../utils/appointmentBooker');

/**
 * Espacios de la agenda de una sucursal, en minutos (0 = cualquier hora).
 *
 * Se lee en cada agendamiento y no se cachea: es un ajuste que se toca una vez
 * al año, y cachearlo haría que el cambio del administrador tardara en notarse
 * justo cuando lo acaba de hacer para probarlo.
 */
async function slotMinutesDeClinica(clinicId) {
  const c = await Clinic.findById(clinicId).select('appointmentSlotMinutes').lean();
  return Number(c?.appointmentSlotMinutes) || 0;
}

// Construye el payload de evento de dominio para una cita (para workflows).
// appointmentDate lleva la hora REAL de la cita (date = día calendario +
// startTime): los pasos "esperar hasta la cita" calculan desde aquí; con solo
// `date` (12:00) el recordatorio salía a una hora que no era.
function appointmentEventPayload(appt) {
  const patientId = appt.patient?._id || appt.patient;
  return {
    clinicId: String(appt.clinic),
    patientId: patientId ? String(patientId) : null,
    appointmentId: String(appt._id),
    appointmentDate: appointmentDateTime(appt.date, appt.startTime),
    isFirstVisit: !!appt.isFirstVisit,
    services: (appt.services || []).map((s) => String(s.product?._id || s.product)).filter(Boolean),
  };
}

// `nowHHMM` vive en utils/appointmentDate.js: la comparten el sello de los
// signos vitales y la hora de una atención inmediata.

/**
 * Un doctor que YA atendió al paciente no se puede reemplazar: la consulta quedó
 * a su nombre y la comisión ya está congelada en la venta (Sale.doctor), así que
 * cambiarlo después mentiría sobre quién atendió. Antes de eso —agendada,
 * confirmada, paciente en sala, consulta en curso— la reasignación es libre.
 */
const consultationDone = (apt) => apt.status === 'completada' || !!apt.consultationEndedAt;
const DOCTOR_LOCKED_MESSAGE =
  'La consulta ya fue atendida: no se puede reasignar el doctor. Si hubo un error, corrige el registro con un administrador.';

/**
 * Tope de citas por Excel. Un mes de agenda de tres sedes no pasa de unos
 * cientos; el límite está para que una lista de ids manipulada no pida medio
 * millón de documentos y tumbe el proceso.
 */
const MAX_CITAS_EXCEL = 5000;

const POPULATE_PATIENT = 'firstName lastName cedula phone whatsapp email birthDate age gender';
const POPULATE_DOCTOR = 'name specialty';
const POPULATE_CREATOR = 'name email';
/**
 * El servicio de agenda que viaja con la cita. `autoSerum` va incluido porque la
 * pantalla de asignar atención necesita saber si el servicio YA escribe su propia
 * bolsa: sin ese dato ofrecía «escoger el suero» como si no hubiera ninguno, y lo
 * que escogía mostrador se escribía como una SEGUNDA receta con el mismo nombre.
 */
const POPULATE_SERVICE_ITEM = 'name color nursingService autoSerum';

// Convierte 'YYYY-MM-DD' (o ISO) a Date en zona local, fijando 12:00 para evitar
// que el cambio de zona horaria mueva el día al guardar/leer.
const parseLocalDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0);
  }
  return new Date(str);
};

// Valida 'HH:MM' (24h) y devuelve minutos desde medianoche, o null si inválido.
const toMinutes = (hhmm) => {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
};

/**
 * FILTRO DE SUCURSAL PARA BUSCAR UNA CITA QUE SE VA A TOCAR.
 *
 * Tiene que ser EL MISMO alcance con el que se LEE la agenda: mostrador y
 * administración operan la organización entera, y el resto de roles las
 * sucursales que tienen asignadas (que es lo que devuelve `clinic=all`).
 *
 * Buscarla por la sucursal ACTIVA (`clinic: req.clinicId`) era el «Cita no
 * encontrada» al asignar el doctor: una cita agendada por caja para OTRA sede
 * se ve perfectamente en la agenda —que es org-wide para caja—, pero cualquier
 * botón sobre ella respondía que no existía. La lectura y la escritura no
 * usaban la misma regla.
 *
 * OJO al usarlo: una vez encontrada la cita, todo lo que dependa de la sucursal
 * (bloqueos de horario, avisos en tiempo real, notificaciones push, el
 * seguimiento de enfermería) va con `cita.clinic`, NUNCA con `req.clinicId`, o
 * acabaría en la sede equivocada.
 */
const filtroSucursalCita = (req) => {
  const visibles = sucursalesVisibles(req);
  if (visibles === null) return {};
  return { clinic: { $in: [req.clinicId, ...visibles] } };
};

exports.getAppointments = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      doctor,
      status,
      createdBy,
      isFirstVisit,
      service,
      fromTime,
      toTime,
      room,
      patient,
      origin,
      q,
      clinic: clinicParam,
    } = req.query;
    // Conjunto de sucursales a consultar:
    //  - `clinic=all` → VISTA UNIFICADA: todas las sucursales a las que el usuario
    //    tiene acceso (superadmin = todas). Así ninguna cita queda "escondida" por
    //    la sucursal activa (p.ej. una cita creada con "sucursal destino" distinta).
    //  - `clinic=<id>` (distinto al activo, con acceso) → esa sucursal (call center
    //    agendando para otra sede).
    //  - por defecto → la sucursal activa del usuario.
    /**
     * QUIÉN VE LA AGENDA DE TODAS LAS SUCURSALES (`sedesVisibles === null`).
     *
     * Sale de `sucursalesVisibles`, la MISMA función que usa `filtroSucursalCita`
     * para las escrituras: leer y escribir tienen que responder igual, o la cita
     * se ve en la lista y ningún botón la encuentra. Son dos motivos:
     *
     *  · POR EL ROL — mostrador, administración y call center. El cajero está
     *    asignado a UNA sede y con eso el filtro «Todas las sucursales» no le
     *    salía nunca; pero quien atiende el mostrador y el teléfono necesita ver
     *    dónde está agendado un paciente sin preguntar por otra sede.
     *  · POR LA PERSONA — quien está marcado como «trabaja en todas las
     *    sucursales». Es el caso de la enfermera que cubre dos sedes: sus citas
     *    del día estaban agendadas en la otra y la agenda le salía VACÍA.
     *
     * Al resto —un doctor o un enfermero de una sola sede— no le cambia nada:
     * sigue viendo las sucursales que tiene asignadas.
     */
    const sedesVisibles = sucursalesVisibles(req);
    let clinicScope; // valor para query.clinic; null = sin filtro (todas)
    if (clinicParam === 'all') {
      clinicScope = sedesVisibles === null ? null : { $in: sedesVisibles };
    } else if (clinicParam && String(clinicParam) !== String(req.clinicId)) {
      clinicScope = alcanzaSucursal(req, clinicParam) ? clinicParam : req.clinicId;
    } else {
      clinicScope = req.clinicId;
    }
    const query = {};
    if (clinicScope !== null) query.clinic = clinicScope;

    if (startDate && endDate) {
      /**
       * EL RANGO ES DE DÍAS ENTEROS, POR LAS DOS PUNTAS.
       *
       * `parseLocalDate` devuelve las 12:00 (así se guarda `date`), y el final
       * se estiraba a las 23:59 pero el principio se quedaba a mediodía. Con las
       * citas agendadas daba igual —todas caen justo en las 12:00— pero una cita
       * registrada con la hora dentro del campo del día, como las atenciones sin
       * cita de la MAÑANA, quedaba por debajo del corte: existía y no salía.
       */
      const start = parseLocalDate(startDate);
      const end = parseLocalDate(endDate);
      if (start) start.setHours(0, 0, 0, 0);
      if (end) end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }
    if (doctor) query.doctor = doctor;
    if (status) query.status = status;
    if (createdBy) query.createdBy = createdBy;
    if (isFirstVisit === 'true') query.isFirstVisit = true;
    else if (isFirstVisit === 'false') query.isFirstVisit = { $ne: true };
    if (service) query['services.product'] = service;
    if (room) query.room = room;
    if (patient) query.patient = patient;
    if (origin) query.origin = origin;
    // Filtro por rango de horario (HH:MM)
    if (fromTime && toTime) {
      query.startTime = { $gte: fromTime, $lte: toTime };
    } else if (fromTime) {
      query.startTime = { $gte: fromTime };
    } else if (toTime) {
      query.startTime = { $lte: toTime };
    }

    if (isDoctorRole(req.role)) {
      // Su turno VIGENTE o uno que ya atendió: al doctor que va segundo la cita
      // no le aparece hasta que el primero termine (ver filtroCitasDelDoctor).
      Object.assign(query, filtroCitasDelDoctor(req.user._id));
    }
    // El call center puede ver TODAS las citas agendadas (no solo las suyas).
    if (req.role === 'enfermero') {
      Object.assign(query, await filtroEnfermeria(req));
    }

    /**
     * Búsqueda libre por paciente (nombre, apellido, cédula o teléfono).
     *
     * POR PALABRAS SUELTAS y sin tildes (ver `utils/nameSearch.js`): «tommy
     * solano» encuentra a «TOMMY NELSON SOLANO PEÑAFIEL», que con la expresión
     * regular del texto tal cual no aparecía. El teléfono va aparte, por
     * `phoneSearchRegex`, que compara dígitos y no se puede partir en palabras.
     */
    if (q && String(q).trim()) {
      const term = String(q).trim();
      const porNombre = nameSearchFilter(term, ['firstName', 'lastName', 'cedula']);
      const telefono = phoneSearchRegex(term);
      const alternativas = [
        ...(porNombre ? [porNombre] : []),
        ...(telefono ? [{ phone: telefono }, { whatsapp: telefono }] : []),
      ];
      const matched = await Patient.find({
        ...(clinicScope !== null ? { clinic: clinicScope } : {}),
        // Sin ninguna alternativa (texto de solo signos) no debe casar nada, y
        // un `$or: []` lo rechaza mongo.
        ...(alternativas.length ? { $or: alternativas } : { _id: null }),
      }).select('_id');
      const ids = matched.map((p) => p._id);
      if (query.patient) {
        // Si ya filtró por paciente concreto, lo respetamos.
      } else {
        query.patient = { $in: ids };
      }
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('room', 'name code')
      .populate('clinic', 'name nombreComercial')
      .populate('services.product', 'name code salePrice category nursingService')
      .sort({ date: 1, startTime: 1 });

    res.json(appointments);
  } catch (error) {
    console.error('[getAppointments] ERROR:', error);
    res.status(500).json({ message: 'Error al obtener citas', error: error.message, stack: error.stack });
  }
};

exports.getAppointment = async (req, res) => {
  try {
    // Vista unificada: la cita puede pertenecer a cualquier sucursal del usuario.
    const appointment = await Appointment.findOne({ _id: req.params.id })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('clinic', 'name nombreComercial')
      .populate('rescheduleHistory.rescheduledBy', 'name email')
      .populate('referral', 'fromDoctor toDoctor specialty reason status')
      .populate('treatmentRef', 'name status')
      .populate('services.product', 'name code salePrice category nursingService');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    /**
     * ALCANCE: la MISMA fuente que la lista y que las escrituras.
     *
     * Aquí se armaba a mano con `user.clinics[]` a secas, y ese era el último
     * espejo que quedaba sin actualizar del arreglo de «la enfermera que rota
     * entre sedes»: el check de «trabaja en todas las sucursales» ya valía para
     * VER la agenda y para tocar la cita, pero no para leer UNA cita por id.
     *
     * Se veía así, y cuesta relacionarlo con una sucursal: la enfermera abría la
     * ficha del paciente desde el aviso, veía sus seguimientos —esos no se
     * filtran por sede— y no le salía «Terminar mi parte», porque la pantalla
     * pide la cita por id para saber de quién es el turno y esa petición
     * devolvía 404. Tenía que salir a la agenda a cerrarla, donde sí funcionaba.
     */
    const apptClinicId = String(appointment.clinic?._id || appointment.clinic);
    const visibles = sucursalesVisibles(req);
    const canAccess = visibles === null || visibles.some((c) => String(c) === apptClinicId);
    if (!canAccess) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    // Con el motivo: el resto del archivo lo devuelve y aquí no, así que un fallo
    // de esta ruta llegaba como un 500 mudo imposible de diagnosticar.
    res.status(500).json({ message: 'Error al obtener cita', error: error.message });
  }
};

const buildServicesSnapshot = async (clinicId, items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const ids = items
    .map((s) => (typeof s === 'string' ? s : s.product))
    .filter(Boolean);
  if (ids.length === 0) return [];
  // Catálogo compartido entre sucursales: se resuelve el servicio por _id, no por la
  // sucursal dueña. La disponibilidad por sucursal (availableInClinics) se valida
  // aparte en createAppointment.
  const products = await Product.find({ _id: { $in: ids } }).select(
    'name salePrice'
  );
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((p) => ({ product: p._id, name: p.name, price: p.salePrice }));
};

// El valor de la cita, su canje y su pago adelantado viven en su propia
// utilidad: entran por cinco puertas y una copia por puerta ya se demostro que
// se desincroniza (ver utils/appointmentValue.js).
const { puedeFijarValor, aplicarValorDeCita } = require('../utils/appointmentValue');
/**
 * Resuelve el servicio de agenda y le suma un uso (ordena el buscador por lo
 * más pedido). Devuelve null si no llega ninguno: el servicio dejó de ser
 * obligatorio para poder agendar.
 */
async function resolverServicioAgenda(serviceItemId) {
  if (!serviceItemId) return null;
  try {
    const AppointmentServiceItem = require('../models/AppointmentServiceItem');
    return await AppointmentServiceItem.findByIdAndUpdate(
      serviceItemId,
      { $inc: { usageCount: 1 } },
      { new: true }
    );
  } catch {
    return null;
  }
}

/**
 * QUIEN ATIENDE TIENE QUE SER DE LA SUCURSAL DE LA CITA.
 *
 * Caja asigna citas de cualquier sede desde su mostrador, y el selector le
 * ofrece el personal DE ESA SEDE. Pero si llega un id de otra sucursal —una
 * pestaña abierta desde antes, una pantalla sin recargar— la cita quedaría a
 * nombre de alguien que no la va a ver nunca: la agenda de un doctor filtra por
 * las sucursales que tiene asignadas. Un error claro en el mostrador es mucho
 * mejor que una cita en el limbo.
 *
 * Fuente única de las DOS puertas por las que se reparte la atención: asignarla
 * cuando el paciente llega (`assignDoctor`) y dejarla elegida al agendar
 * (`createAppointment`). Ya pasó una vez que una comprobación sobre personal se
 * quedó sin `worksInAllClinics` y el selector ofrecía a quien la escritura
 * rechazaba (ver la memoria de "personal en todas las sucursales").
 *
 * @returns {string|null} el mensaje de error, o null si todo el mundo encaja.
 */
async function validarPersonalDeLaSede(ids, clinicId) {
  const aAsignar = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!aAsignar.length) return null;

  const User = require('../models/User');
  const encontrados = await User.find({ _id: { $in: aAsignar } })
    .select('name clinics active isSuperAdmin worksInAllClinics')
    .lean();
  /**
   * Se juzga solo a quien TIENE sucursales asignadas: si el usuario no tiene
   * ninguna no se sabe dónde atiende, y el caso que importa —el doctor que
   * trabaja en otra sede— siempre las tiene. El super-admin ve todas las
   * sucursales, así que él nunca está fuera. Y `worksInAllClinics` —el check de
   * "rota entre sedes"— cuenta aquí igual que en `getRoleForClinic`: si el
   * selector se lo ofrece al mostrador, tiene que poder asignarlo.
   */
  const atiendeAqui = (u) =>
    u.active !== false &&
    (u.isSuperAdmin ||
      u.worksInAllClinics ||
      !(u.clinics || []).length ||
      (u.clinics || []).some((c) => String(c.clinic) === String(clinicId)));
  const fuera = encontrados.filter((u) => !atiendeAqui(u));
  if (!fuera.length && encontrados.length === aAsignar.length) return null;

  const nombres = fuera.map((u) => u.name).filter(Boolean).join(', ');
  return nombres
    ? `${nombres} no atiende en la sucursal de esta cita. Elige personal de esa sede.`
    : 'Alguien de la cola ya no existe o no atiende en la sucursal de esta cita.';
}

/**
 * Normaliza la cola de atención que llega del cliente (`steps`).
 *
 * Un paso de doctor SIN persona no existe (`asignarTurnos` lo descarta y la
 * cita nacería sin turnos, invisible para todos); uno de enfermería sí: sin
 * nombre sale a la bandeja de todos y lo toma el primero que lo vea.
 */
function normalizarPasos(steps) {
  if (!Array.isArray(steps)) return [];
  const { saneaSueroPlano } = require('../utils/suero');
  return steps
    .map((p) => {
      if (p?.kind !== 'enfermeria') return p?.user ? { kind: 'doctor', user: String(p.user) } : null;
      /**
       * El suero del paso se sanea contra el catálogo por la MISMA función que
       * la receta: así la ampolla se guarda con su código y, al aplicarla, se
       * encuentra en el inventario y se descuenta. Sin ampollas no hay suero
       * (una bolsa vacía no es nada que aplicar).
       *
       * Un suero solo tiene sentido en un turno de enfermería: el doctor receta,
       * no pone la vía.
       */
      const suero = saneaSueroPlano(p.serum);
      return {
        kind: 'enfermeria',
        user: p.user ? String(p.user) : null,
        serviceName: String(p.serviceName || '').trim(),
        serviceItem: p.serviceItem || null,
        serum: suero ? { base: suero.serumBase, components: suero.serumComponents } : undefined,
        // Lo devuelve la pantalla tal cual lo recibió: es la marca de que ese
        // suero YA está escrito en la ficha y no hay que volver a escribirlo.
        serumFollowUp: suero && p.serumFollowUp ? p.serumFollowUp : null,
        // Y si lo que escogió mostrador se SUMA a la bolsa del servicio en vez
        // de abrir una receta nueva (ver el campo en models/Appointment.js).
        serumMergeIntoService: !!(suero && p.serumMergeIntoService),
        /**
         * SEÑAL DE LA PANTALLA, no un campo del turno: `asignarTurnos` copia
         * campos concretos y este no está, así que no se guarda en la cita.
         *
         * Dice que ese suero se CORRIGIÓ a mano y que hay que reescribir la
         * receta que ya estaba, en vez de dejarla como está. Antes la pantalla
         * resolvía esto mandando `serumFollowUp: null`, y eso escribía una
         * SEGUNDA bolsa dejando la equivocada en la ficha.
         */
        serumTocado: !!(suero && p.serumFollowUp && p.serumTocado),
      };
    })
    .filter(Boolean);
}

/**
 * ESCRIBE EN LA FICHA LOS SUEROS DE LOS TURNOS, Y CORRIGE LOS QUE CAMBIARON.
 *
 * Recorre los turnos de enfermería con suero indicado:
 *   · sin escribir todavía  → lo escribe como una línea de receta más —la que
 *     enfermería puede dar por aplicada— y anota en el turno dónde quedó;
 *   · ya escrito y sin tocar → no hace nada. Volver a guardar la asignación no
 *     duplica: es la marca la que lo impide, no la suerte;
 *   · ya escrito y CORREGIDO (viene en `tocados`) → reescribe AQUELLA receta.
 *     Sin esto, quien se equivocaba de ampolla no tenía vuelta atrás desde la
 *     cita: la pantalla solo decía «ya está en los seguimientos».
 *
 * Devuelve qué se escribió, qué se corrigió y qué no se pudo tocar porque el
 * paciente ya lo tenía puesto, para que la pantalla lo diga.
 */
async function sembrarSuerosDeLosTurnos(apt, req, { tocados = new Set() } = {}) {
  const {
    sembrarSueroEnFicha, sumarSueroAlSeguimiento, reescribirSueroDelSeguimiento,
  } = require('../utils/sueroDeCita');
  const { lineaDeRecetaDeSuero } = require('../utils/suero');
  const sembrados = [];
  const corregidos = [];
  const avisos = [];

  /**
   * LA BOLSA DEL SERVICIO SOLO LA REESCRIBE UN PASO.
   *
   * «Sumar a la bolsa del servicio» (`serumMergeIntoService`) reescribe la
   * composición de una receta que ya existe. Con DOS pasos de enfermería
   * marcados así —un detox en dos tandas, cada una con sus ampollas— el segundo
   * pisaba lo que había escrito el primero y esas ampollas desaparecían de la
   * ficha sin que nadie lo notara: peor que duplicar, porque no se ve.
   *
   * Así que se funde UNO —el primero, que es el que de verdad continúa el suero
   * del servicio— y los siguientes escriben su propia receta, que es lo que son:
   * otra preparación.
   */
  const yaFundidoEnElServicio = (apt.turns || []).some(
    (t) => t.kind === 'enfermeria' && t.serumFollowUp &&
      String(t.serumFollowUp) === String(apt.autoSerumFollowUp || '')
  );
  let fundidoEnEstaPasada = false;

  for (const turno of apt.turns || []) {
    if (turno.kind !== 'enfermeria') continue;
    const componentes = turno.serum?.components || [];
    if (!componentes.length) continue;

    const linea = lineaDeRecetaDeSuero(
      { serumBase: turno.serum.base, serumComponents: componentes.map((c) => c.toObject?.() || c) },
      turno.serviceName || apt.serviceName
    );

    /**
     * YA ESTÁ ESCRITO: o se deja como está, o se corrige.
     *
     * La corrección es la puerta que faltaba —se escogió la ampolla equivocada
     * y la cita no dejaba arreglarlo—. Se reescribe AQUELLA receta y no se abre
     * otra: dos bolsas en la ficha se leen como dos sueros recetados.
     */
    if (turno.serumFollowUp) {
      if (!tocados.has(String(turno.serumFollowUp))) continue;
      // La del SERVICIO conserva su nombre (ver reescribirSueroDelSeguimiento).
      const esLaDelServicio = String(turno.serumFollowUp) === String(apt.autoSerumFollowUp || '');
      // eslint-disable-next-line no-await-in-loop
      const r = await reescribirSueroDelSeguimiento({
        patientId: apt.patient,
        followUpId: turno.serumFollowUp,
        linea,
        conservarNombre: esLaDelServicio,
      });
      if (r === 'reescrito') { corregidos.push(linea.name); continue; }
      if (r === 'aplicado') {
        avisos.push(
          `«${linea.name}» ya se le aplicó al paciente, así que no se cambió: ` +
          'eso movió inventario y es lo que de verdad se le puso. Para corregirlo, ' +
          'anúlalo desde la ficha del paciente.'
        );
        continue;
      }
      // 'sin-receta': la borraron de la ficha. Se escribe de nuevo, abajo.
      turno.serumFollowUp = null;
    }

    /**
     * SE SUMA A LA BOLSA DEL SERVICIO en vez de abrir una receta nueva.
     *
     * Es lo que pide el caso real: el servicio ya escribió su «Detox Plus» y
     * mostrador le añade una ampolla al repartir la atención. Con dos recetas
     * —las dos llamadas como el servicio— la ficha decía que se le recetaron dos
     * sueros. La pantalla marca el paso y aquí se reescribe AQUELLA composición.
     * Un paso que arma su bolsa desde cero no lleva la marca y sigue su camino.
     */
    if (
      turno.serumMergeIntoService &&
      apt.autoSerumFollowUp &&
      !yaFundidoEnElServicio &&
      !fundidoEnEstaPasada
    ) {
      // eslint-disable-next-line no-await-in-loop
      const sumado = await sumarSueroAlSeguimiento({
        patientId: apt.patient,
        followUpId: apt.autoSerumFollowUp,
        linea,
      });
      if (sumado) {
        // Apunta a la MISMA receta: volver a guardar no vuelve a tocarla.
        turno.serumFollowUp = apt.autoSerumFollowUp;
        fundidoEnEstaPasada = true;
        sembrados.push(linea.name);
        continue;
      }
      // Si no se pudo (ya la aplicaron, o la receta ya no está), NO se pierde lo
      // que escogió mostrador: cae al camino normal y se escribe aparte.
    }

    // eslint-disable-next-line no-await-in-loop
    const fu = await sembrarSueroEnFicha({
      clinicId: apt.clinic,
      patientId: apt.patient,
      user: req.user,
      role: req.role,
      lineas: [linea],
      motivo: turno.serviceName
        ? `Suero indicado al asignar la atención (${turno.serviceName})`
        : 'Suero indicado al asignar la atención',
    });
    if (fu) {
      turno.serumFollowUp = fu._id;
      sembrados.push(linea.name);
    }
  }
  return { sembrados, corregidos, avisos };
}

/**
 * BORRA DE LA FICHA LOS SUEROS QUE SE QUEDARON SIN DUEÑO.
 *
 * Se quitó el suero de un paso, o el paso entero, y su receta seguía en la
 * historia del paciente: enfermería la veía como algo pendiente de poner y nadie
 * sabía de dónde salía. Se comparan los sueros que la cita tenía escritos ANTES
 * con los que le quedan.
 *
 * La bolsa del SERVICIO (`autoSerumFollowUp`) se queda: la escribió el servicio
 * y tiene su propio ciclo — quitar un paso de enfermería no deshace el suero que
 * ese servicio lleva de serie.
 */
async function limpiarSuerosHuerfanos(apt, antes) {
  const { quitarSueroDelSeguimiento } = require('../utils/sueroDeCita');
  const avisos = [];
  const vivos = new Set(
    (apt.turns || [])
      .filter((t) => t.kind === 'enfermeria' && t.serumFollowUp)
      .map((t) => String(t.serumFollowUp))
  );
  for (const id of new Set(antes || [])) {
    if (vivos.has(id)) continue;
    if (String(id) === String(apt.autoSerumFollowUp || '')) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await quitarSueroDelSeguimiento({ patientId: apt.patient, followUpId: id });
    if (r === 'aplicado') {
      avisos.push(
        'El suero que quitaste ya se le había aplicado al paciente, así que sigue ' +
        'en su ficha: eso movió inventario y es lo que de verdad se le puso.'
      );
    }
  }
  return avisos;
}

exports.createAppointment = async (req, res) => {
  try {
    const { doctor, date, startTime, endTime, patient, services } = req.body;

    // El servicio del INVENTARIO dejó de ser obligatorio: la agenda tiene su
    // propio catálogo (`serviceItem`) desde que se separó lo operativo de lo
    // contable. `services` solo llega ya desde clientes viejos o de una cita
    // antigua que se está editando.
    const incomingServiceIds = (Array.isArray(services) ? services : [])
      .map((s) => (typeof s === 'string' ? s : s?.product))
      .filter(Boolean);

    // Caja y administración agendan para cualquier sucursal de la organización,
    // aunque su usuario esté asignado operativamente a una sola. Call center
    // conserva el alcance de las sucursales que tiene asignadas.
    /**
     * QUIEN PUEDE AGENDAR, ESCOGE LA SEDE. La ruta ya decide quién agenda; una
     * vez dentro, la sucursal es un dato de la cita y no un permiso: el paciente
     * pide la que le queda cerca. Antes se exigía tenerla asignada o ver toda la
     * organización, y eso dejaba fuera a gente que sí agenda (ver
     * `validarSucursalDestino`). Lo que sigue comprobándose es que exista y esté
     * activa, frente a un id manipulado o una sede dada de baja.
     */
    const destino = await validarSucursalDestino(req, req.body.clinic);
    if (!destino.ok) return res.status(destino.status).json({ message: destino.message });
    const targetClinicId = destino.clinicId;

    // --- Validaciones de fecha y horario ---
    const localDate = parseLocalDate(date);
    if (!localDate || Number.isNaN(localDate.getTime())) {
      return res.status(400).json({ message: 'Fecha inválida' });
    }
    // Regla de negocio: no se agenda en una fecha anterior a hoy.
    if (isPastLocalDate(localDate)) {
      return res.status(400).json({ message: PAST_DATE_MESSAGE });
    }
    // Ni HOY en una hora que ya pasó (hora Ecuador).
    if (isPastLocalDateTime(localDate, startTime)) {
      return res.status(400).json({ message: PAST_TIME_MESSAGE });
    }
    const startMin = toMinutes(startTime);
    const endMin = endTime ? toMinutes(endTime) : null;
    if (startMin === null) {
      return res
        .status(400)
        .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
    }
    // Espacios de la agenda de la sucursal (Configuración → Agenda). Se valida
    // AQUÍ y no solo en la pantalla porque agendan tres sitios distintos: la
    // página de Citas, el chat del call center y la reserva pública.
    {
      const paso = await slotMinutesDeClinica(targetClinicId);
      if (!isValidSlotTime(startTime, paso)) {
        return res.status(400).json({ message: slotMessage(paso), code: 'SLOT_INVALID' });
      }
    }

    /**
     * EL MISMO PACIENTE NO SE AGENDA DOS VECES A LA MISMA HORA. Ojo: es OTRA
     * regla que la de aquí abajo —un doctor sí puede tener varias citas a la vez—.
     * Lo que se cierra aquí es guardar por segunda vez la cita que ya existe.
     * Ver `utils/citaRepetida.js`.
     */
    {
      const { buscarCitaRepetida, mensajeDeCitaRepetida } = require('../utils/citaRepetida');
      const yaExiste = await buscarCitaRepetida({
        Appointment,
        patient,
        date: localDate,
        startTime,
      });
      if (yaExiste) {
        return res.status(409).json({
          message: mensajeDeCitaRepetida(yaExiste),
          code: 'APPOINTMENT_DUPLICATE',
          appointmentId: String(yaExiste._id),
        });
      }
    }
    if (endMin !== null && endMin <= startMin) {
      return res
        .status(400)
        .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
    }

    // NOTA: Antes se rechazaba si el doctor tenía otra cita en el mismo horario.
    // Por requerimiento del negocio se permite que un mismo doctor atienda a
    // varios pacientes en la misma fecha y horario. Solo verificamos bloqueos
    // de horario (TimeBlock) creados por el administrador.
    const TimeBlock = require('../models/TimeBlock');
    const blocks = await TimeBlock.find({
      clinic: targetClinicId,
      $or: [
        { doctor: null, room: null },
        ...(doctor ? [{ doctor }] : []),
        ...(req.body.room ? [{ room: req.body.room }] : []),
      ],
      startDate: { $lte: localDate },
      endDate: { $gte: localDate },
    });
    for (const block of blocks) {
      // Determinar si el rango de la cita se solapa con el bloqueo.
      // Caso allDay o sin horario explícito → bloqueo aplica a todo el día.
      // De lo contrario: startTime < block.endTime && (endTime || startTime) >= block.startTime
      // Se usa >= en el límite inferior para incluir el caso "cita inicia justo cuando inicia el bloqueo".
      const inHours =
        block.allDay ||
        (!block.startTime || !block.endTime) ||
        (startTime < block.endTime && (endTime || startTime) >= block.startTime);
      if (inHours) {
        return res.status(400).json({
          message: `Horario bloqueado por administración${block.reason ? `: ${block.reason}` : ''}`,
        });
      }
    }

    // Validar que los servicios elegidos estén disponibles en la clínica destino.
    // Si un servicio está restringido (availableInClinics) a otra clínica, se rechaza.
    const serviceIds = (Array.isArray(services) ? services : [])
      .map((s) => (typeof s === 'string' ? s : s.product))
      .filter(Boolean);
    if (serviceIds.length > 0) {
      const restricted = await Product.find({
        _id: { $in: serviceIds },
        availableInClinics: { $exists: true, $not: { $size: 0 } },
      }).select('name availableInClinics');
      for (const p of restricted) {
        const allowed = (p.availableInClinics || []).some(
          (c) => String(c) === String(targetClinicId)
        );
        if (!allowed) {
          return res.status(400).json({
            message: `El servicio "${p.name}" no está disponible en este consultorio médico.`,
          });
        }
      }
    }

    // Validar límite de citas por horario para servicios con cupo.
    // Aplica únicamente a productos de categoría 'servicio' o 'programa'.
    // El cupo limita cuántas citas pueden coincidir en el mismo día + hora de inicio.
    // OJO: el catálogo es compartido entre sucursales (el producto "pertenece" a la
    // clínica que lo creó), así que NO se filtra por clinic — se resuelve por _id.
    if (serviceIds.length > 0) {
      const limited = await Product.find({
        _id: { $in: serviceIds },
        category: { $in: ['servicio', 'programa'] },
        maxAppointmentsPerDay: { $gt: 0 },
      }).select('name maxAppointmentsPerDay');
      for (const prod of limited) {
        const used = await Appointment.countDocuments({
          clinic: targetClinicId,
          date: localDate,
          startTime,
          'services.product': prod._id,
          status: { $ne: 'cancelada' }, // una cita cancelada libera su cupo
        });
        if (used >= prod.maxAppointmentsPerDay) {
          return res.status(400).json({
            message: `Cupo agotado para el servicio "${prod.name}" en este horario (${startTime}). Máx. ${prod.maxAppointmentsPerDay} cita(s) simultáneas.`,
          });
        }
      }
    }

    // ¿Es primera cita del paciente?
    // Solo se considera "nuevo" si tiene servicios que NO estén marcados como
    // excludeFromFirstVisit. Si todos los servicios son recurrentes, no es nuevo.
    //
    // «Sin rastro previo» ya no es «sin citas previas»: los pacientes que se
    // atendían en papel entraban como nuevos el día que se les agendaba la
    // primera cita, aunque su historia llevara años en la clínica (ver
    // utils/firstVisit.js).
    let isFirstVisit = false;
    if (await esPrimeraVisita(patient)) {
      if (serviceIds.length === 0) {
        isFirstVisit = true;
      } else {
        // Catálogo compartido entre sucursales: se resuelve por _id, sin filtrar por clinic.
        const counted = await Product.countDocuments({
          _id: { $in: serviceIds },
          excludeFromFirstVisit: { $ne: true },
        });
        isFirstVisit = counted > 0;
      }
    }

    const servicesSnapshot = await buildServicesSnapshot(targetClinicId, services);

    // Normalizar ObjectId opcionales: convertir "" a undefined para evitar CastError
    const cleanBody = { ...req.body };
    /**
     * EL VALOR NO ENTRA POR EL CUERPO A PELO.
     *
     * `cleanBody` se vuelca entero en el `create`, así que un `agreedValue` en
     * el JSON se guardaba sin pasar por la guardia de mostrador y sin dejar
     * quién lo puso. Se quita de ahí y se aplica por la misma puerta que usan
     * asignar atención, marcar asistencia y corregirlo después: un canje deja
     * el importe en 0 y cualquier rol que no sea admin/caja se queda fuera.
     *
     * Se agenda con valor desde el alta del paciente (Pacientes → «Agendar cita
     * para este paciente»), que es mostrador registrando a quien tiene delante.
     */
    for (const k of ['agreedValue', 'isCanje', 'valueSetAt', 'valueSetBy', 'advancePayment', 'paidInAdvance', 'advanceAmount', 'advanceMethod']) delete cleanBody[k];
    /**
     * Los turnos NO entran a pelo por el cuerpo. `cleanBody` se vuelca entero en
     * el `create`, así que un `turns` en el JSON se guardaría sin pasar por
     * `asignarTurnos` —el único que escribe el espejo `doctor` y `currentTurn*`—
     * y la cita nacería con la cola y sus espejos ya separados. La cola se
     * reparte más abajo, por la misma puerta que usa el mostrador.
     */
    for (const k of ['turns', 'steps', 'serum', 'currentTurnKind', 'currentTurnUser']) delete cleanBody[k];
    // Una cita recién agendada no tiene hora de llegada: eso lo sella el gesto
    // de marcar asistencia y no puede llegar por el cuerpo de la petición.
    for (const k of ['arrivedAt', 'arrivalDelayMinutes']) delete cleanBody[k];
    const valorCita = {};
    aplicarValorDeCita(valorCita, req.body, req);
    if (cleanBody.doctor === '') delete cleanBody.doctor;
    // (En el PUT, `''` significa «quítale el doctor» y se traduce a null; ver
    // `updateAppointment`. Aquí, al crear, es simplemente que no se eligió.)
    if (cleanBody.room === '') delete cleanBody.room;
    if (cleanBody.referral === '') delete cleanBody.referral;
    if (cleanBody.treatmentRef === '') delete cleanBody.treatmentRef;

    const servicioAgenda = await resolverServicioAgenda(req.body.serviceItem);

    /**
     * QUIÉN ATIENDE, ELEGIDO YA AL AGENDAR.
     *
     * Antes la cola se repartía SIEMPRE después, cuando el paciente llegaba
     * (`assignDoctor`). Pero muchas citas se agendan sabiendo de sobra quién las
     * atiende —el paciente pide con su doctora, o viene a su serie de sueros con
     * la misma enfermera— y obligar a repetir esa elección en el mostrador es un
     * paso de más que se olvida: la cita llega al día sin dueño.
     *
     * Se deja ELEGIDA, no atendida: el estado no se toca. Marcar 'asistida' aquí
     * daría por venido a un paciente de la semana que viene, y con ello se
     * falsean los reportes, las comisiones y el barrido de no-show. Eso lo sigue
     * decidiendo el mostrador cuando el paciente entra por la puerta.
     */
    const pasos = normalizarPasos(req.body.steps);
    if (pasos.length) {
      const errorPersonal = await validarPersonalDeLaSede(
        pasos.map((p) => p.user),
        targetClinicId
      );
      if (errorPersonal) return res.status(400).json({ message: errorPersonal });
    }

    /**
     * A NOMBRE DE QUIÉN QUEDA LA CITA. Normalmente de quien la escribe; el call
     * center puede acreditarla a la compañera que la cerró por teléfono
     * (`bookedBy`), y entonces se guarda además quién la digitó. Ver
     * `utils/appointmentBooker.js`.
     */
    const atribucion = await resolverAgendadoPor(req, req.body.bookedBy);
    if (!atribucion.ok) return res.status(atribucion.status).json({ message: atribucion.message });
    delete cleanBody.bookedBy;

    const appointment = await Appointment.create({
      ...cleanBody,
      ...valorCita,
      date: localDate,
      services: servicesSnapshot,
      serviceItem: servicioAgenda?._id || null,
      // Snapshot: la lista, los reportes y el recordatorio de WhatsApp leen el
      // nombre sin populate y sin romperse si mañana se renombra el servicio.
      serviceName: servicioAgenda?.name || '',
      isFirstVisit,
      clinic: targetClinicId,
      // Snapshot del nombre: si el usuario se da de baja, "agendada por" tiene
      // que seguir diciendo quién fue.
      ...atribucion.fields,
    });

    // La cola de atención, por la ÚNICA puerta que la escribe (ver
    // utils/appointmentTurns.js): así el espejo `doctor` y `currentTurn*` nacen
    // sincronizados con los turnos, como en cualquier otra cita.
    if (pasos.length) {
      asignarTurnos(appointment, { pasos, por: req.user._id });
      await appointment.save();
    }

    /**
     * EL SUERO QUEDA ESCRITO EN LA FICHA, sin que nadie lo copie a mano.
     *
     * Dos formas de llegar aquí, y la misma salida: un seguimiento con la línea
     * de receta que enfermería puede dar por aplicada, igual que si la hubiera
     * escrito un médico.
     *  · el SERVICIO trae el suyo de serie —«Detox Plus» es siempre la misma
     *    bolsa— y entonces agendar basta;
     *  · quien agenda escoge las ampollas en el paso de enfermería.
     *
     * En su propio try: la cita ya está creada y no se puede perder porque falle
     * el añadido a la ficha. Mismo criterio que la cita automática del suero
     * recetado en mostrador (ver clinicalRecordController).
     */
    let sueroSembrado = null;
    try {
      const items = [];

      // 1) El de serie del servicio. Se anota en la cita (`autoSerumFollowUp`)
      // para que asignar la atención después no lo escriba por segunda vez.
      const { sueroterapiaDeLaCita, sembrarSueroEnFicha } = require('../utils/sueroDeCita');
      const deServicio = sueroterapiaDeLaCita(servicioAgenda);
      if (deServicio.length) {
        const fu = await sembrarSueroEnFicha({
          clinicId: targetClinicId,
          patientId: patient,
          user: req.user,
          role: req.role,
          lineas: deServicio,
          motivo: `Suero indicado al agendar (${servicioAgenda.name})`,
        });
        if (fu) {
          appointment.autoSerumFollowUp = fu._id;
          // Y DE QUÉ SERVICIO: es lo que deja distinguir después «volvió a poner
          // el mismo» de «lo cambió por otro» (ver `faltaElSueroDelServicio`).
          appointment.autoSerumServiceItem = servicioAgenda._id;
          items.push(...deServicio.map((l) => l.name));
        }
      }

      // 2) Los que se escogieron en los pasos de enfermería.
      items.push(...(await sembrarSuerosDeLosTurnos(appointment, req)).sembrados);

      if (items.length) {
        await appointment.save();
        // La pantalla lo dice al guardar: si no, quien agenda no sabe que el
        // suero ya está puesto en la ficha y acaba escribiéndolo otra vez.
        sueroSembrado = { items };
        emitToClinic(targetClinicId, 'clinicalRecord:updated', { patient });
      }
    } catch (e) {
      console.warn('No se pudo escribir el suero de la cita en la ficha:', e.message);
    }

    // Si la cita proviene de una derivación, sincronizar la derivación
    if (req.body.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: req.body.referral, clinic: targetClinicId },
          { appointment: appointment._id, status: 'agendada' }
        );
      } catch (e) {
        console.warn('No se pudo sincronizar derivación al crear cita:', e.message);
      }
    }

    const populated = await appointment.populate([
      { path: 'patient', select: POPULATE_PATIENT },
      { path: 'doctor', select: POPULATE_DOCTOR },
      { path: 'createdBy', select: POPULATE_CREATOR },
      { path: 'serviceItem', select: 'name color nursingService' },
      { path: 'turns.user', select: POPULATE_DOCTOR },
      { path: 'services.product', select: 'name code salePrice category' },
    ]);

    emitToClinic(targetClinicId, 'appointment:created', populated);
    if (populated.doctor?._id) {
      emitToUser(populated.doctor._id, 'appointment:created', populated);
    }
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CREATED, appointmentEventPayload(populated));

    // `autoSerum` lo lee la pantalla para avisar de que el suero ya quedó
    // escrito. Va aparte del documento: no es un campo de la cita.
    res.status(201).json(sueroSembrado ? { ...populated.toObject(), autoSerum: sueroSembrado } : populated);
  } catch (error) {
    console.error('[createAppointment] ERROR:', error);
    res.status(500).json({ message: 'Error al crear cita', error: error.message, stack: error.stack });
  }
};

exports.updateAppointment = async (req, res) => {
  try {
    /**
     * QUIÉN EDITA UNA CITA: mostrador y administración. Quien ATIENDE, no.
     *
     * El doctor asignado podía editar «las suyas», y eso venía de cuando esta
     * ruta era también por donde se atendía. Ya no: la consulta va por `/start`
     * y `/end` y el seguimiento por la ficha clínica, así que lo único que le
     * quedaba abierto era el formulario de la cita — mover la fecha, la hora, el
     * servicio, el paciente o el precio de una visita que además suele ser suya.
     * Nada de eso es trabajo clínico, y en la práctica el lápiz aparecía en su
     * agenda invitando a tocarlo.
     */
    const existing = await Appointment.findOne({
      _id: req.params.id,
      ...filtroSucursalCita(req),
    });
    if (!existing) return res.status(404).json({ message: 'Cita no encontrada' });
    /**
     * La sucursal de trabajo es LA DE LA CITA, no la activa ni la que venga por
     * `?clinic=` (que ya no hace falta: el alcance lo pone el rol). Reagendar
     * desde el chat del CRM —que es global— o desde otra sede tiene que validar
     * los bloqueos de horario y avisar en tiempo real donde de verdad está.
     */
    const clinicScope = existing.clinic;

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    // Recepción (cajero/call_center) puede reagendar/editar cualquier cita.
    // La comisión NO cambia: queda con el creador original (createdBy se preserva).
    const isFrontDesk = ['cajero', 'call_center'].includes(req.role);
    if (!isAdmin && !isFrontDesk) {
      return res.status(403).json({
        message: 'La cita la edita mostrador o un administrador.',
        code: 'APPOINTMENT_EDIT_FRONT_DESK',
      });
    }

    const update = { ...req.body };

    /**
     * Una cita completada no se reescribe por esta puerta: mover su fecha, su
     * hora, su estado o su paciente reescribiría una atención que ya ocurrió,
     * con su seguimiento, su comisión y su turno.
     *
     * Lo que mostrador SÍ necesita corregir de una cita terminada —el servicio
     * de la visita, el importe acordado y el canje, que es justo lo que se sabe
     * al cobrar— tiene su propia puerta: `PATCH /appointments/:id/service-value`
     * (`updateServiceAndValue`), que solo toca esos campos. El administrador
     * sigue entrando por aquí para todo lo demás.
     */
    if (existing.status === 'completada' && !isAdmin) {
      return res.status(403).json({
        message: 'Una cita completada solo admite corregir el servicio y el valor.',
        code: 'COMPLETED_ONLY_SERVICE_VALUE',
      });
    }
    // No permitir alterar isFirstVisit ni createdBy en updates
    delete update.isFirstVisit;
    // Ni la hora de llegada: es un sello del sistema —lo pone el gesto de marcar
    // asistencia— y toda la gracia que tiene es que nadie pueda escribirla a
    // mano. Se calcula más abajo, cuando el estado pasa a 'asistida'.
    delete update.arrivedAt;
    delete update.arrivalDelayMinutes;
    delete update.createdBy;
    delete update.createdByRole;
    delete update.registeredBy;
    delete update.registeredByName;

    /**
     * EL VALOR ACORDADO Y EL CANJE SON DE MOSTRADOR, también al editar.
     *
     * Las otras tres puertas por las que entra el importe pasan por
     * `aplicarValorDeCita`, que comprueba el rol y sella quién lo puso; esta se
     * volcaba entera en el `findOneAndUpdate`, así que cualquiera con permiso
     * para editar la cita podía fijar el precio y encima sin dejar rastro.
     */
    const CAMPOS_DEL_VALOR = [
      'agreedValue', 'isCanje', 'advancePayment', 'paidInAdvance', 'advanceAmount', 'advanceMethod',
      'valueSetAt', 'valueSetBy',
    ];
    if (!puedeFijarValor(req)) {
      for (const k of CAMPOS_DEL_VALOR) delete update[k];
    } else {
      /**
       * Por la MISMA función que las otras tres puertas, no por una copia: aquí
       * había una versión reducida (canje → 0, vacío → null) que ya no sabía del
       * pago adelantado. Se parte del estado actual de la cita porque las reglas
       * se cruzan —un canje borra el adelanto, «pagó todo» sigue al valor— y
       * decidirlas solo con lo que llega en el cuerpo daría resultados distintos
       * según qué campo se haya tocado en la pantalla.
       */
      const valor = {
        agreedValue: existing.agreedValue,
        isCanje: existing.isCanje,
        advancePayment: existing.advancePayment,
        advanceMethod: existing.advanceMethod,
        paidInAdvance: existing.paidInAdvance,
        advanceAmount: existing.advanceAmount,
      };
      const cambio = aplicarValorDeCita(valor, update, req);
      for (const k of CAMPOS_DEL_VALOR) delete update[k];
      if (cambio) Object.assign(update, valor);
    }

    /**
     * QUITARLE EL DOCTOR A UNA CITA: el selector manda `''` al limpiarlo, y eso
     * reventaba con un «Cast to ObjectId failed» —error 500, sin explicación—
     * porque Mongoose no sabe convertir la cadena vacía. Vacío aquí significa
     * «sin doctor», que es null.
     */
    if (update.doctor === '') update.doctor = null;

    // Reasignación de doctor: libre hasta que la consulta se atiende. Se compara
    // contra el doctor actual para no bloquear una edición que reenvía el mismo.
    const previousDoctorId = existing.doctor ? String(existing.doctor) : '';
    const doctorChanged =
      update.doctor !== undefined && String(update.doctor || '') !== previousDoctorId;
    if (doctorChanged && previousDoctorId && consultationDone(existing)) {
      return res.status(400).json({ message: DOCTOR_LOCKED_MESSAGE });
    }
    if (doctorChanged) {
      // Misma auditoría que assign-doctor: quién reasignó y cuándo.
      update.doctorAssignedAt = new Date();
      update.doctorAssignedBy = req.user._id;
    }

    if (update.date !== undefined) {
      const localDate = parseLocalDate(update.date);
      if (!localDate || Number.isNaN(localDate.getTime())) {
        return res.status(400).json({ message: 'Fecha inválida' });
      }
      // Bloquear REAGENDAR a una fecha anterior a hoy. Se permite editar (sin
      // mover el día) una cita que ya está en el pasado, para no romper el
      // registro de asistencia/no-show; solo se rechaza si el día CAMBIA a uno
      // anterior a hoy.
      if (!isSameLocalDay(localDate, existing.date) && isPastLocalDate(localDate)) {
        return res.status(400).json({ message: PAST_DATE_MESSAGE });
      }
      update.date = localDate;
    }

    if (update.startTime !== undefined || update.endTime !== undefined) {
      const startMin = toMinutes(update.startTime);
      const endMin = update.endTime ? toMinutes(update.endTime) : null;
      if (update.startTime !== undefined && startMin === null) {
        return res
          .status(400)
          .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
      }
      if (endMin !== null && startMin !== null && endMin <= startMin) {
        return res
          .status(400)
          .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
      }
    }

    // Bloquear REAGENDAR a un horario que ya pasó (hoy a una hora anterior a la
    // actual, hora Ecuador). Solo aplica si el día o la hora CAMBIAN: editar
    // otros campos de una cita cuyo horario ya pasó sigue permitido (asistencia,
    // servicios, notas).
    {
      const scheduleChanged =
        (update.date !== undefined && !isSameLocalDay(update.date, existing.date)) ||
        (typeof update.startTime === 'string' && update.startTime !== existing.startTime);
      const finalDate2 = update.date !== undefined ? update.date : existing.date;
      const finalStart2 = update.startTime !== undefined ? update.startTime : existing.startTime;
      if (scheduleChanged && isPastLocalDateTime(finalDate2, finalStart2)) {
        return res.status(400).json({ message: PAST_TIME_MESSAGE });
      }
      // Solo si se MUEVE la cita: las agendadas antes de encender los espacios
      // conservan su hora suelta y se pueden seguir editando (asistencia,
      // servicios, notas) sin que el sistema las dé por inválidas.
      if (scheduleChanged) {
        const paso = await slotMinutesDeClinica(clinicScope);
        if (!isValidSlotTime(finalStart2, paso)) {
          return res.status(400).json({ message: slotMessage(paso), code: 'SLOT_INVALID' });
        }
      }
    }

    if (Array.isArray(update.services)) {
      update.services = await buildServicesSnapshot(clinicScope, update.services);
    }

    // Servicio de agenda (catálogo propio). Solo se toca si viene en la
    // petición: editar otra cosa de una cita no puede borrarle el servicio.
    /**
     * Si el servicio CAMBIA a uno que trae suero de serie, el suero se escribe
     * también aquí: mostrador agenda a menudo sin servicio («viene mañana, ya
     * veremos a qué») y lo corrige después, y sin esto ese Detox Plus se quedaba
     * sin su suero solo por haberse elegido un minuto más tarde.
     *
     * Solo cuando CAMBIA, no en cada guardado: reeditar la hora de una cita de
     * Detox Plus no puede añadirle una segunda bolsa a la ficha.
     */
    let servicioNuevoConSuero = null;
    if (update.serviceItem !== undefined) {
      const svc = await resolverServicioAgenda(update.serviceItem);
      // La pregunta la contesta `faltaElSueroDelServicio`, la MISMA que usan las
      // otras dos puertas. Antes se comparaba contra `existing.serviceItem`, y
      // por eso quitar el servicio y volver a ponerlo se leía como un cambio:
      // escribía una segunda bolsa idéntica.
      const { faltaElSueroDelServicio } = require('../utils/sueroDeCita');
      if (faltaElSueroDelServicio(existing, svc)) servicioNuevoConSuero = svc;
      update.serviceItem = svc?._id || null;
      update.serviceName = svc?.name || '';
    }

    // Verificar bloqueos de horario si la fecha u hora cambió (no admin).
    const finalDate = update.date instanceof Date ? update.date : existing.date;
    const finalStart = update.startTime !== undefined ? update.startTime : existing.startTime;
    const finalEnd = update.endTime !== undefined ? update.endTime : existing.endTime;
    const finalDoctor = update.doctor !== undefined ? update.doctor : existing.doctor;
    const finalRoom = update.room !== undefined ? update.room : existing.room;

    /**
     * REAGENDAR TAMPOCO PUEDE PISAR OTRA CITA DEL MISMO PACIENTE. Mover la de
     * las 12:00 a las 11:30 cuando ya tiene una a las 11:30 deja dos citas
     * encima, que es el mismo enredo que crearla repetida. Solo se mira si la
     * fecha o la hora CAMBIAN: guardar cualquier otra cosa de la cita no puede
     * chocar consigo misma (y por eso, además, se excluye su propio id).
     */
    {
      const cambiaElHueco =
        (update.date instanceof Date &&
          new Date(update.date).toDateString() !== new Date(existing.date).toDateString()) ||
        (update.startTime !== undefined && update.startTime !== existing.startTime);
      if (cambiaElHueco && finalDate && finalStart) {
        const { buscarCitaRepetida, mensajeDeCitaRepetida } = require('../utils/citaRepetida');
        const yaExiste = await buscarCitaRepetida({
          Appointment,
          patient: existing.patient?._id || existing.patient,
          date: finalDate,
          startTime: finalStart,
          excludeId: existing._id,
        });
        if (yaExiste) {
          return res.status(409).json({
            message: mensajeDeCitaRepetida(yaExiste),
            code: 'APPOINTMENT_DUPLICATE',
            appointmentId: String(yaExiste._id),
          });
        }
      }
    }

    if (!isAdmin && finalDate && finalStart) {
      const TimeBlock = require('../models/TimeBlock');
      const blocks = await TimeBlock.find({
        clinic: clinicScope,
        $or: [
          { doctor: null, room: null },
          ...(finalDoctor ? [{ doctor: finalDoctor }] : []),
          ...(finalRoom ? [{ room: finalRoom }] : []),
        ],
        startDate: { $lte: finalDate },
        endDate: { $gte: finalDate },
      });
      for (const block of blocks) {
        const inHours =
          block.allDay ||
          (!block.startTime || !block.endTime) ||
          (finalStart < block.endTime && (finalEnd || finalStart) >= block.startTime);
        if (inHours) {
          return res.status(400).json({
            message: `Horario bloqueado por administración${block.reason ? `: ${block.reason}` : ''}`,
          });
        }
      }
    }

    // Detectar reagendamiento: si cambia la fecha o el horario respecto al
    // documento existente, registrar entrada en rescheduleHistory.
    const newDate = update.date instanceof Date ? update.date : null;
    const oldDateIso = existing.date instanceof Date ? existing.date.toISOString().slice(0, 10) : null;
    const newDateIso = newDate ? newDate.toISOString().slice(0, 10) : null;
    const dateChanged = newDateIso && oldDateIso && newDateIso !== oldDateIso;
    const startChanged =
      typeof update.startTime === 'string' && update.startTime !== existing.startTime;
    const endChanged =
      typeof update.endTime === 'string' && update.endTime !== existing.endTime;

    if (dateChanged || startChanged || endChanged) {
      const entry = {
        previousDate: existing.date,
        previousStartTime: existing.startTime,
        previousEndTime: existing.endTime,
        newDate: newDate || existing.date,
        newStartTime: update.startTime || existing.startTime,
        newEndTime: update.endTime || existing.endTime,
        rescheduledBy: req.user._id,
        rescheduledByName: req.user.name,
        rescheduledByRole: req.role || null,
        // SOLO `rescheduleReason`. Antes caía a `reason`, que es el motivo
        // CLÍNICO de la cita: cualquier edición que moviera la hora guardaba
        // "dolor de rodilla" como si fuera el motivo del reagendamiento.
        reason: req.body.rescheduleReason || '',
        at: new Date(),
      };
      update.$push = { ...(update.$push || {}), rescheduleHistory: entry };
      // Si estaba completada/cancelada/no_asistio y se reagenda, volvemos a pendiente
      // (a menos que el cliente envíe un status explícito).
      if (!update.status && ['cancelada', 'no_asistio'].includes(existing.status)) {
        update.status = 'pendiente';
      }
    }

    /**
     * MARCAR «asistida» A MANO TAMBIÉN SELLA LA LLEGADA.
     *
     * Es la cuarta puerta por la que una cita llega a ese estado (las otras tres
     * son «Asistió», asignar la atención y el reclamo de enfermería), y sin esto
     * la cita recibida desde el formulario de edición se quedaba sin hora de
     * llegada: en la agenda no habría manera de saber si el paciente llegó
     * puntual. Se calcula sobre `existing`, que es la cita ANTES del guardado, y
     * solo si todavía no la tenía. Ver utils/appointmentArrival.js.
     */
    if (update.status === 'asistida' && !existing.arrivedAt) {
      const sello = { date: existing.date, startTime: update.startTime || existing.startTime };
      registrarLlegada(sello);
      update.arrivedAt = sello.arrivedAt;
      update.arrivalDelayMinutes = sello.arrivalDelayMinutes;
    }

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: clinicScope },
      update,
      { new: true, runValidators: true }
    )
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    /**
     * CAMBIAR EL DOCTOR DESDE EL FORMULARIO MUEVE SU TURNO.
     *
     * El campo «Doctor asignado» escribía solo el espejo, y la cola se quedaba
     * como estaba: quitarle el doctor a una cita no la quitaba de su agenda —que
     * va por `currentTurnUser`— y al primer guardado suyo el espejo volvía a
     * decir su nombre. Se veía como «le quité el doctor y sigue apareciendo que
     * la atendió él».
     *
     * Va por la única puerta que escribe la cola y sus espejos (ver
     * utils/appointmentTurns.js). Los turnos ya completados no se tocan.
     */
    if (doctorChanged) {
      fijarDoctorDeLaCita(appointment, update.doctor || null, { por: req.user._id });
      await appointment.save();
      await appointment.populate([
        { path: 'doctor', select: POPULATE_DOCTOR },
        { path: 'turns.user', select: POPULATE_DOCTOR },
      ]);
    }

    /**
     * El servicio pasó a ser uno con suero de serie: se escribe en la ficha,
     * igual que al agendarlo directo (ver el comentario de arriba y
     * `utils/sueroDeCita.js`). En su propio try: la cita ya está guardada.
     *
     * Y SE DEJA LA MARCA `autoSerumFollowUp`. Esta es la segunda de las tres
     * puertas por las que pasa una cita —agendarla, corregirle el servicio,
     * asignar la atención— y era la única que escribía el suero SIN anotar que
     * ya estaba escrito. El resultado, con el caso real de todos los días:
     * mostrador agenda «ya veremos a qué», le pone el servicio después (aquí se
     * escribe la receta, sin marca) y luego abre «Asignar atención» para poner a
     * los enfermeros; esa tercera puerta pregunta por la marca, no la encuentra,
     * y escribe el MISMO suero por segunda vez. En la ficha del paciente aparecen
     * dos bolsas y parece que se le recetaron dos.
     */
    let sueroSembrado = null;
    if (servicioNuevoConSuero) {
      try {
        const { sueroterapiaDeLaCita, sembrarSueroEnFicha } = require('../utils/sueroDeCita');
        const lineas = sueroterapiaDeLaCita(servicioNuevoConSuero);
        const fu = await sembrarSueroEnFicha({
          clinicId: clinicScope,
          patientId: appointment.patient?._id || appointment.patient,
          user: req.user,
          role: req.role,
          lineas,
          motivo: `Suero indicado al agendar (${servicioNuevoConSuero.name})`,
        });
        if (fu) {
          appointment.autoSerumFollowUp = fu._id;
          appointment.autoSerumServiceItem = servicioNuevoConSuero._id;
          await appointment.save();
          sueroSembrado = { followUpId: fu._id, items: lineas.map((l) => l.name) };
          emitToClinic(clinicScope, 'clinicalRecord:updated', {
            patient: appointment.patient?._id || appointment.patient,
          });
        }
      } catch (e) {
        console.warn('No se pudo escribir el suero del servicio en la ficha:', e.message);
      }
    }

    emitToClinic(clinicScope, 'appointment:updated', appointment);
    if (appointment.doctor?._id) emitToUser(appointment.doctor._id, 'appointment:updated', appointment);
    // Reasignación: el doctor entrante recibe la cita como asignada y el saliente
    // se entera de que ya no es suya (antes ninguno de los dos se enteraba).
    if (doctorChanged) {
      if (appointment.doctor?._id) emitToUser(appointment.doctor._id, 'appointment:assigned', appointment);
      if (previousDoctorId) emitToUser(previousDoctorId, 'appointment:updated', appointment);
    }
    // Eventos de dominio para workflows: reagendamiento y confirmación.
    if (dateChanged || startChanged || endChanged) {
      emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_RESCHEDULED, appointmentEventPayload(appointment));
    }
    // Cambios MANUALES de estado desde el formulario de edición: antes solo se
    // emitía "confirmada"; cancelar/no-show/asistió desde aquí no disparaba nada.
    if (update.status && update.status !== existing.status) {
      if (update.status === 'confirmada') {
        emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CONFIRMED, appointmentEventPayload(appointment));
      } else if (update.status === 'cancelada') {
        emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CANCELLED, appointmentEventPayload(appointment));
      } else if (update.status === 'no_asistio') {
        emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_NO_SHOW, appointmentEventPayload(appointment));
      } else if (update.status === 'asistida' || update.status === 'completada') {
        emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(appointment));
      }
    }
    res.json(sueroSembrado ? { ...appointment.toObject(), autoSerum: sueroSembrado } : appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cita', error: error.message });
  }
};

exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      ...filtroSucursalCita(req),
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isCreator = String(appointment.createdBy || '') === String(req.user._id);
    if (!isAdmin && !isCreator) {
      return res.status(403).json({
        message:
          'Solo los administradores o el creador de la cita pueden eliminarla.',
      });
    }

    /**
     * UNA CITA COMPLETADA NO SE CANCELA (salvo administrador).
     *
     * Detrás hay una atención que ocurrió: su seguimiento escrito, su comisión
     * devengada y su turno cerrado. Marcarla 'cancelada' la borraría de los
     * reportes dejando la historia clínica donde está, y nadie volvería a
     * cuadrarlo. Antes no hacía falta decirlo porque la pantalla escondía el
     * botón; desde que mostrador puede corregirle el servicio y el valor, el
     * botón está a la vista y la regla tiene que vivir aquí.
     */
    if (appointment.status === 'completada' && !isAdmin) {
      return res.status(403).json({
        message: 'Una cita completada no se puede cancelar. Contacta a un administrador.',
      });
    }

    // Cancelar = marcar como 'cancelada' (preserva historial para reportes de marketing).
    // Solo el admin puede borrarla físicamente (con ?hard=true).
    if (req.query.hard === 'true' && (req.user.isSuperAdmin || req.role === 'admin')) {
      await Appointment.deleteOne({ _id: appointment._id });
      return res.json({ message: 'Cita eliminada' });
    }
    appointment.status = 'cancelada';
    await appointment.save();
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CANCELLED, appointmentEventPayload(appointment));
    res.json({ message: 'Cita cancelada', appointment });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar cita' });
  }
};

/**
 * Inicia el cronómetro de la cita (uso del doctor).
 */
exports.startConsultation = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      ...filtroSucursalCita(req),
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isAssignedDoctor =
      (isDoctorRole(req.role)) && String(appointment.doctor) === String(req.user._id);
    if (!isAdmin && !isAssignedDoctor) {
      return res.status(403).json({
        message: 'Solo el doctor asignado puede iniciar la consulta.',
      });
    }

    const ahora = new Date();
    appointment.consultationStartedAt = ahora;
    appointment.consultationEndedAt = undefined;
    // Y el reloj DE ESTE TURNO. `consultationStartedAt` es de la cita entera: si
    // el segundo doctor se guiara por él, heredaría el cronómetro del primero y
    // entraría a la consulta con media hora ya corrida.
    const turno = turnoVigente(appointment);
    if (turno) turno.startedAt = ahora;
    await appointment.save();
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al iniciar consulta', error: error.message });
  }
};

/**
 * Finaliza la consulta y la marca como completada.
 */
exports.endConsultation = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      ...filtroSucursalCita(req),
    });
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    const isAssignedDoctor =
      (isDoctorRole(req.role)) && String(appointment.doctor) === String(req.user._id);
    if (!isAdmin && !isAssignedDoctor) {
      return res.status(403).json({
        message: 'Solo el doctor asignado puede finalizar la consulta.',
      });
    }

    /**
     * FINALIZAR TAMBIÉN CIERRA EL TURNO.
     *
     * Antes solo ponía `status = 'completada'` y dejaba el turno del doctor en
     * «pendiente». La cita quedaba en un estado que no existe —cerrada y con la
     * pelota todavía en manos de alguien— y el efecto lo sufría justo quien la
     * atendió: para la pantalla la cita seguía siendo SUYA (`currentTurnUser`),
     * así que no le ofrecía «Ver / corregir», y por estar completada tampoco le
     * ofrecía «Atender». Se quedaba sin ninguna forma de volver a entrar a lo
     * que acababa de escribir.
     *
     * Guardar el seguimiento ya lo hacía bien (ver `addFollowUp`); esta puerta
     * era la que se lo saltaba. Y por eso mismo el estado ya no se fuerza: si
     * detrás queda otro profesional, la cita CAMBIA DE MANOS en vez de cerrarse.
     */
    const { completarTurno } = require('../utils/appointmentTurns');
    const { siguiente, terminado } = completarTurno(appointment, { userId: req.user._id });
    if (terminado || !appointment.turns?.length) {
      appointment.consultationEndedAt = new Date();
      appointment.status = 'completada';
    }
    await appointment.save();
    emitToClinic(appointment.clinic, 'appointment:updated', appointment);
    // Al siguiente le llega la cita ahora, igual que al guardar un seguimiento.
    if (siguiente?.user) emitToUser(siguiente.user, 'appointment:assigned', appointment);
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(appointment));

    // Sincronizar derivación asociada
    if (appointment.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: appointment.referral, clinic: appointment.clinic },
          { status: 'atendida' }
        );
      } catch (e) {
        console.warn('No se pudo sincronizar derivación al completar cita:', e.message);
      }
    }

    // Avance automático de tratamientos: si la cita tenía servicios y existe
    // un tratamiento activo del paciente que los incluya, sumar avance.
    try {
      const Treatment = require('../models/Treatment');
      const services = (appointment.services || []).map((s) => String(s.product));
      if (services.length && appointment.patient) {
        const treatments = await Treatment.find({
          clinic: appointment.clinic,
          patient: appointment.patient,
          status: 'activo',
        });
        for (const t of treatments) {
          let changed = false;
          for (const svcId of services) {
            const idx = t.items.findIndex(
              (it) => String(it.product) === svcId && (it.completed || 0) < it.quantity
            );
            if (idx >= 0) {
              t.items[idx].completed += 1;
              t.items[idx].completionRefs.push({
                type: 'appointment',
                ref: appointment._id,
                date: new Date(),
              });
              changed = true;
            }
          }
          if (changed) {
            t.lastActivityAt = new Date();
            if (t.status === 'abandonado') {
              t.status = 'activo';
              t.abandonedAt = undefined;
            }
            if (t.progress >= 100) t.status = 'completado';
            await t.save();
          }
        }
      }
    } catch (e) {
      console.warn('No se pudo actualizar tratamientos por cita', e.message);
    }

    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al finalizar consulta', error: error.message });
  }
};

exports.getTodayAppointments = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      clinic: req.clinicId,
      date: { $gte: today, $lt: tomorrow },
    };

    if (isDoctorRole(req.role)) {
      Object.assign(query, filtroCitasDelDoctor(req.user._id));
    }
    // El call center puede ver TODAS las citas del día.
    if (req.role === 'enfermero') {
      Object.assign(query, await filtroEnfermeria(req));
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category nursingService')
      .sort({ startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas del día' });
  }
};

/**
 * Genera un PDF imprimible de la cita.
 * Usa puppeteer (ya disponible en el proyecto para RIDE de facturas).
 */
exports.getAppointmentPdf = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR);

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const Clinic = require('../models/Clinic');
    // La sucursal QUE IMPRIME es la de la cita: el PDF lleva su nombre y su
    // dirección, y con la activa una cita de otra sede saldría con el membrete
    // equivocado.
    const clinic = await Clinic.findById(appointment.clinic);

    const isoDate = appointment.date instanceof Date
      ? appointment.date.toISOString()
      : String(appointment.date || '');
    const dateMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const fmtDate = dateMatch
      ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`
      : new Date(appointment.date).toLocaleDateString('es-EC');
    const created = new Date(appointment.createdAt).toLocaleString('es-EC');
    const services = (appointment.services || [])
      .map(
        (s) =>
          `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0">${s.name || '—'}</td>` +
          `<td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">$${Number(
            s.price || 0
          ).toFixed(2)}</td></tr>`
      )
      .join('');

    const statusLabels = {
      pendiente: 'Pendiente',
      completada: 'Completada',
      // Compatibilidad con datos legacy
      programada: 'Pendiente',
      confirmada: 'Pendiente',
      en_curso: 'Pendiente',
      cancelada: 'Cancelada',
      no_asistio: 'No asistió',
    };

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Cita ${appointment._id}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 30px; }
  h1 { color: #047857; margin: 0 0 4px 0; }
  .header { border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .box { background: #f0fdf4; border-radius: 8px; padding: 10px 12px; }
  .label { font-size: 11px; color: #047857; text-transform: uppercase; font-weight: 600; }
  .val { font-size: 13px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { background: #ecfdf5; text-align: left; padding: 6px 8px; border: 1px solid #e2e8f0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #fef3c7; color: #92400e; }
  .footer { margin-top: 28px; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${clinic?.nombreComercial || clinic?.name || 'Clínica'}</h1>
    <div style="font-size:12px;color:#64748b">Comprobante de Cita Médica</div>
  </div>

  <div class="grid">
    <div class="box"><div class="label">Paciente</div><div class="val">${appointment.patient?.firstName || ''} ${appointment.patient?.lastName || ''}${
      appointment.isFirstVisit ? ' <span class="badge">PACIENTE NUEVO</span>' : ''
    }</div></div>
    <div class="box"><div class="label">Cédula</div><div class="val">${appointment.patient?.cedula || '—'}</div></div>
    <div class="box"><div class="label">Doctor</div><div class="val">Dr. ${appointment.doctor?.name || '—'} ${appointment.doctor?.specialty ? '— ' + appointment.doctor.specialty : ''}</div></div>
    <div class="box"><div class="label">Estado</div><div class="val">${statusLabels[appointment.status] || appointment.status}</div></div>
    <div class="box"><div class="label">Fecha</div><div class="val">${fmtDate}</div></div>
    <div class="box"><div class="label">Horario</div><div class="val">${appointment.startTime} — ${appointment.endTime}</div></div>
    <div class="box"><div class="label">Teléfono</div><div class="val">${appointment.patient?.phone || '—'}</div></div>
    <div class="box"><div class="label">Email</div><div class="val">${appointment.patient?.email || '—'}</div></div>
  </div>

  ${appointment.reason ? `<div class="box" style="margin-bottom:12px"><div class="label">Motivo</div><div class="val">${appointment.reason}</div></div>` : ''}

  ${services ? `<div class="label" style="margin-top:14px">Servicios</div><table><thead><tr><th>Servicio</th><th style="text-align:right">Precio</th></tr></thead><tbody>${services}</tbody></table>` : ''}

  ${appointment.diagnosis ? `<div class="box" style="margin-top:12px"><div class="label">Diagnóstico</div><div class="val">${appointment.diagnosis}</div></div>` : ''}
  ${appointment.treatment ? `<div class="box" style="margin-top:8px"><div class="label">Tratamiento</div><div class="val">${appointment.treatment}</div></div>` : ''}
  ${appointment.notes ? `<div class="box" style="margin-top:8px"><div class="label">Notas</div><div class="val">${appointment.notes}</div></div>` : ''}

  <div class="footer">
    Registrado por: ${appointment.createdBy?.name || '—'}${appointment.createdByRole ? ' (' + appointment.createdByRole + ')' : ''} &nbsp;|&nbsp; Creada: ${created}
  </div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="cita_${appointment._id}.pdf"`
    );
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generando PDF de cita:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};

/**
 * Estadísticas agregadas: total citas y porcentaje de asistencia.
 * Retorna { total, byStatus, attendanceRate } o por paciente si llega ?patient.
 */
exports.getStats = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinic: clinicObjId };
    const { startDate, endDate, patient, doctor, service } = req.query;
    if (startDate && endDate) {
      // Días enteros por las dos puntas, igual que en el listado: si no, las
      // atenciones registradas por la mañana no entran en las estadísticas.
      match.date = { $gte: parseLocalDate(startDate), $lte: parseLocalDate(endDate) };
      if (match.date.$gte) match.date.$gte.setHours(0, 0, 0, 0);
      if (match.date.$lte) match.date.$lte.setHours(23, 59, 59, 999);
    }
    if (patient) match.patient = new mongoose.Types.ObjectId(patient);
    if (doctor) match.doctor = new mongoose.Types.ObjectId(doctor);
    if (service) match['services.product'] = new mongoose.Types.ObjectId(service);

    const grouped = await Appointment.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = grouped.reduce((acc, g) => {
      acc[g._id || 'pendiente'] = g.count;
      return acc;
    }, {});
    const total = grouped.reduce((s, g) => s + g.count, 0);

    // Asistencia: asistida + completada / (asistida + completada + no_asistio + cancelada)
    const attended = (byStatus.asistida || 0) + (byStatus.completada || 0);
    const missed = (byStatus.no_asistio || 0) + (byStatus.cancelada || 0);
    const denom = attended + missed;
    const attendanceRate = denom === 0 ? null : Math.round((attended / denom) * 100);

    // Desglose por rol que creó la cita (agendado vs. call_center)
    const byCreator = await Appointment.aggregate([
      { $match: match },
      { $group: { _id: '$createdByRole', count: { $sum: 1 } } },
    ]);
    const createdByRole = byCreator.reduce((acc, g) => {
      acc[g._id || 'desconocido'] = g.count;
      return acc;
    }, {});

    // Desglose por doctor que atendió (status asistida o completada)
    const byDoctor = await Appointment.aggregate([
      { $match: { ...match, status: { $in: ['asistida', 'completada'] } } },
      { $group: { _id: '$doctor', count: { $sum: 1 } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'doctor',
        },
      },
      { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          count: 1,
          name: '$doctor.name',
          specialty: '$doctor.specialty',
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      total,
      byStatus,
      attended,
      missed,
      attendanceRate,
      createdByRole,
      byDoctor,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estadísticas', error: error.message });
  }
};

/**
 * Marca asistencia (uso del enfermero/recepción): pendiente/confirmada → asistida.
 * Puede recibir `doctorId` en el body para asignar al doctor al mismo tiempo,
 * que es el flujo nuevo (la cita se crea sin doctor y al llegar el paciente,
 * recepción lo asigna según disponibilidad).
 */
exports.markAttended = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    const wasAttended = apt.status === 'asistida';
    if (req.body.doctorId) {
      // Misma regla que assign-doctor: no se cambia el doctor de una consulta
      // ya atendida (aquí se llega al re-marcar asistencia).
      const previousDoctorId = apt.doctor ? String(apt.doctor) : '';
      if (previousDoctorId && previousDoctorId !== String(req.body.doctorId) && consultationDone(apt)) {
        return res.status(400).json({ message: DOCTOR_LOCKED_MESSAGE });
      }
      apt.doctor = req.body.doctorId;
      apt.doctorAssignedAt = new Date();
      apt.doctorAssignedBy = req.user._id;
    }
    // Valor acordado / canje, si recepción los anotó al recibir al paciente.
    aplicarValorDeCita(apt, req.body, req);
    apt.status = 'asistida';
    // Y a qué hora llegó de verdad, para poder distinguir después al que entró a
    // su hora del que entró cuarenta minutos tarde. Solo la primera vez: ver
    // utils/appointmentArrival.js.
    registrarLlegada(apt);
    await apt.save();
    if (apt.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: apt.referral, clinic: apt.clinic },
          { status: 'atendida' }
        );
      } catch (_) {}
    }
    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category');
    emitToClinic(apt.clinic, 'appointment:updated', populated);
    if (populated.doctor?._id) emitToUser(populated.doctor._id, 'appointment:updated', populated);
    // Solo la PRIMERA vez: re-marcar (doble clic, reasignar doctor) no debe
    // re-disparar la automatización de "cita asistida".
    if (!wasAttended) emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(populated));
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al marcar asistencia' });
  }
};

/**
 * CORREGIR EL SERVICIO Y EL VALOR de una cita — también después de atenderla.
 *
 * Es una puerta propia, y no un `PUT /:id`, por lo que NO deja hacer: ahí viven
 * las reglas de reagendamiento, el bloqueo de las citas completadas y la
 * reasignación de doctor, y relajarlas para que caja pudiera corregir un importe
 * habría abierto de paso todo lo demás. Aquí solo se tocan cuatro cosas: el
 * servicio de la cita, los OTROS servicios que se hicieron en la visita
 * (`additionalServices`), el valor acordado y el canje.
 *
 * Se puede usar en CUALQUIER estado, incluida una cita ya completada: el
 * servicio real y el precio se saben muchas veces al final —el paciente entró
 * por una consulta y salió con un procedimiento—, y hasta ahora eso obligaba a
 * pedírselo a un administrador.
 *
 * Lo que NO se toca nunca, y por eso ni se lee del cuerpo: QUIÉN atendió. Los
 * turnos, el doctor y el enfermero quedan como están; una cita no cambia de
 * manos después de que alguien ya escribió su seguimiento.
 *
 * `turns[].serviceName` tampoco se reescribe: eso es lo que hizo CADA
 * profesional en su turno, no lo que se le factura al paciente.
 */
exports.updateServiceAndValue = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });

    let cambio = false;

    if (req.body.serviceItem !== undefined) {
      const id = req.body.serviceItem || null;
      if (id) {
        const servicio = await resolverServicioAgenda(id);
        if (!servicio) {
          return res.status(400).json({ message: 'El servicio elegido ya no existe' });
        }
        apt.serviceItem = servicio._id;
        // `serviceName` es el snapshot que leen la lista, los reportes y el
        // recordatorio de WhatsApp sin populate: si se cambia uno hay que
        // cambiar el otro, o la cita diría dos servicios distintos a la vez.
        apt.serviceName = servicio.name || '';
      } else {
        apt.serviceItem = null;
        apt.serviceName = '';
      }
      cambio = true;
    }

    /**
     * OTROS SERVICIOS de la visita. Llega la lista COMPLETA (ids del catálogo de
     * agenda), no un "añade este": así quitar uno es mandar la lista sin él y no
     * hace falta un segundo endpoint para borrar.
     *
     * Va DESPUÉS del principal a propósito: si en la misma llamada se cambia el
     * servicio de la cita, los adicionales tienen que compararse con el nuevo.
     */
    if (req.body.additionalServices !== undefined) {
      const lista = Array.isArray(req.body.additionalServices) ? req.body.additionalServices : [];
      // Lo que ya estaba, para no falsear la fecha en que se añadió.
      const previos = new Map(
        (apt.additionalServices || []).map((s) => [String(s.serviceItem), s])
      );
      const vistos = new Set();
      const extras = [];
      /**
       * El que ya es el principal NO se repite abajo, y se descarta en silencio
       * en vez de dar error: pasa al ascender un adicional a servicio de la cita
       * («entró por consulta, en realidad fue la ecografía»), y ahí quedarse con
       * una sola línea es exactamente lo que se quiso hacer.
       */
      const esElPrincipal = (clave) => apt.serviceItem && clave === String(apt.serviceItem);

      for (const bruto of lista) {
        const id = bruto?.serviceItem || bruto?._id || bruto;
        if (!id) continue;

        const yaEstaba = previos.get(String(id));
        if (yaEstaba) {
          /**
           * Se conserva TAL CUAL y no se vuelve a buscar en el catálogo, por dos
           * razones: `resolverServicioAgenda` sube el contador de uso —y volver a
           * abrir y guardar el modal no puede hacer que un servicio parezca más
           * usado de lo que es, porque ese contador ordena las sugerencias—, y el
           * nombre guardado es el del día en que se hizo, que es el que vale.
           */
          if (esElPrincipal(String(id)) || vistos.has(String(id))) continue;
          vistos.add(String(id));
          extras.push({
            serviceItem: yaEstaba.serviceItem,
            name: yaEstaba.name,
            addedAt: yaEstaba.addedAt,
            addedBy: yaEstaba.addedBy,
          });
          continue;
        }

        const servicio = await resolverServicioAgenda(id);
        if (!servicio) {
          return res.status(400).json({ message: 'Uno de los servicios adicionales ya no existe' });
        }
        const clave = String(servicio._id);
        if (esElPrincipal(clave) || vistos.has(clave)) continue;
        vistos.add(clave);
        extras.push({
          serviceItem: servicio._id,
          name: servicio.name || '',
          addedAt: new Date(),
          addedBy: req.user._id,
        });
      }
      apt.additionalServices = extras;
      cambio = true;
    }

    if (aplicarValorDeCita(apt, req.body, req)) cambio = true;

    if (!cambio) return res.status(400).json({ message: 'No hay nada que cambiar' });

    await apt.save();

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('services.product', 'name code salePrice category');

    emitToClinic(apt.clinic, 'appointment:updated', populated);
    if (populated.doctor?._id) emitToUser(populated.doctor._id, 'appointment:updated', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el servicio y el valor de la cita' });
  }
};

/**
 * ATENCIÓN INMEDIATA (walk-in). Crea la cita YA ASIGNADA a quien la pide y la
 * deja lista para atender, en un solo paso.
 *
 * Nace para óptica: ahí el paciente entra sin cita, y quien lo registra es el
 * propio optómetra. Obligarle a crear el paciente, salir a la agenda, agendar
 * una cita a la hora que ya es y volver a asignársela sería papeleo puro.
 *
 * La cita queda con la hora ACTUAL de Ecuador (no una redonda: es la hora a la
 * que de verdad entró), agendada por él y asignada a él.
 */
exports.createWalkIn = async (req, res) => {
  try {
    const { patient, serviceItem, reason } = req.body;
    if (!patient) return res.status(400).json({ message: 'Falta el paciente' });

    const servicioAgenda = await resolverServicioAgenda(serviceItem);

    const apt = await crearCitaAtencionInmediata({
      Appointment,
      clinicId: req.clinicId,
      patientId: patient,
      user: req.user,
      role: req.role,
      serviceItem: servicioAgenda?._id || null,
      serviceName: servicioAgenda?.name || '',
      reason: reason || 'Atención inmediata',
      // ABIERTA: el profesional la pide justo antes de atender.
      estado: 'abierta',
    });

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('turns.user', POPULATE_DOCTOR);

    emitToClinic(req.clinicId, 'appointment:created', populated);
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(populated));
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'No se pudo crear la atención', error: error.message });
  }
};

/**
 * Qué ve un enfermero en su bandeja.
 *
 * Tres criterios, porque conviven dos formas de mandar una cita a enfermería:
 *  · la NUEVA — recepción pone un turno de enfermería al asignar, y ese turno
 *    puede estar ABIERTO (lo toma el primero que lo vea) o NOMBRADO a alguien;
 *  · la VIEJA — la cita lleva un servicio del inventario con `nursingService`.
 * El segundo se mantiene para que las citas ya agendadas no desaparezcan de la
 * bandeja el día del despliegue.
 *
 * YA NO SE FILTRA POR `attendedByNurse`. Ese campo pasó a ser un espejo del
 * último turno de enfermería y nunca se suelta: con dos turnos seguidos —un
 * detox que atiende una y luego otra— se quedaba clavado en la primera y la
 * segunda no llegaba a ver la cita ni siendo suyo el turno. Ahora manda el
 * turno vigente (`currentTurnUser`), que es quien de verdad tiene la pelota.
 */
async function filtroEnfermeria(req) {
  const nursingProductIds = await Product.find({ nursingService: true }).distinct('_id');
  const nursingItemIds = await require('../models/AppointmentServiceItem')
    .find({ nursingService: true })
    .distinct('_id');

  const legado = {
    $and: [
      { turns: { $in: [null, []] } },
      {
        $or: [
          { 'services.product': { $in: nursingProductIds } },
          { serviceItem: { $in: nursingItemIds } },
        ],
      },
      // En las citas viejas no hay turno que mande, así que sigue valiendo el
      // campo antiguo: libre, o mía.
      { $or: [{ attendedByNurse: null }, { attendedByNurse: req.user._id }] },
    ],
  };

  return {
    ...filtroCitasDeEnfermeria(req.user._id, legado),
    status: { $in: ['asistida', 'completada'] },
  };
}

/**
 * ASIGNA LA ATENCIÓN de la cita: la cola de profesionales por los que pasa el
 * paciente. Es lo único que hace recepción cuando llega.
 *
 * Formato principal: `{ steps: [{kind:'doctor', user}, {kind:'enfermeria'}, …] }`
 * EN EL ORDEN de atención — enfermería es un paso más, no un añadido al final,
 * porque lo habitual es que tome los signos ANTES de que pase el doctor.
 * Se siguen aceptando `{ doctors: [id, …], nursing: bool }` y el `{ doctorId }`
 * de antes, para los clientes viejos.
 *
 * PONE LA CITA EN 'asistida' AUNQUE NADIE PULSE "asistió". Se quitó ese paso
 * porque se sobreentiende: si recepción está repartiendo la atención es porque
 * el paciente está delante. El estado no es cosmético — alimenta comisiones,
 * supervisión, "paciente nuevo" y el barrido de `utils/autoNoShow.js`, que al
 * cerrar el día da por ausente todo lo que siga 'pendiente'.
 *
 * Marcar asistencia SIN repartir la atención tiene su propia puerta
 * (`markAttended`, POST /:id/attended): quién viene y quién le atiende son dos
 * preguntas distintas y no hay que contestar la segunda para contestar la
 * primera.
 */
exports.assignDoctor = async (req, res) => {
  try {
    // Cola tal cual la mandó recepción. Si viene el formato viejo, se traduce a
    // pasos: los doctores en fila y enfermería detrás.
    const pasos = Array.isArray(req.body.steps)
      ? normalizarPasos(req.body.steps)
      : [
          ...(Array.isArray(req.body.doctors)
            ? req.body.doctors.filter(Boolean).map((u) => ({ kind: 'doctor', user: String(u) }))
            : req.body.doctorId
              ? [{ kind: 'doctor', user: String(req.body.doctorId) }]
              : []),
          ...(req.body.nursing ? [{ kind: 'enfermeria' }] : []),
        ];

    const doctores = pasos.filter((p) => p.kind === 'doctor').map((p) => p.user);
    const enfermeria = pasos.some((p) => p.kind === 'enfermeria');
    /**
     * LA COLA PUEDE QUEDAR VACÍA, y eso es una respuesta legítima.
     *
     * Antes se exigía «al menos un doctor o enfermería», y con eso pasaban dos
     * cosas que mostrador reportó: para corregir un no-show —«sí vino»— había que
     * inventarse un profesional, y quitar al doctor que se había puesto por error
     * era imposible, porque guardar sin nadie estaba prohibido. El ESTADO de la
     * cita y QUIÉN la atiende son dos cosas distintas.
     *
     * Sin nadie en la cola, la cita queda recibida y a la espera de que se
     * decida quién la ve. Los turnos ya completados no se tocan (los conserva
     * `asignarTurnos`), así que esto no borra a nadie que ya haya atendido.
     */
    // Lo que recepción anota al recibir al paciente ("viene con la mamá", "pidió
    // factura a nombre de la empresa"). No es dato clínico: va a la bitácora de
    // Observaciones del paciente, que es donde lo va a buscar el resto.
    const observacion = String(req.body.observation || '').trim();

    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });

    /**
     * Una consulta YA ATENDIDA no cambia de manos. `asignarTurnos` conserva los
     * turnos completados, pero el espejo `doctor` pasaría a apuntar al nuevo y
     * la cita acabaría diciendo que la atendió alguien que no estuvo. Reasignar
     * es cosa de antes de entrar a consulta, no de después.
     */
    const previo = apt.doctor ? String(apt.doctor) : '';
    if (previo && consultationDone(apt) && !doctores.includes(previo)) {
      return res.status(400).json({ message: DOCTOR_LOCKED_MESSAGE });
    }

    // Quien atiende tiene que ser de la sucursal de la cita (ver
    // `validarPersonalDeLaSede`, que comparte con el alta de la cita).
    const errorPersonal = await validarPersonalDeLaSede(
      pasos.map((p) => p.user),
      apt.clinic
    );
    if (errorPersonal) return res.status(400).json({ message: errorPersonal });

    const anteriores = doctoresPendientes(apt);
    const wasAttended = apt.status === 'asistida' || apt.status === 'completada';

    /**
     * EL SERVICIO DE LA CITA, corregido en el mismo gesto de recibir al paciente.
     *
     * Es cuando se sabe a qué viene de verdad: media agenda se cierra por
     * teléfono con un «viene mañana, ya veremos a qué». Antes había que salir de
     * la asignación y entrar por «Cambiar servicio y valor», dos pantallas para
     * escribir una palabra.
     *
     * Solo si viene en la petición: quien asigne desde una pantalla vieja no
     * puede borrarle el servicio a la cita por no mandarlo. Va por la misma
     * puerta que el resto (`resolverServicioAgenda`) y ANTES del suero, para que
     * un servicio nuevo con suero de serie se siembre en la ficha aquí mismo.
     */
    if (req.body.serviceItem !== undefined) {
      const svc = await resolverServicioAgenda(req.body.serviceItem);
      apt.serviceItem = svc?._id || null;
      // `serviceName` es el snapshot que leen la lista, los reportes y el
      // recordatorio de WhatsApp sin populate: los dos se cambian juntos.
      apt.serviceName = svc?.name || '';
    }

    /**
     * QUÉ SUEROS TENÍA ESCRITOS LA CITA ANTES DE TOCARLA.
     *
     * `asignarTurnos` rehace la cola entera, así que después ya no hay forma de
     * saber qué había. Se guarda aquí para poder limpiar de la ficha los que se
     * queden sin dueño: quitar el suero de un paso —o el paso entero— dejaba su
     * receta huérfana en la historia del paciente, y enfermería la veía como
     * algo pendiente de ponerle.
     */
    const suerosAntes = (apt.turns || [])
      .filter((t) => t.kind === 'enfermeria' && t.serumFollowUp)
      .map((t) => String(t.serumFollowUp));
    /** Los que la pantalla marcó como CORREGIDOS (ver `serumTocado`). */
    const suerosTocados = new Set(
      pasos
        .filter((x) => x.kind === 'enfermeria' && x.serumTocado && x.serumFollowUp)
        .map((x) => String(x.serumFollowUp))
    );

    asignarTurnos(apt, { pasos, por: req.user._id });

    // El valor de la cita se anota AQUÍ, en el mismo gesto de recibir al
    // paciente: este modal es lo que sustituyó al antiguo "marcar asistió", y es
    // el momento en que recepción tiene delante a quien va a pagar. Solo lo
    // guarda si el rol puede (admin/cajero) — ver `aplicarValorDeCita`.
    aplicarValorDeCita(apt, req.body, req);

    /**
     * Asignar da la cita por ASISTIDA, pero SOLO si es de hoy.
     *
     * Se hace porque el paso de "marcar asistió" desapareció del flujo normal:
     * si recepción está repartiendo la atención, el paciente está delante y la
     * cita tiene que reflejarlo sin un clic más.
     *
     * Pero eso vale para el paciente que YA llegó. Dejar preparado el doctor de
     * una cita de mañana no puede darla por atendida hoy: esa cita sigue
     * pendiente, y si el paciente no aparece, `autoNoShow` la marcará ausente
     * como cualquier otra cuando termine su día.
     */
    const esDeHoy = !isFutureLocalDate(apt.date);
    /**
     * 'no_asistio' TAMBIÉN se corrige. Puede venir del barrido de fin de día o
     * del botón del mostrador; si ahora se está asignando al doctor es porque el
     * paciente está delante, así que la marca anterior estaba equivocada y lo
     * que manda es lo último. Sin esto la cita se atendía —el doctor la
     * recibía igual, su bandeja va por turnos y no por estado— pero quedaba
     * registrada como que el paciente no vino, y así entraba en los reportes.
     *
     * Vale igual para la marca a mano ("No asistió" del mostrador): si luego se
     * asigna al doctor, el paciente llegó y lo que manda es lo último.
     *
     * 'cancelada' NO se toca: esa la canceló una persona a propósito.
     */
    const estabaAusente = apt.status === 'no_asistio';
    if (
      // Con la cola VACÍA no se toca el estado: eso no es recibir a nadie, es
      // quitar a quien estuviera asignado. Quién viene y quién le atiende siguen
      // siendo dos preguntas distintas —para la primera está `markAttended`, el
      // botón «Asistió»— y guardar sin nadie no puede contestar las dos.
      pasos.length &&
      esDeHoy &&
      (apt.status === 'pendiente' || apt.status === 'confirmada' || estabaAusente)
    ) {
      apt.status = 'asistida';
      // Repartir la atención ES recibir al paciente: queda sellada su hora de
      // llegada, igual que si se hubiera pulsado «Asistió». Solo la primera vez
      // (reabrir este modal para añadir un doctor no la corre).
      registrarLlegada(apt);
    }
    await apt.save();

    /**
     * EL SUERO INDICADO AQUÍ SE ESCRIBE EN LA FICHA.
     *
     * El nombre del paso es un rótulo: escribir «suero ala 20 ml» en él no le
     * deja a enfermería nada que aplicar, porque lo que se aplica es una línea
     * de receta con `isSerum`. Mostrador escoge las ampollas del catálogo en el
     * mismo modal y aquí se escriben, tal cual las receta un médico —con su
     * «Administrar» y su descuento de inventario—.
     *
     * En su propio try: la asignación ya está guardada y es lo que el paciente
     * está esperando en el mostrador; que falle el añadido a la ficha no puede
     * tirarla. La marca `serumFollowUp` hace que el siguiente guardado lo
     * reintente sin duplicar lo ya escrito.
     */
    let suerosSembrados = [];
    let suerosAvisos = [];
    try {
      /**
       * El de serie del SERVICIO, si la cita todavía no lo tiene. Cubre a las
       * agendadas antes de que esto existiera —un «Detox Plus» de la semana
       * pasada— y a las que se agendaron sin servicio y se lo pusieron después.
       * `autoSerumFollowUp` es lo que impide que se escriba dos veces.
       */
      if (apt.serviceItem) {
        const AppointmentServiceItem = require('../models/AppointmentServiceItem');
        const svc = await AppointmentServiceItem.findById(apt.serviceItem).lean();
        const { sueroterapiaDeLaCita, sembrarSueroEnFicha, faltaElSueroDelServicio } = require('../utils/sueroDeCita');
        // La MISMA pregunta que las otras dos puertas: no basta con «¿hay marca?»,
        // porque en este modal también se corrige el servicio de la cita y el
        // suero que hay escrito puede ser el del servicio anterior.
        const lineas = faltaElSueroDelServicio(apt, svc) ? sueroterapiaDeLaCita(svc) : [];
        if (lineas.length) {
          const fu = await sembrarSueroEnFicha({
            clinicId: apt.clinic,
            patientId: apt.patient,
            user: req.user,
            role: req.role,
            lineas,
            motivo: `Suero del servicio (${svc.name})`,
          });
          if (fu) {
            apt.autoSerumFollowUp = fu._id;
            apt.autoSerumServiceItem = svc._id;
            suerosSembrados.push(...lineas.map((l) => l.name));
          }
        }
      }

      const r = await sembrarSuerosDeLosTurnos(apt, req, { tocados: suerosTocados });
      suerosSembrados.push(...r.sembrados, ...r.corregidos);
      suerosAvisos.push(...r.avisos);
      // Y los que se quedaron sin dueño se van de la ficha.
      suerosAvisos.push(...(await limpiarSuerosHuerfanos(apt, suerosAntes)));
      if (suerosSembrados.length || r.corregidos.length || suerosAntes.length) {
        await apt.save();
        emitToClinic(apt.clinic, 'clinicalRecord:updated', { patient: apt.patient });
      }
    } catch (e) {
      console.warn('No se pudo escribir el suero de la asignación en la ficha:', e.message);
    }

    if (apt.referral) {
      try {
        const Referral = require('../models/Referral');
        await Referral.findOneAndUpdate(
          { _id: apt.referral, clinic: apt.clinic },
          { status: 'atendida' }
        );
      } catch (_) {}
    }

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('services.product', 'name code salePrice category');

    // La observación se guarda DESPUÉS de que la asignación esté hecha y en su
    // propio try: que falle una nota no puede tirar la asignación, que es lo que
    // el paciente está esperando en el mostrador.
    if (observacion) {
      try {
        const PatientObservation = require('../models/PatientObservation');
        await PatientObservation.create({
          clinic: apt.clinic,
          patient: apt.patient,
          text: observacion,
          createdBy: req.user._id,
        });
      } catch (e) {
        console.warn('[citas] no se pudo guardar la observación del paciente:', e.message);
      }
    }

    emitToClinic(apt.clinic, 'appointment:updated', populated);
    await notificarAsignacion(req, populated, { doctores, enfermeria, anteriores });

    /**
     * La automatización de "cita asistida", solo la primera vez Y solo si la
     * cita quedó de verdad asistida. Antes bastaba con asignar para dispararla,
     * así que dejar preparado el doctor de una cita de la semana que viene —o
     * quitarle el doctor a una cualquiera— anunciaba una asistencia que no había
     * ocurrido.
     */
    const quedaAsistida = populated.status === 'asistida' || populated.status === 'completada';
    if (!wasAttended && quedaAsistida) {
      emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_ATTENDED, appointmentEventPayload(populated));
    }
    // `autoSerum` lo lee la pantalla para decir que el suero ya quedó escrito en
    // los seguimientos. Va aparte del documento: no es un campo de la cita.
    res.json(
      suerosSembrados.length || suerosAvisos.length
        ? { ...populated.toObject(), autoSerum: { items: suerosSembrados, avisos: suerosAvisos } }
        : populated
    );
  } catch (error) {
    res.status(500).json({ message: 'Error al asignar la atención', error: error.message });
  }
};

/**
 * Avisa a quien acaba de recibir la cita: socket para las pestañas abiertas y
 * notificación push para el móvil (que es donde está el profesional cuando
 * recepción asigna).
 *
 * En enfermería hay DOS casos y se distinguen por el dueño del turno: si
 * recepción nombró a alguien, el aviso va solo a esa persona; si el turno quedó
 * abierto, va al rol entero y la toma el primero que pueda.
 */
async function notificarAsignacion(req, apt, { doctores, enfermeria, anteriores = [] }) {
  /**
   * La sucursal es la DE LA CITA, no la activa de quien asigna. Caja agenda y
   * asigna para otra sede desde su mostrador: con `req.clinicId` el turno de
   * enfermería salía a la bandeja —y al móvil— de los enfermeros de la sucursal
   * equivocada, y en la que de verdad atiende no se enteraba nadie.
   */
  const clinicId = apt.clinic;
  const { pacienteDeCita, servicioDeCita, cuerpoDeAviso, urlDeAtencion } = require('../utils/appointmentNotice');
  const paciente = await pacienteDeCita(apt);
  const cuerpo = cuerpoDeAviso({
    paciente,
    servicio: servicioDeCita(apt),
    hora: apt.startTime,
  });

  /**
   * Solo se avisa a QUIEN LE TOCA AHORA. Si se asignan tres doctores en fila,
   * los otros dos no se enteran hasta que el de delante guarde su seguimiento
   * (ese aviso lo manda clinicalRecordController al cerrar el turno). Avisarlos
   * a la vez llenaría tres consultorios esperando al mismo paciente.
   */
  const enTurno = doctorEnTurno(apt);
  // El turno de enfermería tampoco sale a la bandeja mientras haya un doctor
  // por delante: la cola es la misma para todos.
  const leTocaEnfermeria = enfermeria && !enTurno && turnoVigenteEsEnfermeria(apt);
  // Nombrado, o abierto a todos. `null` = a todos.
  const enfermeroNombrado = leTocaEnfermeria ? enfermeroEnTurno(apt) : null;

  if (enTurno) emitToUser(enTurno, 'appointment:assigned', apt);
  // Quien deja de tenerla —o quien sigue en la cola— también se entera, para que
  // su lista quede al día sin anunciarle nada.
  for (const id of [...new Set([...anteriores, ...doctores])]) {
    if (id !== enTurno) emitToUser(id, 'appointment:updated', apt);
  }
  if (leTocaEnfermeria) {
    if (enfermeroNombrado) emitToUser(enfermeroNombrado, 'appointment:assigned', apt);
    else emitToRole(clinicId, 'enfermero', 'appointment:assigned', apt);
  }

  try {
    const { notificarUsuarios, notificarRol } = require('../utils/pushNotifications');
    if (enTurno) {
      await notificarUsuarios([enTurno], {
        clinicId,
        type: 'appointment_assigned',
        title: 'Cita asignada',
        body: cuerpo,
        url: urlDeAtencion(apt.patient, apt._id),
      });
    }
    if (leTocaEnfermeria) {
      const aviso = {
        type: 'appointment_nursing',
        title: 'Cita para enfermería',
        body: cuerpo,
        // A los seguimientos del paciente, no a la agenda: el aviso ya sabe a
        // quién hay que atender y dejarlo dicho a medias obligaba a buscarlo.
        url: urlDeAtencion(apt.patient, apt._id),
      };
      if (enfermeroNombrado) {
        await notificarUsuarios([enfermeroNombrado], { clinicId, ...aviso });
      } else {
        await notificarRol(clinicId, 'enfermero', aviso);
      }
    }
  } catch (err) {
    // Que falle un aviso NUNCA puede tumbar la asignación: la cita ya está
    // asignada y el profesional la ve igual al entrar a su agenda.
    console.warn('[citas] no se pudo notificar la asignación:', err.message);
  }
}

/**
 * Marca no asistencia.
 */
exports.markNoShow = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    // Idempotente: un doble clic no debe re-emitir el evento (y con él, otro
    // mensaje de la automatización de no-show).
    if (apt.status === 'no_asistio') return res.json(apt);
    apt.status = 'no_asistio';
    await apt.save();
    emitToClinic(apt.clinic, 'appointment:updated', apt);
    // Sin este evento, el botón "No asistió" jamás disparaba los workflows de
    // no-show (solo el job nocturno de citas vencidas lo hacía).
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_NO_SHOW, appointmentEventPayload(apt));
    res.json(apt);
  } catch (error) {
    res.status(500).json({ message: 'Error al marcar no asistencia' });
  }
};

/**
 * Confirma una cita (paciente confirmó asistencia).
 */
exports.markConfirmed = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    // Idempotente: confirmar dos veces no re-dispara la automatización.
    if (apt.status === 'confirmada') return res.json(apt);
    apt.status = 'confirmada';
    await apt.save();
    emitToClinic(apt.clinic, 'appointment:updated', apt);
    emitDomainEvent(DOMAIN_EVENTS.APPOINTMENT_CONFIRMED, appointmentEventPayload(apt));
    res.json(apt);
  } catch (error) {
    res.status(500).json({ message: 'Error al confirmar cita' });
  }
};

/** Avanza los tratamientos del paciente al completar una cita de enfermería. */
const advanceTreatmentsForAppointment = async (clinicId, apt) => {
  try {
    const Treatment = require('../models/Treatment');
    const services = (apt.services || []).map((s) => String(s.product));
    if (!services.length || !apt.patient) return;
    const treatments = await Treatment.find({
      clinic: clinicId,
      patient: apt.patient,
      status: { $in: ['activo', 'abandonado'] },
    });
    for (const t of treatments) {
      let changed = false;
      for (const svcId of services) {
        const idx = t.items.findIndex(
          (it) => String(it.product) === svcId && (it.completed || 0) < it.quantity
        );
        if (idx >= 0) {
          t.items[idx].completed += 1;
          t.items[idx].completionRefs.push({ type: 'appointment', ref: apt._id, date: new Date() });
          changed = true;
        }
      }
      if (changed) {
        t.lastActivityAt = new Date();
        if (t.status === 'abandonado') { t.status = 'activo'; t.abandonedAt = undefined; }
        if (t.progress >= 100) t.status = 'completado';
        await t.save();
      }
    }
  } catch (e) {
    console.warn('No se pudo actualizar tratamientos (enfermería):', e.message);
  }
};

/**
 * Enfermero/a RECLAMA una cita de servicios de enfermería (p.ej. sueroterapia).
 * Cualquier enfermero puede reclamarla mientras `attendedByNurse` esté vacío.
 * Al reclamarla queda asignada a ese enfermero y desaparece para los demás; la
 * cita sigue en 'asistida' (en atención) hasta que el enfermero la finalice.
 */
exports.nurseClaim = async (req, res) => {
  try {
    const previa = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) })
      .select('clinic currentTurnKind currentTurnUser turns attendedByNurse')
      .lean();
    if (!previa) return res.status(404).json({ message: 'Cita no encontrada' });

    const conTurnos = (previa.turns || []).length > 0;

    /**
     * Solo si a enfermería LE TOCA. Con la cola ordenada, un turno de enfermería
     * puede estar detrás de un doctor; la bandeja ya no lo enseña, pero una
     * pantalla abierta desde antes sí podría mandarlo, y reclamarlo pondría la
     * cita en manos de enfermería con el paciente aún en consulta.
     */
    if (conTurnos && previa.currentTurnKind !== 'enfermeria') {
      return res.status(409).json({
        message: 'Todavía le toca al doctor. La cita pasará a enfermería cuando él termine.',
        code: 'NOT_YOUR_TURN',
      });
    }

    // Y solo si el turno vigente es SUYO o está abierto. Cuando recepción nombra
    // a una enfermera concreta, el turno es de ella: que lo tome otra dejaría el
    // registro diciendo que atendió quien no era.
    const dueño = previa.currentTurnUser ? String(previa.currentTurnUser) : null;
    if (conTurnos && dueño && dueño !== String(req.user._id)) {
      const quien = await require('../models/User').findById(dueño).select('name').lean();
      return res.status(409).json({
        message: `Este turno es de ${quien?.name || 'otro enfermero/a'}.`,
        code: 'ALREADY_CLAIMED',
      });
    }

    let apt;
    if (conTurnos) {
      /**
       * RECLAMO ATÓMICO, SOBRE EL TURNO. La cita sale a la bandeja de todos los
       * enfermeros a la vez, así que dos pueden pulsar "atender" en el mismo
       * segundo. Con leer-comprobar-guardar los dos verían el turno libre y el
       * segundo pisaría al primero: dos personas con el mismo paciente y un solo
       * registro. La condición viaja DENTRO del update (`'t.user': null`), así
       * que la gana uno solo.
       *
       * Va sobre el TURNO y no sobre la cita porque un detox lleva dos turnos de
       * enfermería seguidos: bloquear la cita entera dejaba fuera a la segunda.
       */
      const idTurno = previa.turns.find(
        (t) => t.kind === 'enfermeria' && t.status === 'pendiente'
      )?._id;
      apt = await Appointment.findOneAndUpdate(
        { _id: req.params.id, clinic: previa.clinic, currentTurnKind: 'enfermeria' },
        {
          $set: {
            'turns.$[t].user': req.user._id,
            'turns.$[t].startedAt': new Date(),
            // La cita se da por asistida al reclamarla: el paciente está delante.
            status: 'asistida',
          },
        },
        {
          new: true,
          arrayFilters: [
            {
              't._id': idTurno,
              't.status': 'pendiente',
              // Libre, o ya suyo (para que reintentar no falle). Va con `$in` y
              // NO con `$or`: Mongo rechaza un `$or` dentro de un filtro de
              // arreglo («Expected a single top-level field name»), y la
              // petición entera se caía con un 500.
              't.user': { $in: [null, req.user._id] },
            },
          ],
        }
      );
      // `modifiedCount` no sirve para saber si se ganó la carrera: con
      // arrayFilters que no casan, Mongo informa igual de una modificación. Se
      // comprueba contra el DOCUMENTO devuelto, que es la única verdad.
      const gano = (apt?.turns || []).some(
        (t) => String(t._id) === String(idTurno) && String(t.user) === String(req.user._id)
      );
      if (!gano) {
        const otra = await Appointment.findById(req.params.id).populate('turns.user', 'name').lean();
        const t = (otra?.turns || []).find((x) => String(x._id) === String(idTurno));
        return res.status(409).json({
          message: `Esta cita ya la está atendiendo ${t?.user?.name || 'otro enfermero/a'}.`,
          code: 'ALREADY_CLAIMED',
        });
      }
    } else {
      // CITAS VIEJAS, sin turnos: sigue mandando el campo de antes.
      apt = await Appointment.findOneAndUpdate(
        {
          _id: req.params.id,
          clinic: previa.clinic,
          $or: [{ attendedByNurse: null }, { attendedByNurse: req.user._id }],
        },
        { $set: { attendedByNurse: req.user._id, nurseClaimedAt: new Date(), status: 'asistida' } },
        { new: true }
      );
      if (!apt) {
        const existe = await Appointment.findOne({ _id: req.params.id, clinic: previa.clinic })
          .populate('attendedByNurse', 'name')
          .lean();
        return res.status(409).json({
          message: `Esta cita ya la está atendiendo ${existe?.attendedByNurse?.name || 'otro enfermero/a'}.`,
          code: 'ALREADY_CLAIMED',
        });
      }
    }

    // El espejo `attendedByNurse` lo pone `sincronizarEspejo` a partir del turno
    // que se acaba de reclamar: aquí ya no se escribe a mano.
    sincronizarEspejo(apt);
    // Reclamar el turno deja la cita en 'asistida' (el paciente está delante),
    // así que también sella su llegada — salvo que mostrador ya la hubiera
    // sellado antes, que es lo normal.
    registrarLlegada(apt);
    if (!apt.consultationStartedAt) apt.consultationStartedAt = new Date();
    await apt.save();

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('turns.user', POPULATE_DOCTOR)
      .populate('serviceItem', POPULATE_SERVICE_ITEM)
      .populate('services.product', 'name code salePrice category nursingService');
    emitToClinic(apt.clinic, 'appointment:updated', populated);
    // A los demás enfermeros les desaparece de la bandeja en el momento, sin
    // recargar: es lo que evita que dos vayan a por el mismo paciente.
    emitToRole(apt.clinic, 'enfermero', 'appointment:claimed', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al reclamar la cita', error: error.message });
  }
};

/**
 * Enfermero/a FINALIZA la cita que reclamó: pasa a 'completada' y registra
 * automáticamente en el seguimiento del paciente que se aplicó el servicio,
 * con el enfermero y los signos vitales (sin que el enfermero llene el formulario).
 */
exports.nurseComplete = async (req, res) => {
  try {
    const apt = await Appointment.findOne({ _id: req.params.id, ...filtroSucursalCita(req) });
    if (!apt) return res.status(404).json({ message: 'Cita no encontrada' });
    const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
    /**
     * El permiso lo da EL TURNO PROPIO, no el espejo `attendedByNurse`.
     *
     * Ese espejo apunta a la última enfermera que atendió y nunca se suelta: con
     * un detox de dos turnos, la segunda se encontraba un 403 al terminar lo que
     * acababa de hacer ella misma.
     */
    const miTurno = (apt.turns || []).find(
      (t) => t.kind === 'enfermeria' && t.status === 'pendiente' && String(t.user) === String(req.user._id)
    );
    const conTurnos = (apt.turns || []).length > 0;
    if (conTurnos && !miTurno && !isAdmin) {
      return res.status(403).json({
        message: apt.currentTurnKind === 'enfermeria'
          ? 'Primero reclama el turno para poder finalizarlo.'
          : 'Este turno no es tuyo.',
        code: 'NOT_YOUR_TURN',
      });
    }
    if (!conTurnos && !apt.attendedByNurse) {
      return res.status(400).json({ message: 'Primero reclama la cita para poder finalizarla.' });
    }
    if (!conTurnos && String(apt.attendedByNurse) !== String(req.user._id) && !isAdmin) {
      return res.status(403).json({ message: 'Solo el enfermero/a que reclamó la cita puede finalizarla.' });
    }
    /**
     * Cierra EL TURNO de enfermería, no la cita entera.
     *
     * Enfermería puede ir por delante de un doctor (tomar los signos y pasarlo).
     * Darla por 'completada' aquí dejaba al doctor de detrás sin su paciente y
     * la consulta sin hacer. Solo se completa si no queda nadie pendiente.
     */
    const { completarTurno } = require('../utils/appointmentTurns');
    // El servicio de ESTE turno, leído antes de cerrarlo: es lo que hace que el
    // seguimiento automático diga «Detox» y no el genérico de siempre.
    const servicioDelTurno = miTurno?.serviceName || '';
    /**
     * Desde cuándo cuenta lo que aplicó. Se lee ANTES de cerrar el turno porque
     * `completarTurno` lo marca como completado. Con dos turnos de la misma
     * enfermera en la misma cita (un detox por la mañana y un suero por la
     * tarde), sin esta ventana el segundo parte repetiría el primero.
     */
    const inicioDelTurno = miTurno?.startedAt || apt.nurseClaimedAt || apt.consultationStartedAt || null;
    const { siguiente, terminado } = completarTurno(apt, { userId: req.user._id });

    apt.nurseAttendedAt = new Date();
    if (!apt.consultationStartedAt) apt.consultationStartedAt = new Date();
    if (terminado || !(apt.turns || []).length) {
      apt.status = 'completada';
      apt.consultationEndedAt = new Date();
    }
    await apt.save();

    /**
     * Al siguiente le llega la cita ahora, en su pantalla y en su móvil. Tres
     * casos, y los tres se dan en un detox de dos turnos:
     *  · el siguiente tiene dueño (un doctor, o la enfermera nombrada) → a él;
     *  · el siguiente es un turno de enfermería ABIERTO → a todos los enfermeros;
     *  · no hay siguiente → no se avisa a nadie, la cita terminó.
     */
    if (siguiente) {
      const { pacienteDeCita, servicioDeCita, cuerpoDeAviso, urlDeAtencion } = require('../utils/appointmentNotice');
      // El nombre del paciente encabeza el aviso: «Enfermería terminó su parte»
      // a secas no dice a por quién hay que ir (ver utils/appointmentNotice).
      const paciente = await pacienteDeCita(apt);
      const servicio = servicioDeCita(apt, siguiente);
      const cuerpo = cuerpoDeAviso({
        paciente,
        servicio,
        hora: apt.startTime,
        motivo: servicio ? '' : 'Enfermería terminó su parte.',
      });
      if (siguiente.user) {
        emitToUser(siguiente.user, 'appointment:assigned', apt);
        const { notificarUsuarios } = require('../utils/pushNotifications');
        await notificarUsuarios([siguiente.user], {
          clinicId: apt.clinic,
          type: 'appointment_assigned',
          title: 'Te toca atender',
          body: cuerpo,
          // El doctor abre por la ficha (antecedentes antes de explorar);
          // enfermería, directa a los seguimientos, que es donde trabaja.
          url: urlDeAtencion(apt.patient, apt._id, siguiente.kind === 'enfermeria' ? 'seguimientos' : 'ficha'),
        }).catch(() => {});
      } else {
        emitToRole(apt.clinic, 'enfermero', 'appointment:assigned', apt);
        const { notificarRol } = require('../utils/pushNotifications');
        await notificarRol(apt.clinic, 'enfermero', {
          type: 'appointment_nursing',
          title: 'Cita para enfermería',
          body: cuerpo,
          url: urlDeAtencion(apt.patient, apt._id),
        }).catch(() => {});
      }
    }

    await advanceTreatmentsForAppointment(apt.clinic, apt);

    // Auto-registro en el seguimiento del paciente (no lo llena el enfermero).
    try {
      const ClinicalRecord = require('../models/ClinicalRecord');
      /**
       * QUÉ SE APLICÓ, en este orden: lo del TURNO primero.
       *
       * Antes solo se miraba `apt.services`, el arreglo LEGADO del inventario,
       * que en las citas de hoy va casi siempre vacío: el resultado era que
       * todos los partes decían «Servicio de enfermería». Con dos enfermeras en
       * la misma cita eso son dos seguimientos idénticos, y ninguna forma de
       * saber cuál fue el detox y cuál el suero.
       */
      const serviceNames =
        servicioDelTurno ||
        apt.serviceName ||
        (apt.services || []).map((s) => s.name).filter(Boolean).join(', ') ||
        'Servicio de enfermería';
      // La historia clínica es UNA por paciente, venga la cita de la sede que
      // venga (ver la cabecera de models/ClinicalRecord). `clinic` solo se
      // escribe al abrirla, para dejar dicho dónde empezó.
      let record = await ClinicalRecord.findOne({ patient: apt.patient });
      if (!record) {
        record = await ClinicalRecord.create({ clinic: apt.clinic, patient: apt.patient, createdBy: req.user._id });
      }
      /**
       * LO QUE DE VERDAD SE APLICÓ.
       *
       * La aplicación vive dentro de la receta del doctor que la mandó, que es
       * otra tarjeta y casi siempre otro día: aquí solo quedaba «Servicio
       * aplicado por enfermería», que no dice ni el suero ni las ampollas. Se
       * copia lo que puso ESTA persona desde que empezó SU turno.
       */
      const { aplicacionesDelTurno, resumenAplicacion } = require('../utils/nurseApplications');
      const aplicaciones = aplicacionesDelTurno(record, req.user._id, inicioDelTurno);
      // El detalle va DENTRO de las observaciones además de en `aplicaciones`:
      // los PDF y la hoja MSP leen texto, no el arreglo nuevo.
      const detalle = aplicaciones.map(resumenAplicacion).filter(Boolean);
      const vs = req.body.vitalSigns || {};
      record.followUps.push({
        fecha: new Date(),
        kind: 'enfermeria',
        createdByRole: req.role || '',
        motivoConsulta: `Aplicación de enfermería: ${serviceNames}`,
        aplicaciones,
        observaciones:
          req.body.note
          || (detalle.length ? `Se aplicó: ${detalle.join(' · ')}.` : 'Servicio aplicado por enfermería.'),
        vitalSigns: {
          // La hora de la toma la sella el sistema, no se digita.
          hora: nowHHMM(),
          temperature: vs.temperature ?? null,
          bloodPressure: vs.bloodPressure || '',
          heartRate: vs.heartRate ?? null,
          respiratoryRate: vs.respiratoryRate ?? null,
          oxygenSaturation: vs.oxygenSaturation ?? null,
          weight: vs.weight ?? null,
          height: vs.height ?? null,
          glucose: vs.glucose ?? null,
        },
        createdBy: req.user._id,
      });
      record.updatedBy = req.user._id;
      await record.save();
    } catch (e) {
      console.warn('No se pudo registrar el seguimiento automático de enfermería:', e.message);
    }

    const populated = await Appointment.findById(apt._id)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('attendedByNurse', POPULATE_DOCTOR)
      .populate('services.product', 'name code salePrice category nursingService');
    emitToClinic(apt.clinic, 'appointment:updated', populated);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al finalizar la cita', error: error.message });
  }
};
/**
 * EL EXCEL DE LA AGENDA — POST /api/appointments/export.xlsx
 *
 * Lo pide mostrador desde la propia agenda, y lo que baja es EXACTAMENTE lo que
 * tiene delante: la pantalla manda los ids de las citas que está enseñando.
 *
 * ¿Por qué los ids y no los filtros? Porque la agenda filtra en el NAVEGADOR
 * —sucursal, servicio, franja horaria y bandeja no llegan a viajar al
 * servidor—, así que rehacer aquí ese filtrado sería copiar una lógica que se
 * desincroniza a la primera pantalla que se toque, y entonces el Excel diría
 * algo distinto de lo que el usuario está viendo. Que coincida no es un detalle:
 * el archivo se manda por WhatsApp y se usa para cuadrar el día.
 *
 * VA POR POST porque un mes de agenda son cientos de ids y no caben en una URL.
 *
 * Y NO SE FÍA DE LA LISTA: los ids llegan del cliente, así que se filtran por el
 * alcance real de quien pide (`sucursalesVisibles`). Pedir el id de una cita de
 * una sede a la que no llegas no la trae.
 */
exports.exportAppointments = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const validos = ids.filter((id) => mongoose.Types.ObjectId.isValid(id)).slice(0, MAX_CITAS_EXCEL);
    if (!validos.length) {
      return res.status(400).json({
        message: 'No hay ninguna cita que exportar con los filtros aplicados.',
      });
    }

    const filtro = { _id: { $in: validos } };
    const visibles = sucursalesVisibles(req);
    if (visibles !== null) filtro.clinic = { $in: visibles };

    const citas = await Appointment.find(filtro)
      .populate('patient', 'firstName lastName')
      .populate('clinic', 'name nombreComercial')
      .populate('doctor', 'name')
      .populate('turns.user', 'name')
      .populate('serviceItem', 'name')
      //  es a QUIEN SE ACREDITA la cita y  quien la
      // escribió, cuando no son la misma persona (el call center trabaja en
      // pareja: una la cierra por teléfono y otra la teclea).
      .populate('createdBy', 'name')
      .sort({ date: 1, startTime: 1 });

    if (!citas.length) {
      return res.status(404).json({ message: 'No se encontraron esas citas.' });
    }

    const { construirLibroDeAgenda } = require('../services/agendaWorkbook');
    // El título y los filtros los escribe la PANTALLA: es la única que sabe qué
    // está enseñando («8 de septiembre», «bandeja: en atención»). Se sanean por
    // longitud —van a una celda, no a una consulta— y se cae a algo genérico.
    const texto = (v, max) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
    const wb = construirLibroDeAgenda(citas, {
      titulo: 'AGENDA DE CITAS',
      subtitulo: texto(req.body?.subtitulo, 120) || 'Vikingo',
      periodo: texto(req.body?.periodo, 120) || 'Citas seleccionadas',
      filtros: texto(req.body?.filtros, 300),
      resumen:
        `${citas.length} ${citas.length === 1 ? 'cita' : 'citas'} · ` +
        `Generado por ${texto(req.user?.name, 60) || 'el sistema'} · ` +
        new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' }),
    });

    const nombre = `citas-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ message: 'No se pudo generar el Excel', error: error.message });
  }
};
