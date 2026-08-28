/**
 * Espejo en el cliente de los helpers de rejilla de `server/utils/appointmentDate.js`.
 * Si cambias uno, cambia el otro: el servidor RECHAZA las horas que no caen en la
 * rejilla, así que una lista distinta en pantalla se traduce en un 400 al guardar.
 */

/** Las horas válidas de un día con esa rejilla: ['00:00','00:20',…]. */
export const slotTimesOfDay = (slotMinutes) => {
  const paso = Number(slotMinutes) || 0;
  if (paso <= 0) return [];
  const out = [];
  for (let t = 0; t < 24 * 60; t += paso) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
};

/**
 * ¿Esa hora cae en la rejilla? Sin rejilla (0) todo vale, que es el
 * comportamiento de siempre.
 */
export const isValidSlotTime = (startTime, slotMinutes) => {
  const paso = Number(slotMinutes) || 0;
  if (paso <= 0) return true;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTime || ''));
  if (!m) return true;
  return (Number(m[1]) * 60 + Number(m[2])) % paso === 0;
};

/**
 * Acerca una hora suelta a la rejilla, hacia ARRIBA.
 *
 * Se usa al abrir el formulario con una hora que ya venía puesta (la actual, o
 * la de una cita vieja agendada antes de encender los espacios): si no cae en la
 * rejilla, el desplegable no tendría ninguna opción seleccionada y parecería
 * vacío. Hacia arriba y no hacia abajo para no proponer un hueco que ya pasó.
 */
export const snapToSlot = (startTime, slotMinutes) => {
  const paso = Number(slotMinutes) || 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTime || ''));
  if (paso <= 0 || !m) return startTime || '';
  const min = Number(m[1]) * 60 + Number(m[2]);
  const arriba = Math.ceil(min / paso) * paso;
  // Pasada la medianoche no hay hueco: se deja el último del día.
  const t = arriba >= 24 * 60 ? Math.floor((24 * 60 - 1) / paso) * paso : arriba;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
