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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-white rounded-2xl shadow-2xl shadow-emerald-900/10 w-full ${sizes[size]} max-h-[90vh] overflow-y-auto`}>
        <div className="sticky top-0 bg-white flex items-center justify-between px-6 py-4 border-b border-emerald-100 rounded-t-2xl">
          <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer text-lg transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
