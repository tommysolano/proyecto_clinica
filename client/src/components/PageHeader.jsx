/**
 * Encabezado de página consistente para toda la app.
 *  - icon:     componente de ícono (react-icons) opcional → se muestra en un chip
 *  - title:    título de la página
 *  - subtitle: descripción corta opcional
 *  - children: acciones (botones) alineadas a la derecha
 */
export default function PageHeader({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && (
          <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm shrink-0">
            <Icon className="w-6 h-6" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="page-title truncate">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * Estado vacío estándar (ícono + título + texto guía) para listas/tablas vacías.
 */
export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="empty-state">
      {Icon && <Icon className="w-10 h-10 text-slate-300" />}
      <p className="font-medium text-slate-500">{title}</p>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
      {action}
    </div>
  );
}
