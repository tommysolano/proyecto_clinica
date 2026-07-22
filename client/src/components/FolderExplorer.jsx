import { useMemo, useState } from 'react';
import {
  HiOutlineFolder,
  HiOutlineFolderPlus,
  HiOutlineChevronRight,
  HiOutlineMagnifyingGlass,
  HiOutlineTrash,
} from 'react-icons/hi2';

/**
 * Explorador de CARPETAS anidadas tipo Windows (breadcrumb + lista de carpetas +
 * "Nueva carpeta" + buscador global), reutilizable por Mensajes Guardados y
 * Automatizaciones. La misma lógica que tenía suelta la página de Mensajes
 * Guardados, extraída para compartirla.
 *
 * El componente NO conoce el tipo de elemento: recibe `items` y una función
 * `renderItems({ rows, showFolderColumn, emptyText })` que pinta la lista del nivel
 * actual (tabla, tarjetas…). Las carpetas salen de dos fuentes que se unen: las
 * RUTAS de los propios elementos (`getFolder`) y las carpetas persistidas
 * (`registryPaths`), para que una carpeta vacía recién creada también aparezca.
 */

// Pseudo-carpeta para los elementos sin carpeta (el carácter nulo nunca puede ir
// en un nombre escrito por el usuario, así que no colisiona con una ruta real).
const UNFILED = '/__unfiled__';

