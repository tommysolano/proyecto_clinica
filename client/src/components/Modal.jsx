import { HiOutlineXMark } from 'react-icons/hi2';

export default function Modal({ isOpen, onClose, title, children, size = 'md' }) {
  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-6xl',
    full: 'max-w-7xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="modal-overlay fixed inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`modal-panel relative bg-white rounded-2xl shadow-2xl shadow-slate-900/20 w-full ${sizes[size]} max-h-[90vh] overflow-y-auto ring-1 ring-slate-900/5`}
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur flex items-center justify-between px-6 py-4 border-b border-slate-100 rounded-t-2xl">
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
    </div>
  );
}
