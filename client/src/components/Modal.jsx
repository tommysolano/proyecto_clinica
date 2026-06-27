import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineXMark } from 'react-icons/hi2';

// Pila de modales abiertos: con modales apilados, Escape solo cierra el de arriba.
const modalStack = [];

export default function Modal({ isOpen, onClose, title, children, size = 'md' }) {
  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-6xl',
    full: 'max-w-7xl',
  };

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  // Mantener una referencia viva a onClose sin reordenar la pila en cada render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!isOpen) return;
    const token = { close: () => onCloseRef.current?.() };
    modalStack.push(token);
    const handler = (e) => {
      // Solo el modal superior responde a Escape (no cierra los de abajo).
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) token.close();
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      const idx = modalStack.indexOf(token);
      if (idx >= 0) modalStack.splice(idx, 1);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`modal-panel relative bg-white rounded-2xl shadow-2xl shadow-slate-900/20 w-full ${sizes[size]} max-h-[90vh] overflow-y-auto ring-1 ring-slate-900/5`}
      >
        <div className="sticky top-0 z-10 bg-white flex items-center justify-between px-6 py-4 border-b border-slate-100 rounded-t-2xl">
          <h2 className="text-base sm:text-lg font-bold text-slate-800 tracking-tight pr-4">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center hover:bg-slate-100 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer transition-colors"
          >
            <HiOutlineXMark className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
