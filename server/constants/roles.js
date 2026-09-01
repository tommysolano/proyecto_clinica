/**
 * Roles del sistema. FUENTE ÚNICA: cualquier lista de roles (modelo User,
 * validación del controlador, expansión de requireRole…) sale de aquí.
 *
 * Roles ESPECIALIZADOS de doctor: 'optica', 'ginecologia', 'podologia',
 * 'odontologia' y 'cosmetologia' son funcionalmente doctores. Todo lo que se
 * concede al rol 'doctor' se les concede también; lo único propio de cada uno
 * es la sección de su especialidad dentro del seguimiento (ver
 * constants/specialtyCatalogs.js). Para agregar una especialidad nueva basta
 * con sumarla a DOCTOR_LIKE_ROLES: requireRole, el listado de doctores, las
 * comisiones y los dashboards la heredan solos.
 */

/** El rol base de doctor. */
const DOCTOR_ROLE = 'doctor';

/** Roles que funcionalmente son doctores (incluye el base). */
const DOCTOR_LIKE_ROLES = [
  DOCTOR_ROLE,
  'optica',
  'ginecologia',
  'podologia',
  'odontologia',
  'cosmetologia',
  'cardiologia',
  // El terapeuta es doctor a efectos de permisos, pero su consulta y su ficha son
  // propias y PRIVADAS: solo las ve el y la administracion (ver hideTherapyNotes).
  'terapeuta',
];

/** Las especialidades, sin el rol base. Es lo que expande `requireRole('doctor')`. */
const DOCTOR_SPECIALTY_ROLES = DOCTOR_LIKE_ROLES.filter((r) => r !== DOCTOR_ROLE);

/** ¿Este rol es médico (el rol base o una de sus especialidades)? */
const isDoctorRole = (role) => DOCTOR_LIKE_ROLES.includes(role);

/** El rol de enfermería. */
const NURSE_ROLE = 'enfermero';

/**
 * ¿Este rol ATIENDE al paciente en persona?
 *
 * Es más ancho que `isDoctorRole`: enfermería atiende (pone el suero, hace la
 * curación) pero NO es médico — no cobra comisión de doctor, no sale en el
 * listado de doctores y no se le asigna una cita como tal. Cuando la pregunta
 * es «¿esta persona está delante del paciente ahora?», se usa esto; cuando es
 * «¿es un médico?», se usa `isDoctorRole`.
 *
 * Meter 'enfermero' en DOCTOR_LIKE_ROLES habría contestado que sí a esta
 * pregunta, y de paso a otras veinte que nadie hizo.
 */
const atiendePacientes = (role) => isDoctorRole(role) || role === NURSE_ROLE;

/** Todos los roles asignables a un usuario dentro de una sucursal. */
const VALID_ROLES = [
  'admin',
  'cajero',
  'contabilidad',
  ...DOCTOR_LIKE_ROLES,
  'call_center',
  'marketing',
  NURSE_ROLE,
];

module.exports = {
  DOCTOR_ROLE,
  DOCTOR_LIKE_ROLES,
  DOCTOR_SPECIALTY_ROLES,
  isDoctorRole,
  NURSE_ROLE,
  atiendePacientes,
  VALID_ROLES,
};
