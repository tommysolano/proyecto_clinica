/**
 * Anterior / «Página X de Y» / Siguiente, para listados paginados en el
 * servidor (`pagination: { page, pages, total, limit }`). Con una sola página
 * no se pinta nada.
 */
export default function Paginador({ pagination, onPage, unidad = 'registros' }) {
  if (!pagination || pagination.pages <= 1) return null;
  const { page, pages, total, limit } = pagination;
  const desde = (page - 1) * limit + 1;
  const hasta = Math.min(page * limit, total);
  const btn = 'px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white cursor-pointer hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
      <span>Mostrando <b>{desde}–{hasta}</b> de <b>{total}</b> {unidad}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(1)}>« Primera</button>
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Anterior</button>
        <span className="px-2">Página <b>{page}</b> de <b>{pages}</b></span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)}>Siguiente ›</button>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(pages)}>Última »</button>
      </div>
    </div>
  );
}
