import { useState } from 'react';

/**
 * Input numérico que reemplaza a los inputs de tipo "number". Renderiza un input
 * de texto (sin las flechitas ni el cambio por scroll) que SOLO permite escribir
 * números enteros o decimales. Acepta coma o punto como separador decimal (la
 * coma se normaliza a punto).
 *
 * Es un "drop-in": usa las mismas props que el input original (value, onChange,
 * className, placeholder, required, disabled…). Al teclear, sanitiza el valor y
 * llama a tu onChange con el evento ya limpio, de modo que `e.target.value` y
 * `+e.target.value` siguen funcionando igual que antes.
 *
 * Mientras el campo está enfocado usa un buffer interno, para que se puedan
 * escribir decimales (ej. "12.5") aunque el padre guarde el valor como número y
 * el re-render lo redondee. Al perder el foco vuelve a reflejar el valor del padre.
 *
 * Props extra: allowNegative (default false), allowDecimal (default true).
 */
const toStr = (v) => (v === undefined || v === null ? '' : String(v));

export default function NumericInput({
  value, onChange, onFocus, onBlur,
  allowNegative = false, allowDecimal = true, ...rest
}) {
  // buffer === null → no se está editando: se muestra el valor del padre.
  const [buffer, setBuffer] = useState(null);
  const display = buffer !== null ? buffer : toStr(value);

  const sanitize = (raw) => {
    let v = String(raw).replace(/,/g, '.');
    v = v.replace(allowNegative ? /[^0-9.-]/g : /[^0-9.]/g, '');
    if (!allowDecimal) v = v.replace(/\./g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    if (allowNegative) {
      const neg = v.startsWith('-');
      v = (neg ? '-' : '') + v.replace(/-/g, '');
    }
    return v;
  };

  const handleChange = (e) => {
    const v = sanitize(e.target.value);
    setBuffer(v);
    e.target.value = v;
    onChange?.(e);
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={display}
      onChange={handleChange}
      onFocus={(e) => { setBuffer(toStr(value)); onFocus?.(e); }}
      onBlur={(e) => { setBuffer(null); onBlur?.(e); }}
    />
  );
}
