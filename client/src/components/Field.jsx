/**
 * Campo de formulario con etiqueta. Envuelve cualquier input/select/textarea
 * para que siempre tenga un label visible (accesibilidad y claridad de UI).
 *
 * Uso:
 *   <Field label="Código" required>
 *     <input className="w-full ..." />
 *   </Field>
 *
 * `className` se aplica al contenedor (útil para col-span en grids).
 */
export default function Field({ label, required = false, hint, className = '', children }) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium text-slate-600 mb-1">
          {label}{required && <span className="text-rose-500"> *</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}
