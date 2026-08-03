import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineEllipsisVertical } from 'react-icons/hi2';

const ANCHO = 232;      // px — coincide con el ancho fijo del panel
const ALTO_ITEM = 38;   // px — estimación para decidir si abre hacia arriba

/**
 * Menú «⋯» de acciones secundarias de una fila.
 *
 * Nace de un problema real: apilar 6–7 acciones en texto dentro de la última
 * columna deja la tabla ilegible y termina recortando los últimos botones.
 * La idea es dejar a la vista SOLO la acción principal de cada fila y guardar
 * aquí el resto.
 *
 * Se dibuja en un portal (igual que `Modal`) porque el contenedor de la tabla
 * tiene scroll y recortaría un desplegable normal — que es justo el defecto
 * que este componente viene a corregir.
 *
 * items: [{ key, label, onClick, icon, danger, hidden, disabled }]
 *  - `hidden` filtra la opción (más cómodo que armar el array con condicionales)
 *  - `danger` la pinta en rojo y la separa con una línea del grupo anterior
 * Si no queda ninguna opción visible, no se dibuja ni el botón.
 */
export default function RowMenu({ items = [], title = 'Más acciones' }) {
  const opciones = items.filter((i) => i && !i.hidden);
  const [pos, setPos] = useState(null); // null = cerrado
  const abierto = !!pos;
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!abierto) return undefined;
    const cerrar = () => setPos(null);
    const fuera = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      cerrar();
    };
    const tecla = (e) => { if (e.key === 'Escape') cerrar(); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    window.addEventListener('resize', cerrar);
    // `true` = fase de captura: así también se entera del scroll del contenedor
    // de la tabla (el menú está posicionado en coordenadas de pantalla).
    window.addEventListener('scroll', cerrar, true);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('resize', cerrar);
      window.removeEventListener('scroll', cerrar, true);
    };
  }, [abierto]);

  if (!opciones.length) return null;

  const abrir = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const alto = 12 + opciones.length * ALTO_ITEM;
    const cabeAbajo = window.innerHeight - r.bottom > alto + 12;
    setPos({
      left: Math.max(8, Math.min(r.right - ANCHO, window.innerWidth - ANCHO - 8)),
      top: cabeAbajo ? r.bottom + 6 : Math.max(8, r.top - alto - 6),
    });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={abierto}
        onClick={() => (abierto ? setPos(null) : abrir())}
        className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${abierto ? 'bg-slate-200 text-slate-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}
      >
        <HiOutlineEllipsisVertical className="w-5 h-5" />
      </button>

      {abierto && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: ANCHO }}
          className="z-[1000] bg-white rounded-xl shadow-xl shadow-slate-900/10 ring-1 ring-slate-900/10 py-1.5 text-sm"
        >
          {opciones.map((it, i) => {
            const Icon = it.icon;
            const separar = it.danger && i > 0 && !opciones[i - 1].danger;
            return (
              <button
                key={it.key || it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={it.hint || undefined}
                onClick={() => { setPos(null); it.onClick?.(); }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2.5 bg-transparent border-none disabled:opacity-40 disabled:cursor-not-allowed ${separar ? 'mt-1.5 pt-2.5 border-t border-slate-100' : ''} ${it.danger ? 'text-rose-600 hover:bg-rose-50' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                {Icon ? <Icon className="w-4 h-4 shrink-0" /> : <span className="w-4 shrink-0" />}
                <span className="truncate">{it.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
