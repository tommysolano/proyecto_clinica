import { useState } from 'react';
import { HiOutlineTag, HiXMark, HiOutlinePlus } from 'react-icons/hi2';

/**
 * Editor de etiquetas reutilizable (chips + input para añadir).
 * Controlado: recibe `value` (array de strings) y notifica `onChange(nextArray)`.
 *
 * Props:
 *  - value: string[]            — etiquetas actuales
 *  - onChange: (next) => void   — se llama con el array nuevo
 *  - suggestions?: string[]     — etiquetas sugeridas (autocompletar)
 *  - placeholder?: string
 *  - size?: 'sm' | 'md'
 *  - readOnly?: boolean
 */
export default function TagEditor({
  value = [],
  onChange,
  suggestions = [],
  placeholder = 'Añadir etiqueta…',
  size = 'sm',
  readOnly = false,
}) {
  const [input, setInput] = useState('');
  const tags = Array.isArray(value) ? value : [];

  const add = (raw) => {
    const t = String(raw || '').trim();
    if (!t) return;
    if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setInput('');
      return;
    }
    onChange?.([...tags, t]);
    setInput('');
  };

  const remove = (t) => onChange?.(tags.filter((x) => x !== t));

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      remove(tags[tags.length - 1]);
    }
  };

  const chipCls = size === 'md' ? 'text-xs px-2 py-1' : 'text-[11px] px-1.5 py-0.5';
  const listId = `tag-suggestions-${Math.random().toString(36).slice(2, 8)}`;
  const freeSuggestions = suggestions.filter((s) => !tags.includes(s));

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
        <span className="inline-flex items-center gap-0.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => add(input)}
            list={freeSuggestions.length ? listId : undefined}
            placeholder={placeholder}
            className="border border-slate-200 rounded-full px-2 py-0.5 text-[11px] w-28 focus:w-36 transition-all outline-none focus:border-emerald-400"
          />
          {freeSuggestions.length > 0 && (
            <datalist id={listId}>
              {freeSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          {input.trim() && (
            <button
              type="button"
              onClick={() => add(input)}
              className="bg-transparent border-none cursor-pointer p-0 text-emerald-600 flex items-center"
              title="Añadir"
            >
              <HiOutlinePlus className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
