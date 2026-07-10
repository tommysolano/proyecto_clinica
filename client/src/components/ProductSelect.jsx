import SearchableSelect from './SearchableSelect';

/**
 * Selector de producto/servicio con buscador. Busca por código, nombre,
 * categoría comercial y tipo (insumo/servicio/programa…). Cada opción muestra
 * nombre completo y debajo código + categoría + stock, sin cortarse.
 *
 * Props: products, value, onChange(value), filter (predicado), showStock,
 * y el resto se pasa a SearchableSelect (size, allowClear, required…).
 */
export default function ProductSelect({
  products = [],
  value = '',
  onChange,
  filter,
  showStock = true,
  placeholder = 'Seleccione producto…',
  menuMinWidth = 400,
  ...rest
}) {
  const options = filter ? products.filter(filter) : products;
  return (
    <SearchableSelect
      options={options}
      value={value ?? ''}
      onChange={onChange}
      getLabel={(p) => `${p.code ? `${p.code} - ` : ''}${p.name}`}
      getSearchText={(p) => `${p.code || ''} ${p.name || ''} ${p.categoria || ''} ${p.category || ''}`}
      renderOption={(p) => (
        <span className="block min-w-0">
          <span className="block break-words font-medium">{p.name}</span>
          <span className="block text-[11px] text-slate-400">
            {p.code ? <span className="font-mono">{p.code}</span> : null}
            {p.category ? `${p.code ? ' · ' : ''}${p.category}` : ''}
            {p.categoria ? ` · ${p.categoria}` : ''}
            {showStock && p.stock != null && !p.unlimited ? ` · Stock: ${p.stock}` : ''}
          </span>
        </span>
      )}
      placeholder={placeholder}
      searchPlaceholder="Buscar por código, nombre, categoría o tipo…"
      menuMinWidth={menuMinWidth}
      wrapOptions
      {...rest}
    />
  );
}
