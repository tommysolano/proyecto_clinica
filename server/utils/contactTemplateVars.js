/**
 * Variables de una plantilla de Meta rellenadas con los datos de un CONTACTO.
 *
 * Por qué existe: `utils/messaging.js` ya sabe completar las variables que faltan,
 * pero las resuelve desde el PACIENTE (`buildKnownVariableResolver`). Un contacto
 * importado no tiene paciente, así que ahí no había nada que resolver y cada
 * variable acababa cayendo en el último recurso: el EJEMPLO documentado de la
 * plantilla. Es decir, si la variable {{nombre}} tenía de ejemplo "María", los
 * 800 contactos de la campaña recibían "Hola María". Peor que un hueco vacío,
 * porque parece correcto y no falla.
 *
 * Aquí las variables se resuelven contra el contacto y, para lo que el sistema no
 * puede saber (un código de promoción), el usuario elige la fuente al crear la
 * campaña. Es una función PURA: sin BD, para poder probar los casos raros.
 */

/**
 * Claves de la plantilla en ORDEN DE APARICIÓN en el cuerpo, sin repetir.
 * Mismo criterio que messaging.enrichTemplateHeader: es lo que hace que el orden
 * de los parámetros cuadre con lo que Meta espera (si no: error #132000).
 */
function templateKeys(tpl) {
  const keys = [];
  for (const m of String(tpl?.body || '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

const FULL_OF = (c) =>
  `${c?.firstName || ''} ${c?.lastName || ''}`.trim() || String(c?.displayName || '').trim();

const FIRST_OF = (c) =>
  String(c?.firstName || '').trim() || String(c?.displayName || '').trim().split(' ')[0] || '';

/** Fuentes que la UI ofrece para cada variable de la plantilla. */
const VAR_SOURCES = [
  { value: 'nombre', label: 'Nombre del contacto' },
  { value: 'nombre_completo', label: 'Nombre completo' },
  { value: 'apellido', label: 'Apellidos' },
  { value: 'telefono', label: 'Teléfono' },
  { value: 'fixed', label: 'Texto fijo (igual para todos)' },
];

/** Lee un campo personalizado del contacto (viene como Map o como objeto plano). */
function customField(contact, key) {
  const cf = contact?.customFields;
  if (!cf) return '';
  if (typeof cf.get === 'function') return String(cf.get(key) ?? '').trim();
  return String(cf[key] ?? '').trim();
}

/** Valor de una variable para un contacto, según la fuente elegida. */
function resolveContactVar(source, contact, fixed = '') {
  const s = String(source || '');
  if (s === 'fixed') return String(fixed || '').trim();
  if (s.startsWith('custom:')) return customField(contact, s.slice('custom:'.length));
  if (s === 'nombre') return FIRST_OF(contact);
  if (s === 'nombre_completo') return FULL_OF(contact);
  if (s === 'apellido') return String(contact?.lastName || '').trim();
  if (s === 'telefono') return String(contact?.phone || '').trim();
  return '';
}

/**
 * Adivina la fuente de una variable por su NOMBRE, para no obligar a mapear a
 * mano lo evidente. Devuelve '' si no la reconoce: esas las decide el usuario.
 */
function guessSource(key) {
  const k = String(key || '').trim().toLowerCase();
  if (/^(nombre|nombres|firstname|name|1)$/.test(k)) return 'nombre';
  if (/^(apellido|apellidos|lastname)$/.test(k)) return 'apellido';
  if (/^(nombre_?completo|fullname)$/.test(k)) return 'nombre_completo';
  if (/^(telefono|tel[eé]fono|phone|celular|whatsapp)$/.test(k)) return 'telefono';
  return '';
}

/** Mapeo propuesto para una plantilla: [{ key, source, fixed }]. */
function suggestVarMapping(tpl) {
  return templateKeys(tpl).map((key) => ({ key, source: guessSource(key), fixed: '' }));
}

/**
 * Valores finales, EN EL ORDEN de las claves de la plantilla.
 *
 * Nunca devuelve una cadena vacía: Meta rechaza los parámetros vacíos, así que
 * cae a '-'. Es visible y raro, pero no rompe el envío ni miente con el ejemplo.
 *
 * @param {object} tpl      plantilla con { body, variables }
 * @param {object} contact  contacto
 * @param {Array}  mapping  [{ key, source, fixed }] elegido en la campaña
 */
function buildContactTemplateVars(tpl, contact, mapping = []) {
  const keys = templateKeys(tpl);
  if (!keys.length) return [];
  const byKey = new Map((mapping || []).map((m) => [String(m.key), m]));
  return keys.map((key) => {
    const m = byKey.get(key);
    const source = m?.source || guessSource(key);
    const value = resolveContactVar(source, contact, m?.fixed);
    return value || '-';
  });
}

module.exports = {
  templateKeys,
  resolveContactVar,
  guessSource,
  suggestVarMapping,
  buildContactTemplateVars,
  VAR_SOURCES,
};
