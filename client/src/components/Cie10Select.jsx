import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineMagnifyingGlass, HiOutlineXMark } from 'react-icons/hi2';
import api from '../api/axios';

/**
 * Buscador de códigos CIE-10 contra el backend (/api/cie10?search=). Devuelve el
 * código y su descripción para la sección I (Diagnóstico) del formulario MSP.
 * El panel se renderiza en un portal fijo para no recortarse dentro de tablas/modales.
 *
 * Props:
 *  - code, description: valor seleccionado actual
 *  - onChange: ({ code, description }) => void
 *  - placeholder
 */
export default function Cie10Select({ code = '', description = '', onChange, placeholder = 'Buscar CIE-10…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);

  // Búsqueda con debounce.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.get('/cie10', { params: { search: q } });
        setResults(Array.isArray(r.data) ? r.data : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 260 && r.top > spaceBelow;
    const margin = 8;
    const width = Math.max(r.width, 320);
    let left = r.left;
    if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - width);
    setCoords({
      left,
      width: Math.min(width, window.innerWidth - margin * 2),
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
      maxH: Math.max(180, (openUp ? r.top : spaceBelow) - 12),
    });
  };

  useLayoutEffect(() => { if (open) place(); }, [open, results.length]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const choose = (o) => {
    onChange({ code: o.code, description: o.description });
    setOpen(false);
    setQuery('');
  };

  const label = code ? `${code} — ${description}` : '';

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 border rounded-lg bg-white px-2 py-1.5 text-xs border-slate-200 hover:border-slate-300"
      >
        <span className={`truncate text-left ${code ? 'text-slate-700' : 'text-slate-400'}`}>
          {label || placeholder}
        </span>
        {code && (
          <HiOutlineXMark
            className="w-4 h-4 shrink-0 text-slate-400 hover:text-rose-500"
            onClick={(e) => { e.stopPropagation(); onChange({ code: '', description: '' }); }}
          />
        )}
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
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Código o enfermedad…"
                className="flex-1 bg-transparent py-2 text-sm outline-none"
              />
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: coords.maxH }}>
            {loading && <div className="px-3 py-4 text-center text-xs text-slate-400">Buscando…</div>}
            {!loading && results.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-slate-400">Sin resultados</div>
            )}
            {!loading && results.map((o) => (
              <button
                type="button"
                key={o.code}
                onClick={() => choose(o)}
                className="w-full text-left px-3 py-2 text-sm flex items-start gap-2 hover:bg-emerald-50 text-slate-700"
              >
                <span className="font-mono text-xs font-semibold text-emerald-700 shrink-0 mt-0.5">{o.code}</span>
                <span className="break-words min-w-0">{o.description}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
