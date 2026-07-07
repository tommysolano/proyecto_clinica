import Spinner from './Spinner';

/**
 * Línea de estado para la validación de correo (hook useEmailValidation).
 * Muestra spinner mientras verifica y, si detecta un typo, un botón para
 * aplicar la corrección sugerida.
 */
export default function EmailStatus({ status, onApplySuggestion, className = '' }) {
  if (!status?.msg && !status?.suggestion) return null;
  const color = status.error
    ? 'text-red-500'
    : status.loading
    ? 'text-slate-500'
    : 'text-emerald-600';
  return (
    <p className={`text-[11px] mt-1 flex items-center gap-1.5 flex-wrap ${color} ${className}`}>
      {status.loading && <Spinner className="h-3 w-3 shrink-0" />}
      <span>{status.msg}</span>
      {status.suggestion && onApplySuggestion && (
        <button
          type="button"
          onClick={() => onApplySuggestion(status.suggestion)}
          className="underline font-medium text-emerald-600 hover:text-emerald-700 cursor-pointer bg-transparent border-none p-0"
        >
          ¿Quisiste decir {status.suggestion}?
        </button>
      )}
    </p>
  );
}
