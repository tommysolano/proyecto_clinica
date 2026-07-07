/**
 * Formato de fechas estándar de la app: dd/mm/aaaa.
 * Acepta strings ISO, Date, o null.
 */
export function fmtDate(value) {
  if (!value) return '';
  // Si viene como YYYY-MM-DD (o YYYY-MM-DDTHH:..) lo parseamos sin shift de zona horaria.
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${d}/${mo}/${y}`;
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mo}/${yyyy}`;
}

// Zona horaria de Ecuador: los horarios se muestran SIEMPRE en hora de Ecuador,
// sin importar la zona del navegador del usuario.
const EC_TZ = 'America/Guayaquil';

/**
 * dd/mm/aaaa hh:mm — SIEMPRE en hora de Ecuador (Guayaquil).
 * Pensado para timestamps (createdAt, fechaAutorizacion, etc.), no fechas-solo.
 */
export function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('es-EC', {
    timeZone: EC_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(d)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  // Algunos navegadores devuelven '24' a medianoche con hour12:false.
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.day}/${p.month}/${p.year} ${hh}:${p.minute}`;
}
