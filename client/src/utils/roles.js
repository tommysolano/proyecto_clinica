// Expansión central de roles del frontend.
//
// 'ginecologia' es un doctor especializado: cualquier permiso/vista concedido al
// rol 'doctor' también aplica a 'ginecologia'. Esto replica en el cliente la
// expansión que el backend hace en requireRole (doctor → optica/ginecologia),
// para no tener que enumerar 'ginecologia' junto a 'doctor' en cada control.
export function roleSatisfies(userRole, allowedRoles) {
  if (!userRole || !Array.isArray(allowedRoles)) return false;
  if (allowedRoles.includes(userRole)) return true;
  if (userRole === 'ginecologia' && allowedRoles.includes('doctor')) return true;
  return false;
}

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
