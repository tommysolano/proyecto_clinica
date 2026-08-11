import { useEffect, useRef, useState } from 'react';
import { FiCalendar } from 'react-icons/fi';
import { fmtDate, parseDdMmYyyy, maskDdMmYyyy } from '../utils/date';

/**
 * Campo de fecha en formato dd/mm/aaaa.
 *
 * El <input type="date"> nativo pinta la fecha con el formato del NAVEGADOR
 * (en un Windows en inglés sale mm/dd/aaaa) y eso no se puede cambiar ni con
 * CSS ni con lang="es". Por eso escribimos la fecha en un input de texto con
 * máscara dd/mm/aaaa y dejamos el calendario nativo detrás, solo para el botón.
 *
 * Es un reemplazo directo de <input type="date">: hacia afuera sigue hablando
 * ISO 'YYYY-MM-DD' y emite un onChange con { target: { name, value } }, así que
 * los handlers existentes (incluidos los genéricos por `name`) no cambian.
 */

const toDisplay = fmtDate;
const toIso = parseDdMmYyyy;
const mask = maskDdMmYyyy;

export default function DateInput({
  value = '',
  onChange,
  name,
  min,
  max,
  required = false,
  disabled = false,
  className = '',
  title,
  ...rest
}) {
  const [text, setText] = useState(() => toDisplay(value));
  const textRef = useRef(null);
  const pickerRef = useRef(null);

  // Sincroniza cuando el valor cambia desde fuera (reset del formulario, carga
  // de datos, etc.). No pisa lo que se está escribiendo: `value` solo cambia
  // cuando ya emitimos una fecha completa.
  useEffect(() => {
    setText(toDisplay(value));
  }, [value]);

  const emit = (iso) => {
    if (!onChange) return;
    onChange({
      target: { name, value: iso, type: 'date' },
      currentTarget: { name, value: iso, type: 'date' },
    });
  };

  // El rango se valida aquí porque un input de texto no entiende min/max.
  const outOfRange = (iso) => (min && iso < min) || (max && iso > max);

  const validate = (nextText) => {
    const el = textRef.current;
    if (!el) return;
    if (!nextText) {
      el.setCustomValidity('');
      return;
    }
    const iso = toIso(nextText);
    if (!iso) el.setCustomValidity('Fecha incompleta o inexistente. Usa dd/mm/aaaa.');
    else if (min && iso < min) el.setCustomValidity(`La fecha no puede ser anterior al ${toDisplay(min)}.`);
    else if (max && iso > max) el.setCustomValidity(`La fecha no puede ser posterior al ${toDisplay(max)}.`);
    else el.setCustomValidity('');
  };

  const handleText = (e) => {
    const next = mask(e.target.value);
    setText(next);
    validate(next);
    if (!next) {
      emit('');
      return;
    }
    const iso = toIso(next);
    if (iso && !outOfRange(iso)) emit(iso);
  };

  // Al salir: el texto a medias se descarta y se vuelve a mostrar el valor real,
  // para que no parezca guardado algo que no lo está. Una fecha completa pero
  // fuera de min/max SÍ se conserva a la vista, marcada como inválida: revertirla
  // en silencio escondería el motivo del rechazo.
  const handleBlur = (e) => {
    const iso = toIso(text);
    if (!text) emit('');
    else if (!iso) {
      setText(toDisplay(value));
      validate(toDisplay(value));
    }
    rest.onBlur?.(e);
  };

  const openPicker = () => {
    const el = pickerRef.current;
    if (!el || disabled) return;
    // showPicker lanza si el navegador no lo considera un gesto válido; no es
    // motivo para romper nada, la fecha siempre se puede escribir.
    try {
      el.showPicker();
    } catch {
      /* sin calendario nativo: se escribe a mano */
    }
  };

  const invalid = !!text && (!toIso(text) || outOfRange(toIso(text)));

  // Si el navegador no sabe abrir el calendario a pedido, no pintamos el botón.
  const canOpenPicker =
    typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype;

  // El input queda envuelto en un contenedor (hace falta para colocar el botón
  // del calendario), y eso puede cambiar el layout del sitio que lo usa. Para
  // que se siga viendo igual que el <input type="date"> que reemplazó, las
  // clases que colocan el campo DENTRO de su padre (márgenes, flex, grid) pasan
  // al contenedor, y las que lo pintan se quedan en el input.
  const outerRe = /^(-?m[trblxy]?-|flex-1$|grow|shrink|basis-|self-|col-span-|row-span-|order-)/;
  const parts = className.split(/\s+/).filter(Boolean);
  const outer = parts.filter((c) => outerRe.test(c));
  const inner = parts.filter((c) => !outerRe.test(c));
  // Si el campo se estiraba (w-full o flex-1), el contenedor se estira y el
  // input lo llena; si no, ambos toman el ancho natural de 'dd/mm/aaaa'.
  const grows = outer.some((c) => /^(flex-1|grow|basis-)/.test(c));
  // '.input' (index.css) ya trae w-full, así que también estira.
  const full = inner.includes('w-full') || inner.includes('input');
  const wrapWidth = grows ? '' : full ? 'block w-full' : 'inline-block';

  return (
    <span className={['relative', wrapWidth, ...outer].filter(Boolean).join(' ')}>
      <input
        {...rest}
        ref={textRef}
        type="text"
        inputMode="numeric"
        name={name}
        value={text}
        onChange={handleText}
        onBlur={handleBlur}
        placeholder="dd/mm/aaaa"
        maxLength={10}
        // 10 caracteres: sin clase de ancho queda como el input de fecha nativo.
        size={10}
        required={required}
        disabled={disabled}
        title={title}
        className={[
          ...inner,
          grows ? 'w-full' : '',
          canOpenPicker ? 'pr-8' : '',
          invalid ? 'border-red-400 text-red-600' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        autoComplete="off"
      />
      {canOpenPicker && (
        <>
          <button
            type="button"
            onClick={openPicker}
            disabled={disabled}
            tabIndex={-1}
            aria-label="Abrir calendario"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 disabled:opacity-40"
          >
            <FiCalendar />
          </button>
          {/* Solo existe para abrir el calendario del sistema; nunca se ve. */}
          <input
            ref={pickerRef}
            type="date"
            tabIndex={-1}
            aria-hidden="true"
            value={toIso(text) || ''}
            min={min}
            max={max}
            onChange={(e) => {
              const iso = e.target.value;
              setText(toDisplay(iso));
              validate(toDisplay(iso));
              emit(iso);
            }}
            className="absolute right-2 top-1/2 h-0 w-0 -translate-y-1/2 opacity-0"
          />
        </>
      )}
    </span>
  );
}
