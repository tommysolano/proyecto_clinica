// Formateo de teléfonos para MOSTRAR. La normalización de verdad (la que decide
// la identidad del contacto) vive en el servidor: server/utils/phoneNormalize.js.
// Aquí solo se maqueta lo que ya viene en E.164 sin '+'.

/** 593999111222 → +593 99 911 1222 */
export function formatPhone(e164) {
  const s = String(e164 || '').replace(/\D/g, '');
  if (!s) return '';
  if (/^5939\d{8}$/.test(s)) {
    // Móvil ecuatoriano: +593 99 911 1222
    return `+593 ${s.slice(3, 5)} ${s.slice(5, 8)} ${s.slice(8)}`;
  }
  if (/^593\d{8}$/.test(s)) {
    // Fijo ecuatoriano: +593 4 291 1222
    return `+593 ${s.slice(3, 4)} ${s.slice(4, 7)} ${s.slice(7)}`;
  }
  return `+${s}`;
}

/** Nombre a mostrar de un contacto: lo que haya, y si no el teléfono. */
export function contactName(c) {
  if (!c) return '';
  const full = `${c.firstName || ''} ${c.lastName || ''}`.trim();
  return full || c.displayName || formatPhone(c.phone);
}
