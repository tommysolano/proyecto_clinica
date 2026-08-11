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
 * 'dd/mm/aaaa' -> ISO 'YYYY-MM-DD'. Devuelve null si no es una fecha real
 * (31/02, mes 13, año incompleto). Es la inversa de fmtDate y la usa el
 * componente DateInput para leer lo que se escribe a mano.
 */
export function parseDdMmYyyy(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = Number(dd);
  const mo = Number(mm);
  const y = Number(yyyy);
  if (mo < 1 || mo > 12 || d < 1 || y < 1900) return null;
  // Rechaza 31/02: si el día se desborda, Date lo mueve al mes siguiente.
  const probe = new Date(y, mo - 1, d);
  if (probe.getDate() !== d || probe.getMonth() !== mo - 1) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** Va metiendo las barras mientras se escribe una fecha: 2512 -> 25/12. */
export function maskDdMmYyyy(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length > 4) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  if (digits.length > 2) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return digits;
}

// Zona horaria de Ecuador: los horarios se muestran SIEMPRE en hora de Ecuador,
// sin importar la zona del navegador del usuario.
const EC_TZ = 'America/Guayaquil';

/**
 * Fecha de HOY en Ecuador como 'YYYY-MM-DD'. Robusto cerca de medianoche (no
 * usa toISOString, que es UTC y adelantaría el día por la noche en Ecuador).
 * Se usa como `min` de los inputs de fecha para bloquear días anteriores a hoy.
 */
export function todayEc() {
  // 'en-CA' formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: EC_TZ }).format(new Date());
}

/**
 * Hora actual en Ecuador como 'HH:MM' (24h). Se usa como `min` de los inputs
 * de hora cuando la fecha elegida es HOY (no se agenda en una hora que ya pasó).
 */
export function nowEcHHMM() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: EC_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

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
