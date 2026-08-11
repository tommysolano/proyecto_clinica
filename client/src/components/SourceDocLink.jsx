import { Link } from 'react-router-dom';
import { HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import { SOURCE_ROUTES, sourceDeepLink, sourceLabel } from '../pages/accounting/sourceDocs';

/**
 * ENLACE AL DOCUMENTO QUE ORIGINÓ UN MOVIMIENTO.
 *
 * Toda pantalla que liste movimientos (caja, cartera, depósitos, cobros, liquidaciones…)
 * debe dejar llegar al documento de donde salió cada línea, como ya hacía la pantalla de
 * cheques con su "se usó en". Aquí vive esa navegación una sola vez para que todas se
 * comporten igual: si el destino sabe abrirse por `?doc=<id>` se enlaza, y si no, se
 * muestra al menos QUÉ tipo de documento es (no un id suelto que no dice nada).
 *
 * Uso: `<SourceDocLink model="Sale" id={row.sourceRef} number={row.number} />`
 * o directamente con una fila que ya traiga `sourceModel`/`sourceRef`:
 *      `<SourceDocLink row={row} />`
 */
export default function SourceDocLink({
  row,
  model,
  id,
  number,
  label,
  className = '',
  showIcon = true,
}) {
  const sourceModel = model || row?.sourceModel || row?.docModel;
  const sourceRef = id || row?.sourceRef || row?.docRef;
  if (!sourceModel && !sourceRef) return <span className="text-slate-300">—</span>;

  const meta = SOURCE_ROUTES[sourceModel];
  const texto = label || number || meta?.label || sourceLabel({ sourceModel });
  const url = sourceDeepLink({ sourceModel, sourceRef });

  if (!url) {
    // Sin pantalla que sepa abrirlo: al menos se nombra el documento.
    return (
      <span className={`text-slate-600 ${className}`} title={meta?.label || sourceModel || ''}>
        {texto}
      </span>
    );
  }

  return (
    <Link
      to={url}
      title={`Ver ${(meta?.label || 'documento').toLowerCase()}`}
      className={`inline-flex items-center gap-1 text-sky-700 hover:underline ${className}`}
    >
      {texto}
      {showIcon && <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5 shrink-0" />}
    </Link>
  );
}
