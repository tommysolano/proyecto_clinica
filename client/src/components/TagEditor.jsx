import { useState } from 'react';
import { HiOutlineTag, HiXMark } from 'react-icons/hi2';
import SuggestInput from './SuggestInput';

/**
 * Editor de etiquetas reutilizable (chips + buscador para añadir).
 * Controlado: recibe `value` (array de strings) y notifica `onChange(nextArray)`.
 *
 * POR QUÉ UN BUSCADOR Y NO UN CAMPO A SECAS. Antes había que escribir la
 * etiqueta entera de memoria cada vez (las sugerencias iban en un `<datalist>`,
 * que casi ningún navegador enseña al pinchar). Escrita a mano, "promo" y
 * "Promo" son dos etiquetas distintas: los filtros y los segmentos se parten sin
 * que nadie se entere. Ahora al pinchar salen las que ya existen —lo más usado
 * primero— y solo se escribe cuando de verdad es una nueva.
 *
 * Props:
 *  - value: string[]            — etiquetas actuales
 *  - onChange: (next) => void   — se llama con el array nuevo
 *  - suggestions?: string[] | [{ name, count }] — las que ya existen
 *  - placeholder?: string
 *  - size?: 'sm' | 'md'
 *  - readOnly?: boolean
 */
export default function TagEditor({
  value = [],
  onChange,
  suggestions = [],
  placeholder = 'Buscar o crear etiqueta…',
  size = 'sm',
  readOnly = false,
}) {
  const [input, setInput] = useState('');
  const tags = Array.isArray(value) ? value : [];

  const add = (raw) => {
    const t = String(raw || '').trim();
    setInput('');
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange?.([...tags, t]);
  };

  const remove = (t) => onChange?.(tags.filter((x) => x !== t));

  const chipCls = size === 'md' ? 'text-xs px-2 py-1' : 'text-[11px] px-1.5 py-0.5';
  // Las ya puestas no se ofrecen otra vez (acepta ['vip'] y [{name,count}]).
  const libres = (suggestions || [])
    .map((s) => (typeof s === 'string' ? { name: s, count: 0 } : s))
    .filter((s) => s?.name && !tags.some((t) => t.toLowerCase() === String(s.name).toLowerCase()));

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.length === 0 && readOnly && (
        <span className="text-[11px] text-slate-400">Sin etiquetas</span>
      )}
      {tags.map((t) => (
        <span
          key={t}
          className={`inline-flex items-center gap-1 ${chipCls} rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200`}
        >
          <HiOutlineTag className="w-3 h-3 shrink-0" />
          {t}
          {!readOnly && (
            <button
              type="button"
              onClick={() => remove(t)}
              className="bg-transparent border-none cursor-pointer p-0 text-emerald-500 hover:text-rose-500 flex items-center"
              title="Quitar etiqueta"
            >
              <HiXMark className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <span className="inline-flex min-w-[11rem] flex-1">
          <SuggestInput
            value={input}
            onChange={setInput}
            onSelect={add}
            options={libres}
            placeholder={placeholder}
            emptyHint="Todavía no hay etiquetas. Escribe la primera y pulsa Enter."
            // La coma también cierra la etiqueta (se pegan varias de una lista), y
            // Retroceso con el campo vacío quita la última: dos atajos que ya
            // tenía este editor y que la gente usa.
            onKeyDownExtra={(e) => {
              if (e.key === ',') { e.preventDefault(); add(input); }
              else if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
            }}
            onBlur={() => add(input)}
            className="w-full border border-slate-200 rounded-full pl-3 pr-7 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white"
          />
        </span>
      )}
    </div>
  );
}
