import { useMemo } from 'react';
import SearchableSelect from './SearchableSelect';

const TYPE_BADGE = {
  ACTIVO: 'bg-sky-50 text-sky-700',
  PASIVO: 'bg-amber-50 text-amber-700',
  PATRIMONIO: 'bg-violet-50 text-violet-700',
  INGRESO: 'bg-emerald-50 text-emerald-700',
  GASTO: 'bg-rose-50 text-rose-600',
  COSTO: 'bg-orange-50 text-orange-700',
  ORDEN: 'bg-slate-100 text-slate-500',
};

/**
 * Selector de cuenta contable con buscador. Pásale el plan de cuentas COMPLETO
 * (incluidas las agrupadoras): las agrupadoras no se pueden elegir (salvo
 * `includeGroups`) pero sí se usan para mostrar la ruta padre de cada cuenta.
 *
 * Busca por código, nombre, nombre de las cuentas padre y tipo (ACTIVO, GASTO…).
 * Cada opción se muestra en dos líneas (código + nombre completo sin cortar,
 * y debajo tipo + ruta contable) en un panel ancho que no se recorta.
 *
 * Props:
 *  - accounts: plan de cuentas (idealmente sin filtrar)
 *  - value / onChange(value)
 *  - filter: predicado extra sobre las cuentas elegibles (ej: solo 6.x)
 *  - includeGroups: permite elegir cuentas agrupadoras (ej: Mayor)
 *  - emptyOption: texto de una opción con value '' (ej: "(Predeterminada: 4.2.02)")
 *  - resto: se pasa a SearchableSelect (size, allowClear, disabled, required…)
 */
export default function AccountSelect({
  accounts = [],
  value = '',
  onChange,
  filter,
  includeGroups = false,
  emptyOption = null,
  placeholder = 'Seleccione cuenta…',
  searchPlaceholder = 'Buscar por código, nombre, cuenta padre o tipo…',
  menuMinWidth = 480,
  ...rest
}) {
  const nameByCode = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(a.code, a.name);
    return m;
  }, [accounts]);

  // Ruta contable: nombres de las cuentas padre derivados del código con puntos
  // (para "1.1.01.03" busca "1", "1.1" y "1.1.01" en el plan recibido).
  const parentPath = (a) => {
    const parts = String(a.code || '').split('.');
    const names = [];
    for (let i = 1; i < parts.length; i++) {
      const name = nameByCode.get(parts.slice(0, i).join('.'));
      if (name) names.push(name);
    }
    return names.join(' / ');
  };

  const options = useMemo(() => {
    let list = accounts.filter((a) => includeGroups || a.allowsMovement !== false);
    if (filter) list = list.filter(filter);
    list = [...list].sort((x, y) => String(x.code || '').localeCompare(String(y.code || ''), undefined, { numeric: true }));
    if (emptyOption != null) list = [{ _id: '', code: '', name: emptyOption, _empty: true }, ...list];
    return list;
  }, [accounts, filter, includeGroups, emptyOption]);

  return (
    <SearchableSelect
      options={options}
      value={value ?? ''}
      onChange={onChange}
      getLabel={(a) => (a._empty ? a.name : `${a.code} — ${a.name}`)}
      getSearchText={(a) => (a._empty ? a.name : `${a.code} ${a.name} ${parentPath(a)} ${a.type || ''}`)}
      renderOption={(a) => (a._empty ? (
        <span className="text-slate-500 italic">{a.name}</span>
      ) : (
        <span className="block min-w-0">
          <span className="block break-words">
            <span className="font-mono text-slate-500">{a.code}</span>{' '}
            <span className="font-medium">{a.name}</span>
            {a.allowsMovement === false && <span className="text-[10px] text-slate-400"> (agrupadora)</span>}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
            {a.type && <span className={`px-1 py-px rounded text-[10px] font-semibold shrink-0 ${TYPE_BADGE[a.type] || 'bg-slate-100 text-slate-500'}`}>{a.type}</span>}
            <span className="truncate">{parentPath(a)}</span>
          </span>
        </span>
      ))}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      menuMinWidth={menuMinWidth}
      wrapOptions
      {...rest}
    />
  );
}
