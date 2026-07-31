import { useState, useRef, useEffect, useMemo } from 'react';
import { HiOutlineMagnifyingGlass, HiOutlineXMark } from 'react-icons/hi2';

/**
 * Buscador con autocompletado para productos/servicios del inventario.
 * - products: lista completa de productos disponibles
 * - value: id del producto seleccionado
 * - onSelect: callback(product) cuando el usuario selecciona uno
 * - placeholder: texto del input
 * - filter: función opcional para filtrar productos visibles
 * - disabled
 */
export default function ProductAutocomplete({
  products = [],
  value = '',
  onSelect,
  placeholder = 'Buscar producto/servicio...',
  filter,
  disabled = false,
  className = '',
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);

  const list = useMemo(() => {
    return (products || []).filter((p) => (filter ? filter(p) : true));
  }, [products, filter]);

  // Cuando cambia value externo, sincronizamos texto del input.
  useEffect(() => {
    if (!value) {
      setQuery('');
      return;
    }
    const p = list.find((x) => x._id === value);
    if (p) setQuery(p.name || '');
  }, [value, list]);

  // Cerrar al hacer click fuera
  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 50);
    return list
      .filter((p) => {
        const text = `${p.name || ''} ${p.code || ''} ${p.category || ''}`.toLowerCase();
        return text.includes(q);
      })
      .slice(0, 50);
  }, [list, query]);

  const choose = (p) => {
    setQuery(p.name || '');
    setOpen(false);
    onSelect?.(p);
  };

  const clear = () => {
    setQuery('');
    setOpen(false);
    onSelect?.(null);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault();
        choose(filtered[highlight]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full pl-8 pr-8 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-slate-100"
        />
        {query && !disabled && (
          <button
            type="button"
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 bg-transparent border-none cursor-pointer"
            tabIndex={-1}
          >
            <HiOutlineXMark className="w-4 h-4" />
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full min-w-[280px] bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto text-sm">
          {filtered.map((p, idx) => (
            <li
              key={p._id}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={`px-3 py-2 cursor-pointer flex items-center justify-between ${
                idx === highlight ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-50'
              }`}
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-800 truncate">{p.name}</div>
                {(p.code || p.category) && (
                  <div className="text-xs text-slate-400 truncate">
                    {p.code ? `${p.code} · ` : ''}
                    {p.category || ''}
                  </div>
                )}
              </div>
              {p.salePrice != null && (
                <div className="text-xs font-semibold text-emerald-700 ml-3 whitespace-nowrap">
                  ${Number(p.salePrice).toFixed(2)}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && query && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs text-slate-400 text-center">
          Sin resultados
        </div>
      )}
    </div>
  );
}
