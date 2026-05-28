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

/**
 * dd/mm/aaaa hh:mm
 */
export function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mo}/${yyyy} ${hh}:${mm}`;
}
