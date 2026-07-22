/**
 * Traduce una fila del archivo a los campos de un Contacto, aplicando el mapeo
 * que el usuario definió en el paso "Asignar".
 *
 * Es una función PURA (sin BD) a propósito: es la lógica con más casos raros de
 * toda la importación (nombres partidos o no, teléfonos en cualquier formato,
 * columnas vacías, campos personalizados) y así se puede probar de verdad.
 *
 * Campos destino admitidos en `mapping[].field`:
 *   phone · email · firstName · lastName · displayName · notes
 *   clinic          → nombre de la SUCURSAL del contacto (el runner lo resuelve a
 *                     la sede y ubica el contacto ahí; permite bifurcar el flujo)
 *   tags            → separa por coma/;/| y las suma a las del lote
 *   custom:<clave>  → va a Contact.customFields
 *   ''              → columna ignorada
 */
const { normalizePhone } = require('./phoneNormalize');

const CORE_FIELDS = ['phone', 'email', 'firstName', 'lastName', 'displayName', 'notes'];

/** Campos que la UI ofrece en el desplegable de "Campo". */
const FIELD_OPTIONS = [
  { value: 'phone', label: 'Teléfono (WhatsApp)', required: true },
  { value: 'firstName', label: 'Nombres' },
  { value: 'lastName', label: 'Apellidos' },
  { value: 'displayName', label: 'Nombre completo / como aparece en WhatsApp' },
  { value: 'email', label: 'Correo electrónico' },
  { value: 'clinic', label: 'Sucursal (nombre de la sede)' },
  { value: 'sendTime', label: 'Hora de envío del 1er mensaje (HH:MM)' },
  { value: 'tags', label: 'Etiquetas (separadas por coma)' },
  { value: 'notes', label: 'Notas' },
];

/**
 * Normaliza la HORA de envío de una celda a "HH:MM" (24h) o '' si no es una hora.
 *
 * Tolera lo que llega de un Excel/CSV real:
 *   "8:00", "14:30", "8", "8 am", "2:30 pm"  → texto que el usuario escribió
 *   "0.3333333"                              → fracción de día de Excel (8:00). Es la
 *                                              causa de los "demasiados decimales": una
 *                                              celda con formato hora exportada como número.
 *   "1899-12-31T08:00:00.000Z" / "... 08:00" → celda-fecha ya formateada por el lector
 */
function parseSendTime(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  // "HH:MM" con am/pm opcional (dentro de un texto o de una fecha con hora).
  let m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ap = (m[3] || '').toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    if (h <= 23 && min <= 59) return hhmm(h, min);
    return '';
  }

  // Hora entera suelta: "8", "8am", "8 pm".
  m = s.match(/^(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = (m[2] || '').toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    if (h <= 23) return hhmm(h, 0);
    return '';
  }

  // Fracción de día de Excel (0 < x < 1 = hora del día; un serial completo 45000.58
  // también trae su parte fraccional). Acepta coma o punto decimal.
  const num = Number(s.replace(',', '.'));
  if (Number.isFinite(num) && num > 0 && num < 100000) {
    const frac = num - Math.floor(num);
    if (frac > 0 || num < 1) {
      const total = Math.round(frac * 24 * 60);
      return hhmm(Math.floor(total / 60) % 24, total % 60);
    }
  }
  return '';
}

const splitTags = (v) =>
  String(v || '')
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Parte un nombre completo en nombres y apellidos. Regla simple y predecible: la
 * primera palabra es el nombre y el resto el apellido. No se intenta ser listo
 * con "de la Cruz": el nombre original se conserva en `displayName`, así que no
 * se pierde nada y el agente siempre ve lo que venía en el archivo.
 */
function splitFullName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * @param {object} row     fila { cabecera: valor }
 * @param {Array}  mapping [{ column, field, skipEmpty }]
 * @returns {{ ok: boolean, contact?: object, reason?: string, value?: string }}
 */
