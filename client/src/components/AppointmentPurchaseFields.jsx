import ProductAutocomplete from './ProductAutocomplete';
import {
  HiOutlineBeaker,
  HiOutlineMinus,
  HiOutlinePlus,
  HiOutlineShoppingBag,
  HiOutlineTrash,
} from 'react-icons/hi2';

const PAYMENT_METHODS = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'tarjeta_credito', label: 'T. crédito' },
  { value: 'tarjeta_debito', label: 'T. débito' },
];

const itemKey = (item) => String(item.item || item.name || '');

export default function AppointmentPurchaseFields({ purchase }) {
  const {
    prescribedItems,
    selected,
    additionalItems,
    itemsValue,
    itemsMethod,
    products,
    pickerKey,
    togglePrescription,
    addProduct,
    changeQuantity,
    removeProduct,
    setItemsValue,
    setItemsMethod,
  } = purchase;

  return (
    <div className="border border-violet-200 rounded-xl overflow-visible">
      <div className="bg-violet-50 px-3 py-2 border-b border-violet-200 rounded-t-xl">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-800 m-0">
          <HiOutlineShoppingBag className="w-4 h-4" />
          Productos que compra el paciente
        </p>
      </div>

      <div className="p-3 space-y-3">
        {prescribedItems.length > 0 && (
          <div>
            <p className="flex items-center gap-1 text-xs font-medium text-slate-600 mb-1.5">
              <HiOutlineBeaker className="w-3.5 h-3.5 text-violet-600" />
              Receta del doctor — marca lo que va a comprar
            </p>
            <div className="rounded-lg bg-violet-50/60 border border-violet-100 p-2 space-y-1 max-h-52 overflow-y-auto">
              {prescribedItems.map((item) => {
                const key = itemKey(item);
                const checked = selected.has(key);
                return (
                  <label
                    key={key}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors ${
                      checked
                        ? 'border-violet-500 bg-white ring-2 ring-violet-200'
                        : 'border-violet-200 bg-white hover:border-violet-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePrescription(item)}
                      className="w-4 h-4 accent-violet-600 cursor-pointer shrink-0"
                    />
                    <span className="text-sm text-slate-800 min-w-0 truncate flex-1">
                      {item.name}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-slate-600 mb-1.5">
            Añadir un producto adicional
          </p>
          <ProductAutocomplete
            key={pickerKey}
            products={products}
            value=""
            onSelect={addProduct}
            placeholder="Buscar en el catálogo…"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Puedes añadir productos aunque no estén en la receta.
          </p>
        </div>

        {additionalItems.length > 0 && (
          <div className="space-y-1.5">
            {additionalItems.map((item) => (
              <div
                key={item.product}
                className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-2"
              >
                <span className="min-w-0 flex-1 text-sm text-slate-800 truncate">
                  {item.name}
                  <span className="ml-1.5 text-xs text-slate-500">
                    ${Number(item.price).toFixed(2)} c/u
                  </span>
                </span>
                <div className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden shrink-0">
                  <button
                    type="button"
                    title="Restar uno"
                    onClick={() => changeQuantity(item.product, item.quantity - 1)}
                    className="p-1.5 border-none bg-white text-slate-500 hover:bg-slate-50 cursor-pointer"
                  >
                    <HiOutlineMinus className="w-3.5 h-3.5" />
                  </button>
                  <input
                    type="number"
                    min="1"
                    max="9999"
                    value={item.quantity}
                    onChange={(event) => changeQuantity(item.product, event.target.value)}
                    className="w-12 py-1 text-center text-xs border-y-0 border-x border-slate-200 outline-none"
                    aria-label={`Cantidad de ${item.name}`}
                  />
                  <button
                    type="button"
                    title="Sumar uno"
                    onClick={() => changeQuantity(item.product, item.quantity + 1)}
                    className="p-1.5 border-none bg-white text-slate-500 hover:bg-slate-50 cursor-pointer"
                  >
                    <HiOutlinePlus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  title={`Quitar ${item.name}`}
                  onClick={() => removeProduct(item.product)}
                  className="p-1 text-slate-400 hover:text-red-600 border-none bg-transparent cursor-pointer shrink-0"
                >
                  <HiOutlineTrash className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">
              Valor total de los productos
            </span>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={itemsValue}
                onChange={(event) => setItemsValue(event.target.value)}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500 bg-slate-50/50"
              />
            </div>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">
              ¿Cómo pagó los productos?
            </span>
            <select
              value={itemsMethod}
              onChange={(event) => setItemsMethod(event.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
            >
              <option value="">No se indicó</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-[11px] text-slate-400 m-0">
          Al guardar, la compra pasa a Observaciones del paciente y este formulario queda limpio.
        </p>
      </div>
    </div>
  );
}
