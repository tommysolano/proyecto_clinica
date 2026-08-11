import DateInput from './DateInput';

/**
 * Fecha + hora en formato dd/mm/aaaa hh:mm, reemplazo de
 * <input type="datetime-local"> (que también se pinta en formato del navegador).
 *
 * Hacia afuera habla el mismo valor que el nativo: 'YYYY-MM-DDTHH:mm'.
 */
export default function DateTimeInput({
  value = '',
  onChange,
  name,
  min,
  className = '',
  disabled = false,
  ...rest
}) {
  const [datePart = '', timePart = ''] = String(value || '').split('T');
  const [minDate] = String(min || '').split('T');

  const emit = (nextDate, nextTime) => {
    if (!onChange) return;
    // Sin fecha no hay valor; sin hora asumimos el arranque del día, igual que
    // hace el input nativo cuando solo se completa la fecha.
    const next = nextDate ? `${nextDate}T${nextTime || '00:00'}` : '';
    onChange({ target: { name, value: next }, currentTarget: { name, value: next } });
  };

  return (
    <span className="inline-flex gap-2 w-full">
      <DateInput
        {...rest}
        name={name}
        value={datePart}
        min={minDate || undefined}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, timePart)}
        className={className}
      />
      <input
        type="time"
        value={timePart}
        disabled={disabled}
        onChange={(e) => emit(datePart, e.target.value)}
        className={className}
        aria-label="Hora"
      />
    </span>
  );
}
