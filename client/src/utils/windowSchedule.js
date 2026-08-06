/**
 * Días y texto de las VENTANAS HORARIAS de las automatizaciones (la "Time
 * Window" de GoHighLevel / las "ventanas" de Daplox). Espejo en el servidor:
 * server/utils/sendWindow.js — si cambia el formato, cámbialos juntos.
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

/** Texto legible de una ventana ("Lun, Mar, Mié · 09:00–18:00"). */
export function describeWindow({ days = [], from = '', to = '' } = {}) {
  const list = DAY_CHIPS.filter((d) => days.includes(d.value));
  if (!list.length || !from || !to) return 'sin configurar';
  const label = list.length === 7 ? 'Todos los días' : list.map((d) => d.label).join(', ');
  return `${label} · ${from}–${to}`;
}
