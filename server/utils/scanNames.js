/**
 * Nombres de los documentos del escáner (/scanner).
 *
 * Vive aparte del controlador porque el importador de fichas escaneadas
 * (scripts/importPatientsFromScans.js) tiene que emparejar por nombre los PDF
 * que se descargaron en un ZIP con su ficha en la base. Si cada lado normalizara
 * a su manera, un acento o un espacio de más bastaría para no encontrar el
 * documento — y el paciente se quedaría sin importar sin motivo aparente.
 */
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Clave de comparación: sin tildes, sin mayúsculas, sin espacios de más. */
const nameKeyOf = (s) => String(s || '')
  .normalize('NFD').replace(DIACRITICS, '')
  .toLowerCase().trim().replace(/\s+/g, ' ');

/** Quita lo que no puede ir en un nombre de archivo y recorta el largo. */
const sanitizeName = (s) => String(s || '')
  .replace(/\.pdf$/i, '')
  .replace(/[\\/:*?"<>|]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120);

/** Nombre por defecto: "Escaneo 10-08-2026". */
function defaultName(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `Escaneo ${dd}-${mm}-${date.getFullYear()}`;
}

module.exports = { nameKeyOf, sanitizeName, defaultName };
