const mongoose = require('mongoose');

const appointmentServiceSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    price: Number,
  },
  { _id: false }
);

// Registro de cada reagendamiento (quien, cuando, fecha/horario anterior y razón).
const rescheduleEntrySchema = new mongoose.Schema(
  {
    previousDate: { type: Date, required: true },
    previousStartTime: { type: String },
    previousEndTime: { type: String },
    newDate: { type: Date, required: true },
    newStartTime: { type: String },
    newEndTime: { type: String },
    rescheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rescheduledByName: { type: String },
    rescheduledByRole: { type: String },
    reason: { type: String, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * TURNO de atención. Una cita puede pasar por varios profesionales en orden: el
 * paciente entra con el primero y, cuando ese guarda su seguimiento, la cita
 * pasa al siguiente. Solo cuando el último termina queda 'completada'.
 *
 * Cada turno guarda su propio `followUp` (el _id del seguimiento que escribió
 * ese profesional), así que dos doctores en la misma cita no se pisan la
 * historia clínica.
 *
 * `kind` distingue al doctor del enfermero porque no se asignan igual: al doctor
 * se le nombra, y el turno de enfermería sale a la bandeja de TODOS los
 * enfermeros hasta que uno lo reclama (y ahí se rellena `user`).
 */
const appointmentTurnSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['doctor', 'enfermeria'], default: 'doctor' },
    // En un turno de enfermería nace null: lo llena quien lo reclame.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    order: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pendiente', 'completado', 'omitido'],
      default: 'pendiente',
    },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Cuándo lo reclamó (enfermería) o empezó a atender.
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Seguimiento que escribió este profesional en su turno.
    followUp: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: true }
);

const appointmentSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'El paciente es requerido'],
    },
    /**
     * ESPEJO del turno vigente. NO se escribe a mano: lo mantiene
     * `utils/appointmentTurns.js` a partir de `turns[]`.
     *
     * Existe porque unos treinta sitios (agenda, dashboards, comisiones,
     * reportes, socket, notificaciones) leen `appointment.doctor` como un
     * escalar. Al pasar a varios doctores por turnos se conserva apuntando a
     * quien tiene la pelota en este momento —o al último que atendió si ya
     * terminaron todos— para que todo eso siga funcionando sin reescribirlo.
     */
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Cuándo y quién asignó al doctor (espejo del turno vigente).
    doctorAssignedAt: { type: Date },
    doctorAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /**
     * Turnos de atención, en orden. Es la FUENTE ÚNICA de quién atiende la cita:
     * `doctor`, `attendedByNurse` y el estado se derivan de aquí.
     * Vacío en las citas anteriores al cambio (y en las que aún no se asignaron).
     */
    turns: { type: [appointmentTurnSchema], default: [] },

    /**
     * Qué clase de turno tiene la pelota AHORA: 'doctor', 'enfermeria' o null si
     * ya no queda ninguno pendiente.
     *
     * Es un dato derivado de `turns[]`, igual que `doctor`, y lo escribe el mismo
     * sitio (utils/appointmentTurns.js). Existe porque "¿el turno vigente es el
     * de enfermería?" no se puede preguntar en una consulta de Mongo sobre el
     * arreglo, y de eso depende que una cita NO salga en la bandeja de los
     * enfermeros mientras el paciente siga con el doctor de delante.
     */
    currentTurnKind: { type: String, enum: ['doctor', 'enfermeria', null], default: null },

    /**
     * Y QUIÉN lo tiene, si es un doctor (null cuando le toca a enfermería, que
     * no tiene dueño hasta que alguien la reclama).
     *
     * No sirve `doctor` para esto: ese espejo apunta al doctor de la cita aunque
     * enfermería vaya por delante — es correcto para comisiones y reportes, pero
     * en la agenda del doctor la cita no debe salir hasta que le toque.
     */
    currentTurnUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    date: { type: Date, required: [true, 'La fecha es requerida'] },
    startTime: { type: String, required: [true, 'La hora de inicio es requerida'] },
    endTime: { type: String },
    // Consultorio (sala) físico donde se atenderá la cita
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
    // Estados ampliados:
    //   pendiente   - agendada / por confirmar
    //   confirmada  - paciente confirmó que asistirá
    //   asistida    - el paciente llegó (registrada por enfermería/recepción)
    //   no_asistio  - no se presentó
    //   cancelada   - cancelada por el paciente o la clínica
    //   completada  - ya atendida por el doctor
    status: {
      type: String,
      enum: ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'],
      default: 'pendiente',
    },
    // Marca si abonó por adelantado (check al agendar)
    paidInAdvance: { type: Boolean, default: false },
    advanceAmount: { type: Number, default: 0, min: 0 },
    reason: { type: String, trim: true },
    notes: { type: String, trim: true },
    diagnosis: { type: String, trim: true },
    treatment: { type: String, trim: true },
    // Servicios solicitados / a facturar (referenciados desde inventario).
    // LEGADO: lo llenaba el selector de servicios del formulario, que se retiró
    // al separar la parte operativa de la contable. Se conserva porque las citas
    // ya guardadas lo tienen y el cobro, las comisiones y los reportes lo leen.
    services: { type: [appointmentServiceSchema], default: [] },
    /**
     * Servicio de la cita — catálogo PROPIO de agenda, no el inventario.
     * `serviceName` es el snapshot: la lista, los reportes y el recordatorio de
     * WhatsApp lo leen sin populate y sin romperse si alguien renombra el ítem.
     */
    serviceItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AppointmentServiceItem',
      default: null,
      index: true,
    },
    serviceName: { type: String, trim: true, default: '' },
    // Marca si es la primera cita del paciente (registrado por primera vez).
    // Se calcula al crear: true si el paciente no tenía citas previas.
    isFirstVisit: { type: Boolean, default: false },
    // Cronómetro de consulta (lo arranca el doctor desde la UI).
    consultationStartedAt: { type: Date },
    consultationEndedAt: { type: Date },
    // Enfermero/a que atendió la cita (servicios tipo sueroterapia). Cualquier
    // enfermero del consultorio puede reclamarla; al hacerlo queda asignado.
    attendedByNurse: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Cuándo la reclamó (se pone al tomarla, no al terminarla): es lo que hace
    // que desaparezca de la bandeja de los demás enfermeros.
    nurseClaimedAt: { type: Date, default: null },
    nurseAttendedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Nombre de quien agendó (snapshot). El populate de `createdBy` se queda en
    // nada si esa persona se da de baja, y "agendada por" tiene que seguir
    // diciendo quién fue — igual que ya hacía `rescheduledByName`.
    createdByName: { type: String, trim: true, default: '' },
    // Rol del usuario que creó la cita (snapshot, útil para comisiones de call_center)
    createdByRole: { type: String },
    // Chat del que nació la cita (solo si se agendó desde el CRM). Es lo que
    // permite al panel de Supervisión contar las citas del call center sin
    // mezclarlas con las que un admin agenda desde la página de Citas.
    // Las citas anteriores a este campo no lo tienen: no se cuentan.
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null, index: true },
    // Historial de reagendamientos
    rescheduleHistory: { type: [rescheduleEntrySchema], default: [] },
    // Origen de la cita: si nació de una derivación o se agendó suelta
    origin: {
      type: String,
      enum: ['referral', 'standalone', 'treatment'],
      default: 'standalone',
    },
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
    treatmentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
  },
  { timestamps: true }
);

// El doctor busca "mis citas" y el enfermero busca "las de enfermería libres":
// los dos filtran por dentro de `turns`, que sin índice obliga a recorrer toda
// la colección de citas de la clínica en cada carga de la agenda.
appointmentSchema.index({ clinic: 1, 'turns.user': 1, date: 1 });
appointmentSchema.index({ clinic: 1, 'turns.kind': 1, 'turns.status': 1, date: 1 });

// Mapeo de estados legacy. Mantenemos compatibilidad pero ahora preservamos
// los estados detallados (cancelada / no_asistio) que antes se descartaban.
const LEGACY_STATUS_MAP = {
  programada: 'pendiente',
  en_curso: 'confirmada',
};

const normalizeStatus = (doc) => {
  if (doc && LEGACY_STATUS_MAP[doc.status]) doc.status = LEGACY_STATUS_MAP[doc.status];
};

appointmentSchema.post('find', function (docs) {
  if (Array.isArray(docs)) docs.forEach(normalizeStatus);
});
appointmentSchema.post('findOne', function (doc) { normalizeStatus(doc); });
appointmentSchema.post('findOneAndUpdate', function (doc) { normalizeStatus(doc); });

module.exports = mongoose.model('Appointment', appointmentSchema);
