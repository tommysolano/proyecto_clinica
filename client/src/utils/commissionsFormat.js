import { fmtDate } from './date';
import { doctorTypeLabel } from './roles';

export const money = (v) => `$${Number(v || 0).toFixed(2)}`;

/**
 * Rol(es) del doctor para mostrar: «General», «Ginecología», o varios si en cada
 * sucursal tiene uno distinto. Con la especialidad escrita a mano cuando añade
 * algo al rol.
 */
export const doctorRolesLabel = (d) => {
  const roles = (d?.roles?.length ? d.roles : [d?.roleInClinic].filter(Boolean))
    .map((role) => doctorTypeLabel({ roleInClinic: role }))
    .filter(Boolean);
  const specialty = (d?.specialty || '').trim();
  const extra = specialty && !roles.some((r) => r.toLowerCase() === specialty.toLowerCase()) ? specialty : '';
  return [roles.join(' · '), extra].filter(Boolean).join(' — ');
};

/**
 * Opción del buscador de doctores (ProductAutocomplete): el rol va como
 * «categoría», así se ve debajo del nombre y también se puede buscar por él
 * (escribir «gineco» encuentra a las ginecólogas).
 */
export const doctorSearchOption = (d) => ({
  ...d,
  category: `${doctorRolesLabel(d) || 'Sin rol'}${d.active === false ? ' · inactivo' : ''}`,
});

export const DERIVACION_ESTADOS = {
  realizada: { label: 'Realizada', cls: 'bg-emerald-100 text-emerald-700' },
  agendada: { label: 'Agendada, aún no se realiza', cls: 'bg-blue-100 text-blue-700' },
  sin_agendar: { label: 'No realizada (sin agendar)', cls: 'bg-amber-100 text-amber-700' },
  no_asistio: { label: 'No realizada (no asistió)', cls: 'bg-orange-100 text-orange-700' },
  cancelada: { label: 'No realizada (cancelada)', cls: 'bg-red-100 text-red-600' },
};

export const STATUS_OPTIONS = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'confirmada', label: 'Confirmada' },
  { value: 'asistida', label: 'Asistida' },
  { value: 'no_asistio', label: 'No asistió' },
  { value: 'cancelada', label: 'Cancelada' },
  { value: 'completada', label: 'Completada' },
];

export const STATUS_COLORS = {
  pendiente: 'bg-slate-100 text-slate-700',
  confirmada: 'bg-blue-100 text-blue-700',
  asistida: 'bg-emerald-100 text-emerald-700',
  no_asistio: 'bg-amber-100 text-amber-700',
  cancelada: 'bg-red-100 text-red-700',
  completada: 'bg-teal-100 text-teal-700',
};

export const statusLabel = (s) =>
  STATUS_OPTIONS.find((o) => o.value === s)?.label || s;

export const fmtAtendientes = (a) =>
  (a.atendientes || [])
    .map((t) => `${t.name}${t.kind === 'enfermeria' ? ' (enfermería)' : ''}`)
    .join(' → ');

export const fmtPago = (a) => {
  if (a.payment?.isCanje) return 'Canje';
  const partes = [];
  if (a.payment?.agreedValue != null) partes.push(`$${Number(a.payment.agreedValue).toFixed(2)}`);
  const monto = Number(a.payment?.advanceAmount || 0).toFixed(2);
  const metodo = a.payment?.advanceMethod ? ` (${a.payment.advanceMethod})` : '';
  if (a.payment?.advancePayment === 'abono') partes.push(`abono $${monto}${metodo}`);
  else if (a.payment?.advancePayment === 'total') partes.push(`pagada por adelantado $${monto}${metodo}`);
  if (a.venta) {
    const numero = a.venta.number ? `${a.venta.number} · ` : '';
    partes.push(`Venta ${numero}${fmtDate(a.venta.date)}`);
  }
  return partes.length ? partes.join(' · ') : 'Sin valor registrado';
};
