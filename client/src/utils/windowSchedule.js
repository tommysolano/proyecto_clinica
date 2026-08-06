/**
 * Días y texto de las VENTANAS HORARIAS de las automatizaciones. La franja
 * configurada es la de SILENCIO: dentro de ella el flujo NO molesta al contacto.
 * Espejo en el servidor: server/utils/sendWindow.js — si cambia el formato o el
 * significado, cámbialos juntos.
 *
 * Formato: { days:[0..6], from:'HH:MM', to:'HH:MM' }, con 0 = domingo.
 */
export const DAY_CHIPS = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
];

/** Texto legible de una ventana ("Silencio Lun, Mar, Mié · 23:00–06:20"). */
export function describeWindow({ days = [], from = '', to = '' } = {}) {
  const list = DAY_CHIPS.filter((d) => days.includes(d.value));
  if (!list.length || !from || !to) return 'sin configurar';
  const label = list.length === 7 ? 'todos los días' : list.map((d) => d.label).join(', ');
  return `Silencio ${label} · ${from}–${to}`;
}

/** ¿El silencio cubre las 24 h de los 7 días? Configuración imposible de cumplir. */
export function isAlwaysQuiet({ days = [], from = '', to = '' } = {}) {
  return days.length === 7 && !!from && from === to;
}
