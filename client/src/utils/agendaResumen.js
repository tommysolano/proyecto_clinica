/**
 * Estados de la cita en el resumen de la agenda (oct-2026), en el orden en que
 * se muestran: [clave, rótulo, color del número, fondo de la tarjeta].
 */
export const ESTADOS_RESUMEN = [
  ['pendiente', 'Pendientes', 'text-amber-700', 'bg-amber-50 border-amber-100'],
  ['confirmada', 'Confirmadas', 'text-sky-700', 'bg-sky-50 border-sky-100'],
  ['asistida', 'Asistidas', 'text-emerald-700', 'bg-emerald-50 border-emerald-100'],
  ['completada', 'Completadas', 'text-teal-700', 'bg-teal-50 border-teal-100'],
  ['no_asistio', 'No asistió', 'text-rose-700', 'bg-rose-50 border-rose-100'],
  ['cancelada', 'Canceladas', 'text-slate-600', 'bg-slate-50 border-slate-200'],
];

export const estadosVacios = () => Object.fromEntries(ESTADOS_RESUMEN.map(([k]) => [k, 0]));