export function normFolderPath(raw) {
  return String(raw || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

export default function FolderExplorer({
  rootLabel,
  items = [],
  getFolder,
  matchItem,
  registryPaths = [],
  itemNoun = 'elemento(s)',
  onCreateFolder,
  onDeleteFolder,
  renderItems,
  toolbar = null, // acciones a la derecha del buscador (p. ej. "Nuevo elemento")
  searchPlaceholder = 'Buscar en todas las carpetas...',
}) {
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');

  const folderOf = (it) => normFolderPath(getFolder(it));

  // Todas las rutas de carpeta que existen (elementos + registro), incluyendo los
  // ancestros implícitos: si hay "A/B", "A" también cuenta como carpeta.
  const allFolderPaths = useMemo(() => {
    const set = new Set();
    const add = (p) => {
      const parts = normFolderPath(p).split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) set.add(parts.slice(0, i + 1).join('/'));
    };
    items.forEach((it) => add(folderOf(it)));
    registryPaths.forEach(add);
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, registryPaths]);

  // Subcarpetas inmediatas de la carpeta actual + nº de elementos que contiene cada una.
  const childFolders = useMemo(() => {
    const prefix = path ? path + '/' : '';
    const names = new Map(); // nombre -> ruta completa
    allFolderPaths.forEach((fp) => {
      if (path && !fp.startsWith(prefix)) return;
      const rest = path ? fp.slice(prefix.length) : fp;
      const name = rest.split('/')[0];
      if (name) names.set(name, prefix + name);
    });
    const countIn = (full) =>
      items.filter((it) => {
        const f = folderOf(it);
        return f === full || f.startsWith(full + '/');
      }).length;
    return [...names.entries()]
      .map(([name, full]) => ({ name, full, count: countIn(full) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFolderPaths, path, items]);

  const hasAnyFolder = allFolderPaths.size > 0;
  const looseItems = useMemo(() => items.filter((it) => !folderOf(it)), [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderRows = useMemo(() => {
    if (path === UNFILED) return [];
    const rows = [...childFolders];
    if (path === '' && hasAnyFolder && looseItems.length) {
      rows.push({ name: 'Sin carpeta', full: UNFILED, count: looseItems.length, unfiled: true });
    }
    return rows;
  }, [childFolders, path, hasAnyFolder, looseItems]);

  const itemRows = useMemo(() => {
    if (path === UNFILED) return looseItems;
    if (path === '') return hasAnyFolder ? [] : looseItems;
    return items.filter((it) => folderOf(it) === path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, items, hasAnyFolder, looseItems]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return items.filter((it) => matchItem(it, q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search]);

  const crumbItems =
    path === UNFILED
      ? [{ label: 'Sin carpeta', to: UNFILED }]
      : path
        ? path.split('/').map((seg, i, arr) => ({ label: seg, to: arr.slice(0, i + 1).join('/') }))
        : [];

  const showingSearch = searchResults !== null;

  const createFolder = async () => {
    const name = window.prompt(
      path && path !== UNFILED
        ? `Nueva subcarpeta dentro de "${path}":`
        : 'Nombre de la nueva carpeta:'
    );
    const clean = normFolderPath(name);
    if (!clean) return;
    const base = path && path !== UNFILED ? path + '/' : '';
    const full = normFolderPath(base + clean);
    const ok = await onCreateFolder(full);
    if (ok !== false) setPath(full); // entrar en la carpeta recién creada
  };

  const removeFolder = async (full) => {
    const ok = await onDeleteFolder(full);
    if (ok !== false && (path === full || path.startsWith(full + '/'))) setPath('');
  };

  const emptyText = showingSearch
    ? 'Sin resultados para la búsqueda.'
    : items.length === 0
      ? 'Aún no hay nada aquí. Crea el primero.'
      : 'Carpeta vacía.';

  const currentPath = path === UNFILED ? '' : path;
  const toolbarNode = typeof toolbar === 'function' ? toolbar(currentPath) : toolbar;

  return (
    <div>
      {/* Buscador + acciones */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-72 pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
          />
        </div>
        {showingSearch && (
          <span className="text-xs text-slate-500">{searchResults.length} resultado(s) para “{search.trim()}”</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!showingSearch && (
            <button
              onClick={createFolder}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer flex items-center gap-1 whitespace-nowrap"
            >
              <HiOutlineFolderPlus className="w-4 h-4 text-emerald-600" /> Nueva carpeta
            </button>
          )}
          {toolbarNode}
        </div>
      </div>

      {/* Breadcrumb tipo Windows */}
      {!showingSearch && (
        <div className="flex items-center gap-1 flex-wrap mb-3 text-sm">
          <button
            onClick={() => setPath('')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border cursor-pointer ${
              !path ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            <HiOutlineFolder className="w-4 h-4" /> {rootLabel}
          </button>
          {crumbItems.map((c, i) => {
            const isLast = i === crumbItems.length - 1;
            return (
              <span key={c.to} className="inline-flex items-center gap-1">
                <HiOutlineChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <button
                  onClick={() => setPath(c.to)}
                  className={`px-2 py-1 rounded-lg border cursor-pointer ${
                    isLast ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {c.label}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Carpetas como lista (tipo explorador) */}
      {!showingSearch && folderRows.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
          {folderRows.map((f) => (
            <div key={f.full} className="group flex items-center border-b border-slate-100 last:border-b-0 hover:bg-emerald-50/50">
              <button
                onClick={() => setPath(f.full)}
                className="flex-1 flex items-center gap-3 px-4 py-3 cursor-pointer text-left bg-transparent border-none"
              >
                <HiOutlineFolder className={`w-5 h-5 shrink-0 ${f.unfiled ? 'text-slate-400' : 'text-amber-500'}`} />
                <span className="flex-1 text-sm font-medium text-slate-700 truncate">{f.name}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap">{f.count} {itemNoun}</span>
              </button>
              {!f.unfiled && (
                <button
                  onClick={() => removeFolder(f.full)}
                  title="Eliminar carpeta (debe estar vacía)"
                  className="p-2 mr-1 text-slate-300 hover:text-rose-500 bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100"
                >
                  <HiOutlineTrash className="w-4 h-4" />
                </button>
              )}
              <HiOutlineChevronRight className="w-4 h-4 text-slate-300 shrink-0 mr-3" />
            </div>
          ))}
        </div>
      )}

      {/* Elementos del nivel actual (o resultados de búsqueda) */}
      {(showingSearch || itemRows.length > 0 || folderRows.length === 0) &&
        renderItems({
          rows: showingSearch ? searchResults : itemRows,
          showFolderColumn: showingSearch,
          currentPath: path === UNFILED ? '' : path,
          emptyText,
        })}
    </div>
  );
}
