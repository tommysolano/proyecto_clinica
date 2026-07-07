import Spinner from './Spinner';

/**
 * Línea de estado para el autocompletado por cédula/RUC (hook useSriLookup).
 * Muestra un spinner mientras busca y un mensaje según el resultado.
 */
export default function SriStatus({ status, className = '' }) {
  if (!status?.msg) return null;
  const color = status.error
    ? 'text-red-500'
    : status.loading
    ? 'text-slate-500'
    : 'text-emerald-600';
  return (
    <p className={`text-[11px] mt-1 flex items-center gap-1 ${color} ${className}`}>
      {status.loading && <Spinner className="h-3 w-3 shrink-0" />}
      {status.msg}
    </p>
  );
}
