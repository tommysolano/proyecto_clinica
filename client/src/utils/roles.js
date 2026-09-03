// Expansión central de roles del frontend.
//
// Las ESPECIALIDADES son doctores especializados: cualquier permiso/vista
// concedido al rol 'doctor' también les aplica. Esto replica en el cliente la
// expansión que el backend hace en requireRole (ver server/constants/roles.js),
// para no tener que enumerar cada especialidad junto a 'doctor' en cada control.
//
// 'optica' NO está en esta lista a propósito: en el cliente siempre se enumeró
// a mano (Layout.jsx, App.jsx) porque tiene vistas propias, y meterla aquí le
// cambiaría lo que ve hoy.
export const DOCTOR_SPECIALTY_ROLES = ['ginecologia', 'podologia', 'odontologia', 'cosmetologia', 'cardiologia', 'terapeuta'];

export function roleSatisfies(userRole, allowedRoles) {
  if (!userRole || !Array.isArray(allowedRoles)) return false;
  if (allowedRoles.includes(userRole)) return true;
  if (DOCTOR_SPECIALTY_ROLES.includes(userRole) && allowedRoles.includes('doctor')) return true;
  return false;
}

// Etiqueta legible de cada rol. Fuente única para el sidebar, la agenda y los
// dashboards, que antes repetían el mismo mapa cada uno por su lado.
export const ROLE_LABELS = {
  admin: 'Administrador',
  cajero: 'Cajero',
  contabilidad: 'Contabilidad',
  doctor: 'Doctor',
  optica: 'Óptica',
  ginecologia: 'Ginecología',
  podologia: 'Podología',
  odontologia: 'Odontología',
  cosmetologia: 'Cosmetología',
  cardiologia: 'Cardiología',
  terapeuta: 'Terapeuta',
  call_center: 'Call Center',
  marketing: 'Marketing',
  enfermero: 'Enfermero/a',
};

// ─────────────── Cédula del paciente ───────────────
//
// Los datos de contacto del paciente son del administrador y el servidor los
// censura (ver CONTACT_FIELDS en patientController), con UNA excepción: la
// CÉDULA la ve también mostrador, porque identifica y factura con ella.
//
// Esta lista es el espejo de la capacidad `patients.cedula` del servidor: si se
// cambia una hay que cambiar la otra, o la pantalla pintaría un campo que no le
// van a mandar (o lo esconderá teniéndolo).
export const ROLES_VEN_CEDULA = ['admin', 'cajero'];

// ─────────────── Tipo de doctor ───────────────
//
// El TIPO de doctor sale de su ROL en la sucursal, no de un campo aparte: quien
// solo tiene el rol 'doctor' es medicina general, y los roles especializados
// ('optica', 'ginecologia', …) se llaman por su especialidad. El backend manda
// ese rol en `roleInClinic` (GET /users/doctors).
export const DOCTOR_TYPE_LABELS = {
  doctor: 'General',
  optica: 'Óptica',
  ginecologia: 'Ginecología',
  podologia: 'Podología',
  odontologia: 'Odontología',
  cosmetologia: 'Cosmetología',
  cardiologia: 'Cardiología',
  terapeuta: 'Terapeuta',
};

// Rol nuevo que todavía no esté en el mapa de arriba: 'medicina_interna' se ve
// como 'Medicina interna'. Así una especialidad futura muestra su tipo el día
// que se crea, sin esperar a que alguien toque este archivo.
const prettifyRole = (role) =>
  String(role).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Tipo del doctor para mostrar ('General', 'Óptica', …). Devuelve '' si no se
 * puede saber el rol: preferimos no poner tipo antes que poner uno equivocado.
 */
export function doctorTypeLabel(doctor) {
  const role = doctor?.roleInClinic || doctor?.role || '';
  if (!role) return '';
  return DOCTOR_TYPE_LABELS[role] || prettifyRole(role);
}

/**
 * Etiqueta completa para los selectores de doctor: «Dr. Ana Pérez — Óptica».
 * Si además tiene una especialidad escrita a mano que aporta algo distinta al
 * tipo, se agrega entre paréntesis: «Dr. Ana Pérez — General (Pediatría)».
 */
export function doctorOptionLabel(doctor) {
  if (!doctor) return '';
  const type = doctorTypeLabel(doctor);
  const specialty = (doctor.specialty || '').trim();
  const extra = specialty && specialty.toLowerCase() !== type.toLowerCase() ? ` (${specialty})` : '';
  return `Dr. ${doctor.name}${type ? ` — ${type}` : ''}${extra}`;
}
