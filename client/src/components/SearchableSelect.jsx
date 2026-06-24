import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineMagnifyingGlass, HiOutlineChevronDown, HiOutlineXMark, HiOutlineCheck } from 'react-icons/hi2';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Select con buscador (combobox). El panel se renderiza en un portal con posición
 * fija para que NUNCA lo recorten contenedores con overflow (modales, tablas con
 * scroll). Filtra por texto (sin tildes), con navegación por teclado.
 *
 * Props:
 *  - options: array de opciones
 *  - value: valor seleccionado (string)
 *  - onChange: (value) => void  (devuelve el value, o '' al limpiar)
 *  - getLabel / getValue / getSearchText: accessors (defaults razonables)
 *  - placeholder, searchPlaceholder, disabled, allowClear, required, className, size('sm'|'md')
 *  - renderOption: (opt) => node  (opcional, para opciones enriquecidas)
 */
export default function SearchableSelect({
  options = [],
  value = '',
  onChange,
  getLabel = (o) => o.label ?? o.name ?? '',
  getValue = (o) => o._id ?? o.value ?? '',
  getSearchText,
  placeholder = 'Seleccione…',
  searchPlaceholder = 'Buscar…',
  disabled = false,
  allowClear = false,
  required = false,
  className = '',
  renderOption,
  size = 'md',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);

  const selected = useMemo(
    () => options.find((o) => String(getValue(o)) === String(value)),
    [options, value, getValue]
  );
  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return options;
    const text = getSearchText || getLabel;
    return options.filter((o) => norm(text(o)).includes(q));
  }, [options, query, getLabel, getSearchText]);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const wanted = Math.min(320, 52 + Math.max(1, filtered.length) * 34);
    const openUp = spaceBelow < wanted && r.top > spaceBelow;
    setCoords({
      left: r.left,
      width: r.width,
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
      maxH: Math.max(160, (openUp ? r.top : spaceBelow) - 12),
    });
  };

  useLayoutEffect(() => { if (open) place(); }, [open, filtered.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const onDoc = (e) => {
      if (triggerRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    // Escape cierra SOLO el dropdown (captura antes de que el Modal padre lo reciba).
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    document.addEventListener('keydown', onEsc, true);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc, true);
      clearTimeout(t);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (o) => { onChange(String(getValue(o))); setOpen(false); setQuery(''); };

  const pad = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-2.5 text-sm';

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-2 border rounded-xl bg-white ${pad} ${disabled ? 'bg-slate-50 text-slate-400 border-slate-200' : 'border-slate-200 hover:border-slate-300'} ${required && !selected ? 'border-rose-200' : ''} ${className}`}
      >
        <span className={`truncate text-left ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
          {selected ? getLabel(selected) : placeholder}
        </span>
        <span className="flex items-center gap-1 shrink-0 text-slate-400">
          {allowClear && selected && !disabled && (
            <HiOutlineXMark className="w-4 h-4 hover:text-rose-500" onClick={(e) => { e.stopPropagation(); onChange(''); }} />
          )}
          <HiOutlineChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && coords && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', left: coords.left, width: coords.width, top: coords.top, bottom: coords.bottom, zIndex: 10001 }}
          className="bg-white rounded-xl shadow-2xl shadow-slate-900/20 ring-1 ring-slate-900/10 overflow-hidden flex flex-col"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-2">
              <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlight]) choose(filtered[highlight]); }
                }}
                placeholder={searchPlaceholder}
                className="flex-1 bg-transparent py-2 text-sm outline-none"
              />
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: coords.maxH }}>
            {filtered.length === 0 && <div className="px-3 py-4 text-center text-xs text-slate-400">Sin resultados</div>}
            {filtered.map((o, i) => {
              const v = String(getValue(o));
              const isSel = v === String(value);
              return (
                <button
                  type="button"
                  key={v || i}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${i === highlight ? 'bg-emerald-50' : ''} ${isSel ? 'text-emerald-700 font-medium' : 'text-slate-700'}`}
                >
                  <span className="truncate">{renderOption ? renderOption(o) : getLabel(o)}</span>
                  {isSel && <HiOutlineCheck className="w-4 h-4 shrink-0 text-emerald-600" />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
