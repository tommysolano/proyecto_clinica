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
