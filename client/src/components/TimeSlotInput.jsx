import { useMemo } from 'react';
import { slotTimesOfDay } from '../utils/slots';

/**
 * Hora de una cita, respetando los ESPACIOS de la sucursal.
 *
 * Sin espacios configurados (`slotMinutes = 0`) es el mismo `<input type="time">`
 * de siempre. Con espacios se convierte en una lista: 14:00, 14:20, 14:40… Así
 * la agenda se puede leer de un vistazo y repartir, en vez de tener citas que
 * empiezan a las 18:37 porque alguien tecleó de más.
 *
 * `min` funciona igual que en el input nativo: las horas anteriores se
 * descartan de la lista (es lo que impide agendar a una hora de hoy que ya pasó).
 *
 * `value` fuera de la rejilla NO se borra: una cita agendada antes de encender
 * los espacios se sigue viendo y se puede editar sin moverle la hora. Se añade
 * como opción marcada para que el desplegable no aparezca vacío.
 */
export default function TimeSlotInput({
  value = '',
  onChange,
  name,
  slotMinutes = 0,
  min,
  required = false,
  disabled = false,
  className = '',
  ...rest
}) {
  const paso = Number(slotMinutes) || 0;

  const opciones = useMemo(() => {
    if (paso <= 0) return [];
    const base = slotTimesOfDay(paso).filter((t) => !min || t >= min);
    // La hora que ya tenía la cita, aunque no caiga en la rejilla ni pase el
    // `min`: sin ella el select se vería en blanco y guardar la movería sola.
    if (value && !base.includes(value)) return [value, ...base];
    return base;
  }, [paso, min, value]);

  if (paso <= 0) {
    return (
      <input
        {...rest}
        name={name}
        type="time"
        value={value}
        min={min}
        required={required}
        disabled={disabled}
        onChange={onChange}
        className={className}
      />
    );
  }

  return (
    <select
      {...rest}
      name={name}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(e) =>
        onChange?.({
          target: { name, value: e.target.value },
          currentTarget: { name, value: e.target.value },
        })
      }
      className={className}
    >
      <option value="">Hora…</option>
      {opciones.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}
