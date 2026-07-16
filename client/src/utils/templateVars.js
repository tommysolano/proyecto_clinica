// Variables de una plantilla de Meta, para el formulario del goteo.
// Espejo de server/utils/contactTemplateVars.js: la verdad la tiene el servidor
// (es quien arma los parámetros del envío); esto solo pinta el formulario.

/** Claves de la plantilla en orden de aparición, sin repetir. */
export function templateKeys(tpl) {
  const keys = [];
  for (const m of String(tpl?.body || '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/** Fuentes que puede tener una variable. */
export const VAR_SOURCES = [
  { value: 'nombre', label: 'Nombre del contacto' },
  { value: 'nombre_completo', label: 'Nombre completo' },
  { value: 'apellido', label: 'Apellidos' },
  { value: 'telefono', label: 'Teléfono' },
  { value: 'fixed', label: 'Texto fijo (igual para todos)' },
];

/** Adivina la fuente por el nombre de la variable; '' si no la reconoce. */
export function guessSource(key) {
  const k = String(key || '').trim().toLowerCase();
  if (/^(nombre|nombres|firstname|name|1)$/.test(k)) return 'nombre';
  if (/^(apellido|apellidos|lastname)$/.test(k)) return 'apellido';
  if (/^(nombre_?completo|fullname)$/.test(k)) return 'nombre_completo';
  if (/^(telefono|tel[eé]fono|phone|celular|whatsapp)$/.test(k)) return 'telefono';
  return '';
}

export function suggestVarMapping(tpl) {
  return templateKeys(tpl).map((key) => ({ key, source: guessSource(key), fixed: '' }));
}

/** Vista previa del mensaje con las variables resueltas para un contacto de ejemplo. */
export function previewBody(tpl, mapping, sample) {
  const byKey = new Map((mapping || []).map((m) => [m.key, m]));
  return String(tpl?.body || '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key) => {
    const m = byKey.get(key);
    const src = m?.source || guessSource(key);
    if (src === 'fixed') return m?.fixed || '—';
    if (src === 'nombre') return sample.firstName;
    if (src === 'nombre_completo') return `${sample.firstName} ${sample.lastName}`;
    if (src === 'apellido') return sample.lastName;
    if (src === 'telefono') return sample.phone;
    if (src?.startsWith('custom:')) return `(${src.slice(7)})`;
    return '-'; // sin fuente: es lo que recibirían todos
  });
}
