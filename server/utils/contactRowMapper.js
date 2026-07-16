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
  { value: 'tags', label: 'Etiquetas (separadas por coma)' },
  { value: 'notes', label: 'Notas' },
];

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
  [/^(first ?name|nombres?|given)/i, 'firstName'],
  [/^(last ?name|apellidos?|surname)/i, 'lastName'],
  [/^(full ?name|nombre completo|contact name|nombre de contacto|name)$/i, 'displayName'],
  [/^(e-?mail|correo)/i, 'email'],
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

module.exports = { mapRow, suggestMapping, guessField, splitFullName, FIELD_OPTIONS, CORE_FIELDS };