function mapRow(row, mapping) {
  const out = { tags: [], customFields: {} };
  let rawPhone = '';

  for (const m of mapping || []) {
    if (!m.field) continue; // columna no asignada
    const value = String(row[m.column] ?? '').trim();
    // "Omita los valores vacíos": no pisar un dato bueno con una celda vacía.
    if (!value && m.skipEmpty !== false) continue;

    if (m.field === 'phone') { rawPhone = value; continue; }
    // La sucursal viene como NOMBRE en el Excel; el runner la resuelve a la sede
    // real (no es un campo directo del contacto). Se guarda aparte para no escribir
    // "clinicName" como si fuera un campo del documento.
    if (m.field === 'clinic') { if (value) out.clinicName = value; continue; }
    // La hora de envío NO es un campo del contacto: el runner la usa para programar
    // el arranque del workflow (nextRunAt) de ESE contacto. Se guarda aparte.
    if (m.field === 'sendTime') { const t = parseSendTime(value); if (t) out.sendTime = t; continue; }
    if (m.field === 'tags') { out.tags.push(...splitTags(value)); continue; }
    if (m.field.startsWith('custom:')) {
      const key = m.field.slice('custom:'.length).trim();
      if (key) out.customFields[key] = value;
      continue;
    }
    if (CORE_FIELDS.includes(m.field)) out[m.field] = value;
  }

  // El teléfono es la identidad del contacto: sin él no hay nada que importar.
  if (!rawPhone) return { ok: false, reason: 'sin teléfono' };
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) return { ok: false, reason: phone.reason, value: rawPhone };
  out.phone = phone.phone;

  // Si vino un nombre completo y no columnas separadas, se parte; y al revés, si
  // vinieron separadas se compone el displayName. El objetivo es que la lista
  // siempre enseñe algo legible.
  if (out.displayName && !out.firstName && !out.lastName) {
    Object.assign(out, splitFullName(out.displayName));
  } else if (!out.displayName && (out.firstName || out.lastName)) {
    out.displayName = `${out.firstName || ''} ${out.lastName || ''}`.trim();
  }

  return { ok: true, contact: out };
}

/**
 * Sugiere el campo destino de cada columna por su título, para que el usuario no
 * tenga que mapear 12 columnas a mano. Es solo una propuesta: manda lo que él
 * elija en el paso "Asignar".
 */
const GUESSES = [
  [/^(phone|tel[eé]fono|celular|m[oó]vil|movil|whatsapp|numero|n[uú]mero|contact number)/i, 'phone'],
  // "Nombre completo" va ANTES que "Nombres" y es de coincidencia exacta ($): la
  // regla de firstName no está anclada, así que "Nombre completo" —que empieza por
  // "Nombre"— la ganaba y el nombre entero acababa en firstName. Resultado: la
  // plantilla saludaba "Hola María José Pérez Gómez" y {{apellido}} salía vacío.
  [/^(full ?name|nombre[ _]?completo|contact name|nombre de contacto|name)$/i, 'displayName'],
  [/^(first ?name|nombres?|given)/i, 'firstName'],
  [/^(last ?name|apellidos?|surname)/i, 'lastName'],
  [/^(e-?mail|correo)/i, 'email'],
  [/^(sucursal|sede|clinica|clínica|branch|location|local)/i, 'clinic'],
  [/^(hora|horario|hora ?de ?env[ií]o|send ?time|schedule)/i, 'sendTime'],
  [/^(tags?|etiquetas?)/i, 'tags'],
  [/^(notes?|notas|observaciones)/i, 'notes'],
];

function guessField(column) {
  const c = String(column || '').trim();
  for (const [re, field] of GUESSES) if (re.test(c)) return field;
  return '';
}

/** Mapeo propuesto para unas cabeceras, sin repetir campo (el 1º que encaja gana). */
function suggestMapping(headers) {
  const used = new Set();
  return (headers || []).map((column) => {
    let field = guessField(column);
    if (field && used.has(field)) field = ''; // dos columnas al mismo campo se pisarían
    if (field) used.add(field);
    return { column, field, skipEmpty: true };
  });
}

module.exports = { mapRow, suggestMapping, guessField, splitFullName, parseSendTime, FIELD_OPTIONS, CORE_FIELDS };
