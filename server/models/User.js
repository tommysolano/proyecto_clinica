const mongoose = require('mongoose');
const { VALID_ROLES } = require('../constants/roles');

const userClinicSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
    role: { type: String, enum: VALID_ROLES, required: true },
  },
  { _id: false }
);

const callCenterWorkIntervalSchema = new mongoose.Schema(
  {
    start: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, required: true },
    end: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, required: true },
  },
  { _id: false }
);

const callCenterWorkDaySchema = new mongoose.Schema(
  {
    day: { type: Number, min: 0, max: 6, required: true }, // 0=domingo
    enabled: { type: Boolean, default: false },
    // start/end se conservan para leer instalaciones que ya tenian un unico
    // turno. Las nuevas configuraciones usan intervals y pueden dividir el dia.
    start: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '09:00' },
    end: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '18:00' },
    intervals: { type: [callCenterWorkIntervalSchema], default: [] },
  },
  { _id: false }
);

const callCenterScheduleSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    timezone: { type: String, default: 'America/Guayaquil' },
    days: { type: [callCenterWorkDaySchema], default: [] },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'El nombre es requerido'], trim: true },
    email: {
      type: String,
      required: [true, 'El email es requerido'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'La contraseña es requerida'],
      minlength: 6,
    },
    // Indica si es super-admin (dueño): puede crear/gestionar clínicas globalmente
    isSuperAdmin: { type: Boolean, default: false },
    // Asignaciones de clínicas con su rol en cada una
    clinics: { type: [userClinicSchema], default: [] },
    /**
     * TRABAJA EN TODAS LAS SUCURSALES (sep-2026).
     *
     * En la clínica hay gente que no tiene sede: el mismo doctor pasa consulta
     * en Central por la mañana y en Extensión por la tarde, y el reparto cambia
     * cada semana según el horario. Con la asignación fija había que entrar a
     * moverlo de sucursal a mano cada vez —y mientras no se hacía, no aparecía
     * en el selector de doctores de la sede donde de verdad estaba.
     *
     * Marcado esto, la persona cuenta como asignada a CUALQUIER sucursal, con
     * el rol de su asignación. No es un rol nuevo ni un permiso extra: es la
     * misma persona con el mismo rol, en todas partes.
     *
     * Deliberadamente NO es una lista de sucursales. Quien trabaja en dos de
     * cinco es un caso que aquí no existe (hay tres sedes y quien rota, rota por
     * todas), y una lista obligaría a mantenerla cada vez que se abre una sede
     * nueva — que es exactamente el trabajo que este check viene a quitar.
     */
    worksInAllClinics: { type: Boolean, default: false },
    specialty: { type: String, trim: true },
    phone: { type: String, trim: true },
    cedula: { type: String, trim: true },
    /**
     * FIRMA ELECTRÓNICA del profesional (certificado .p12 / .pfx).
     *
     * Sustituye a la antigua `signatureImage`, que era una foto de la firma
     * escaneada: eso no firma nada, solo se parece a una firma. Con el
     * certificado la receta sale firmada criptográficamente dentro del PDF
     * (PAdES), y cualquiera puede comprobar quién la emitió y que no se ha
     * tocado desde entonces.
     *
     * El ARCHIVO vive en disco (`storage/certs/users/<userId>.p12`), igual que
     * el certificado del SRI; aquí solo queda el nombre. La CONTRASEÑA se guarda
     * cifrada (AES, `modules/invoicing/ec/crypto`) porque quien imprime la
     * receta no siempre es quien la firmó: la firma es del médico que atendió,
     * y el sistema tiene que poder ponerla aunque el PDF lo pida otro.
     *
     * `info` es la copia legible del certificado, para enseñarla en pantalla y
     * avisar del vencimiento sin tener que abrir el .p12 en cada pantalla.
     */
    signatureCert: {
      filename: { type: String, default: '' },
      password: { type: String, default: '' }, // cifrada, NUNCA en claro
      info: {
        commonName: { type: String, default: '' },
        subject: { type: String, default: '' },
        issuer: { type: String, default: '' },
        serialNumber: { type: String, default: '' },
        validFrom: { type: Date, default: null },
        validTo: { type: Date, default: null },
      },
      uploadedAt: { type: Date, default: null },
    },
    // Turnos del asesor. Si está activo, Supervisión descuenta del tiempo de
    // primera respuesta las horas en las que esa persona no debía estar trabajando.
    callCenterSchedule: { type: callCenterScheduleSchema, default: () => ({}) },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * EL ROL DE ESTA PERSONA EN ESTA SUCURSAL, o null si no trabaja ahí.
 *
 * Es el único sitio donde se responde a esa pregunta: de aquí salen `req.role`
 * (middleware/auth), el rol del socket, el selector de sucursales y la nómina.
 * Por eso `worksInAllClinics` se resuelve AQUÍ y no en cada sitio: el doctor
 * marcado como "en todas" tiene que poder abrir la agenda de la sede donde le
 * asignaron la cita, no solo salir en su desplegable.
 */
userSchema.methods.getRoleForClinic = function (clinicId) {
  if (!clinicId) return null;
  const found = this.clinics.find((c) => String(c.clinic) === String(clinicId));
  if (found) return found.role;
  // "Trabaja en todas": vale su asignación, sea cual sea la sede que se pregunte.
  return this.worksInAllClinics ? this.clinics[0]?.role || null : null;
};

/**
 * FILTRO DE MONGO para "el personal de esta sucursal con este rol".
 *
 * Es el espejo en consulta de `getRoleForClinic`, y existe para que no haya dos
 * respuestas distintas a la misma pregunta: el selector de doctores buscaba con
 * `$elemMatch` y quien estuviera marcado como "en todas" no salía, aunque el
 * middleware sí le dejara entrar a esa sede. Cámbialos juntos.
 *
 * @param {*} clinicId sucursal
 * @param {string|string[]} roles rol o roles que valen
 */
userSchema.statics.enSucursal = function (clinicId, roles) {
  const rol = Array.isArray(roles) ? { $in: roles } : roles;
  return {
    $or: [
      { clinics: { $elemMatch: { clinic: clinicId, role: rol } } },
      { worksInAllClinics: true, clinics: { $elemMatch: { role: rol } } },
    ],
  };
};

userSchema.statics.VALID_ROLES = VALID_ROLES;

module.exports = mongoose.model('User', userSchema);
