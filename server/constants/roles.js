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
];

/** Las especialidades, sin el rol base. Es lo que expande `requireRole('doctor')`. */
const DOCTOR_SPECIALTY_ROLES = DOCTOR_LIKE_ROLES.filter((r) => r !== DOCTOR_ROLE);

/** ¿Este rol atiende pacientes (es doctor o una de sus especialidades)? */
const isDoctorRole = (role) => DOCTOR_LIKE_ROLES.includes(role);

/** Todos los roles asignables a un usuario dentro de una sucursal. */
const VALID_ROLES = [
  'admin',
  'cajero',
  'contabilidad',
  ...DOCTOR_LIKE_ROLES,
  'call_center',
  'marketing',
  'enfermero',
];

module.exports = {
  DOCTOR_ROLE,
  DOCTOR_LIKE_ROLES,
  DOCTOR_SPECIALTY_ROLES,
  isDoctorRole,
  VALID_ROLES,
};
