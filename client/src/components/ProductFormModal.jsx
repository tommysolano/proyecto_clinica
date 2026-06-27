import { useState, useEffect } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import NumericInput from './NumericInput';
import SearchableSelect from './SearchableSelect';
import { HiOutlineTrash } from 'react-icons/hi2';
import { PRODUCT_TYPES, PRODUCT_CATEGORIES } from '../constants/productCategories';

const types = PRODUCT_TYPES;

const emptyProduct = {
  code: '', name: '', description: '', category: 'insumo', categoria: '',
  purchasePrice: '', salePrice: '', stock: '', minStock: '5', unit: 'unidad', taxRate: '15',
  maxAppointmentsPerDay: '0',
  excludeFromFirstVisit: false,
  nursingService: false,
  deferredIncome: false,
  sessionsIncluded: '',
  programServices: [],
  serviceItems: [],
  isComposite: false,
  components: [],
  availableInClinics: [],
  stockByClinic: [],
};

// Convierte un producto existente al shape del formulario (campos numéricos como string).
function mapProductToForm(p) {
  return {
    code: p.code, name: p.name, description: p.description || '',
    category: p.category, categoria: p.categoria || '', purchasePrice: String(p.purchasePrice),
    salePrice: String(p.salePrice), stock: String(p.stock),
    minStock: String(p.minStock), unit: p.unit, taxRate: String(p.taxRate),
    maxAppointmentsPerDay: String(p.maxAppointmentsPerDay ?? 0),
    excludeFromFirstVisit: !!p.excludeFromFirstVisit,
    nursingService: !!p.nursingService,
    deferredIncome: !!p.deferredIncome,
    sessionsIncluded: p.sessionsIncluded ? String(p.sessionsIncluded) : '',
    programServices: (p.programServices || []).map((s) => ({
      product: s.product?._id || s.product || '',
      quantity: s.quantity || 1,
    })),
    serviceItems: (p.serviceItems || []).map((s) => ({
      product: s.product?._id || s.product || '',
      quantity: s.quantity || 1,
    })),
    isComposite: !!p.isComposite,
    components: (p.components || []).map((s) => ({
      product: s.product?._id || s.product || '',
      quantity: s.quantity || 1,
    })),
    availableInClinics: (p.availableInClinics || []).map((c) => c?._id || c).filter(Boolean),
    stockByClinic: (p.stockByClinic || []).map((s) => ({
      clinic: s.clinic?._id || s.clinic || '',
      stock: s.stock ?? 0,
    })),
  };
}

// Normaliza valores de prefill para un producto NUEVO (campos numéricos a string).
function normalizeInitial(init) {
  if (!init) return {};
  const out = { ...init };
  ['purchasePrice', 'salePrice', 'stock', 'minStock', 'taxRate', 'sessionsIncluded', 'maxAppointmentsPerDay'].forEach((k) => {
    if (out[k] !== undefined && out[k] !== null) out[k] = String(out[k]);
  });
  return out;
}

/**
 * Modal de creación/edición de producto, con TODOS los campos del inventario.
 * Reutilizable: se usa en Inventario y en Compras (para crear un producto al vuelo
 * sin salir de la factura), garantizando que el alta sea consistente en todo el sistema.
 *
 * Props:
 *  - isOpen, onClose
 *  - onSaved(product): se llama tras guardar (el padre refresca/selecciona y cierra)
 *  - editingProduct: objeto producto a editar (null = nuevo)
 *  - initialValues: prefill para producto nuevo (p.ej. { name, purchasePrice } desde una compra)
 *  - products: catálogo existente (para selectores de servicios/componentes/programa)
 *  - clinicsList: clínicas (stock por sucursal y disponibilidad)
 */
export default function ProductFormModal({
  isOpen,
  onClose,
  onSaved,
  editingProduct = null,
  initialValues = null,
  products = [],
  clinicsList = [],
}) {
  const editingId = editingProduct?._id || null;
  const [productForm, setProductForm] = useState(emptyProduct);
  const [saving, setSaving] = useState(false);
  const [autoCode, setAutoCode] = useState(true);
  const [nextCodePreview, setNextCodePreview] = useState('');

  const fetchNextCode = async () => {
    try {
      const res = await api.get('/products/next-code');
      setNextCodePreview(res.data?.code || '');
    } catch { setNextCodePreview(''); }
  };

  // Inicializa el formulario cada vez que se abre el modal.
  useEffect(() => {
    if (!isOpen) return;
    if (editingProduct) {
      setAutoCode(false);
      setNextCodePreview('');
      setProductForm(mapProductToForm(editingProduct));
    } else {
      setAutoCode(true);
      setNextCodePreview('');
      setProductForm({ ...emptyProduct, ...normalizeInitial(initialValues) });
      fetchNextCode();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleProductSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const isService = productForm.category === 'servicio';
      // Un servicio (o programa) se considera ilimitado: no maneja stock físico.
      const unlimited = isService || productForm.category === 'programa';
      const data = {
        ...productForm,
        // Código vacío → el backend lo genera automáticamente.
        code: autoCode ? '' : (productForm.code || '').trim(),
        purchasePrice: isService ? 0 : parseFloat(productForm.purchasePrice) || 0,
        salePrice: parseFloat(productForm.salePrice),
        stock: isService ? 0 : parseInt(productForm.stock) || 0,
        minStock: isService ? 0 : parseInt(productForm.minStock) || 5,
        unit: isService ? 'servicio' : productForm.unit,
        // IMPORTANTE: no usar `|| 15` aquí. parseFloat('0') es 0 (falsy) y volvería
        // a poner 15, descartando el IVA cero que el usuario eligió. Solo caemos a 15
        // si el campo quedó vacío o no es numérico.
        taxRate: Number.isFinite(parseFloat(productForm.taxRate)) ? parseFloat(productForm.taxRate) : 15,
        unlimited,
        maxAppointmentsPerDay: parseInt(productForm.maxAppointmentsPerDay) || 0,
        excludeFromFirstVisit: !!productForm.excludeFromFirstVisit,
        nursingService: !!productForm.nursingService,
        deferredIncome: productForm.category === 'programa' ? !!productForm.deferredIncome : false,
        sessionsIncluded: productForm.category === 'programa' ? (parseInt(productForm.sessionsIncluded) || 0) : 0,
        programServices: (productForm.programServices || [])
          .filter((s) => s.product && Number(s.quantity) > 0)
          .map((s) => ({ product: s.product, quantity: parseInt(s.quantity) || 1 })),
        serviceItems: isService
          ? (productForm.serviceItems || [])
              .filter((s) => s.product)
              .map((s) => ({ product: s.product, quantity: parseInt(s.quantity) || 1 }))
          : [],
        isComposite: !isService && !!productForm.isComposite,
        components: !isService && productForm.isComposite
          ? (productForm.components || [])
              .filter((s) => s.product)
              .map((s) => ({ product: s.product, quantity: parseInt(s.quantity) || 1 }))
          : [],
        availableInClinics: productForm.availableInClinics || [],
        stockByClinic: isService
          ? []
          : (productForm.stockByClinic || [])
              .filter((s) => s.clinic)
              .map((s) => ({ clinic: s.clinic, stock: parseInt(s.stock) || 0 })),
      };
      let saved;
      if (editingId) {
        const res = await api.put(`/products/${editingId}`, data);
        saved = res.data;
        toast.success('Producto actualizado');
      } else {
        const res = await api.post('/products', data);
        saved = res.data;
        toast.success(`Producto creado${saved?.code ? ` (código ${saved.code})` : ''}`);
      }
      onSaved?.(saved);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editingId ? 'Editar Producto' : 'Nuevo Producto'} size="lg">
      <form onSubmit={handleProductSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Código {!autoCode && '*'}</label>
            <input
              name="code"
              value={autoCode ? '' : productForm.code}
              onChange={(e) => setProductForm({ ...productForm, code: e.target.value })}
              required={!autoCode}
              disabled={autoCode}
              placeholder={autoCode ? (nextCodePreview ? `Automático: ${nextCodePreview}` : 'Se generará automáticamente') : 'Ej: P00001'}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed"
            />
            {!editingId && (
              <label className="flex items-center gap-2 mt-1.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCode}
                  onChange={(e) => {
                    setAutoCode(e.target.checked);
                    if (e.target.checked && !nextCodePreview) fetchNextCode();
                  }}
                  className="w-3.5 h-3.5 accent-emerald-600 cursor-pointer"
                />
                Generar código automáticamente
              </label>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo</label>
            <select value={productForm.category} onChange={(e) => {
              const category = e.target.value;
              // Servicios y programas no llevan IVA: al elegir ese tipo se pone
              // el IVA en 0 automáticamente (el usuario aún puede editarlo después).
              const isExempt = category === 'servicio' || category === 'programa';
              setProductForm((prev) => ({
                ...prev,
                category,
                taxRate: isExempt ? '0' : prev.taxRate,
              }));
            }} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
              {Object.entries(types).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Categoría</label>
            <SearchableSelect
              options={PRODUCT_CATEGORIES}
              value={productForm.categoria}
              onChange={(v) => setProductForm({ ...productForm, categoria: v })}
              getLabel={(o) => o}
              getValue={(o) => o}
              placeholder="— Sin categoría —"
              searchPlaceholder="Buscar categoría…"
              allowClear
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre *</label>
            <input value={productForm.name} onChange={(e) => setProductForm({...productForm, name: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Descripción</label>
            <input value={productForm.description} onChange={(e) => setProductForm({...productForm, description: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          {productForm.category !== 'servicio' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Precio compra</label>
              <NumericInput step="0.01" value={productForm.purchasePrice} onChange={(e) => setProductForm({...productForm, purchasePrice: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Precio venta *</label>
            <NumericInput step="0.01" value={productForm.salePrice} onChange={(e) => setProductForm({...productForm, salePrice: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          {productForm.category !== 'servicio' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Stock actual</label>
                <NumericInput value={productForm.stock} onChange={(e) => setProductForm({...productForm, stock: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Stock mínimo</label>
                <NumericInput value={productForm.minStock} onChange={(e) => setProductForm({...productForm, minStock: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Unidad</label>
                <input value={productForm.unit} onChange={(e) => setProductForm({...productForm, unit: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">IVA %</label>
            <NumericInput min="0" step="0.01" value={productForm.taxRate} onChange={(e) => setProductForm({...productForm, taxRate: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            {(productForm.category === 'servicio' || productForm.category === 'programa') && (
              <p className="text-[11px] text-slate-400 mt-1">Los servicios y programas no llevan IVA (0 por defecto). Puedes editarlo si lo necesitas.</p>
            )}
          </div>
          {productForm.category === 'servicio' && (
            <div className="sm:col-span-2 bg-emerald-50 border border-emerald-200 rounded-xl p-2 text-xs text-emerald-700">
              Los servicios son <strong>ilimitados</strong>: no manejan stock, precio de compra ni unidad.
            </div>
          )}
          {productForm.category !== 'servicio' && productForm.category !== 'programa' && (
            <div className="sm:col-span-2 flex items-center gap-2 pt-2">
              <input
                id="isComposite"
                type="checkbox"
                checked={!!productForm.isComposite}
                onChange={(e) => setProductForm({ ...productForm, isComposite: e.target.checked })}
                className="w-4 h-4 accent-emerald-600 cursor-pointer"
              />
              <label htmlFor="isComposite" className="text-sm text-slate-700 cursor-pointer">
                Producto <strong>compuesto</strong> (formado por otros productos, ej. un suero con ampollas)
              </label>
            </div>
          )}
          {(productForm.category === 'servicio' || productForm.category === 'programa') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Cupo máximo de citas por horario</label>
              <NumericInput
                min="0"
                value={productForm.maxAppointmentsPerDay}
                onChange={(e) => setProductForm({ ...productForm, maxAppointmentsPerDay: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
              <p className="text-[11px] text-slate-400 mt-1">0 = sin límite. Es el máximo de citas que pueden coincidir en el mismo horario (hora de inicio).</p>
            </div>
          )}
          <div className="flex items-center gap-2 pt-7">
            <input
              id="excludeFromFirstVisit"
              type="checkbox"
              checked={!!productForm.excludeFromFirstVisit}
              onChange={(e) => setProductForm({ ...productForm, excludeFromFirstVisit: e.target.checked })}
              className="w-4 h-4 accent-emerald-600 cursor-pointer"
            />
            <label htmlFor="excludeFromFirstVisit" className="text-sm text-slate-700 cursor-pointer">
              <strong>No marcar paciente como nuevo</strong> al usar este servicio
            </label>
          </div>
          <div className="flex items-center gap-2 pt-7">
            <input
              id="nursingService"
              type="checkbox"
              checked={!!productForm.nursingService}
              onChange={(e) => setProductForm({ ...productForm, nursingService: e.target.checked })}
              className="w-4 h-4 accent-emerald-600 cursor-pointer"
            />
            <label htmlFor="nursingService" className="text-sm text-slate-700 cursor-pointer">
              Servicio atendido por <strong>enfermería</strong> (p.ej. sueroterapia)
            </label>
          </div>

          {/* Programa: ingreso diferido */}
          {productForm.category === 'programa' && (
            <div className="sm:col-span-2 bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-amber-900 cursor-pointer">
                <input type="checkbox" checked={!!productForm.deferredIncome}
                  onChange={(e) => setProductForm({ ...productForm, deferredIncome: e.target.checked })} />
                Ingreso diferido (reconocer por sesión)
              </label>
              <p className="text-xs text-amber-700">Si se activa, al vender el ingreso se acredita a “Ingresos diferidos” (pasivo) y se reconoce conforme se usan las sesiones. El IVA sí se reconoce al vender.</p>
              {productForm.deferredIncome && (
                <div>
                  <label className="block text-xs text-amber-800 mb-1">Sesiones incluidas en el paquete</label>
                  <NumericInput min="0" value={productForm.sessionsIncluded}
                    onChange={(e) => setProductForm({ ...productForm, sessionsIncluded: e.target.value })}
                    placeholder="Ej: 10"
                    className="w-40 px-3 py-2 border border-amber-300 rounded-xl text-sm bg-white" />
                </div>
              )}
            </div>
          )}

          {/* Programa: items incluidos */}
          {productForm.category === 'programa' && (
            <div className="sm:col-span-2 bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-purple-800">Servicios incluidos en el programa</p>
                <button
                  type="button"
                  onClick={() =>
                    setProductForm({
                      ...productForm,
                      programServices: [...(productForm.programServices || []), { product: '', quantity: 1 }],
                    })
                  }
                  className="text-xs px-2 py-1 bg-purple-600 text-white rounded border-none cursor-pointer"
                >+ Agregar</button>
              </div>
              {(productForm.programServices || []).length === 0 && (
                <p className="text-xs text-slate-500">Sin servicios. Agrega los servicios incluidos.</p>
              )}
              {(productForm.programServices || []).map((row, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={row.product}
                    onChange={(e) => {
                      const arr = [...productForm.programServices];
                      arr[idx] = { ...arr[idx], product: e.target.value };
                      setProductForm({ ...productForm, programServices: arr });
                    }}
                    className="col-span-8 px-2 py-1.5 border border-slate-200 rounded text-sm bg-white"
                  >
                    <option value="">— Seleccionar servicio —</option>
                    {products
                      .filter((p) => p._id !== editingId && (p.category === 'servicio' || p.unlimited))
                      .map((p) => (
                        <option key={p._id} value={p._id}>{p.name}</option>
                      ))}
                  </select>
                  <NumericInput
                    min={1}
                    value={row.quantity}
                    onChange={(e) => {
                      const arr = [...productForm.programServices];
                      arr[idx] = { ...arr[idx], quantity: e.target.value };
                      setProductForm({ ...productForm, programServices: arr });
                    }}
                    className="col-span-3 px-2 py-1.5 border border-slate-200 rounded text-sm bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const arr = (productForm.programServices || []).filter((_, i) => i !== idx);
                      setProductForm({ ...productForm, programServices: arr });
                    }}
                    className="col-span-1 text-rose-600 hover:bg-rose-50 rounded p-1 border-none bg-transparent cursor-pointer"
                  ><HiOutlineTrash className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}

          {/* Servicio: items/insumos relacionados */}
          {productForm.category === 'servicio' && (
            <div className="sm:col-span-2">
              <ProductItemPicker
                label="Items relacionados al servicio (insumos que se utilizan)"
                color="emerald"
                products={products.filter((p) => p._id !== editingId && p.category !== 'servicio' && p.category !== 'programa')}
                rows={productForm.serviceItems}
                onChange={(rows) => setProductForm({ ...productForm, serviceItems: rows })}
              />
            </div>
          )}

          {/* Producto compuesto: componentes posibles */}
          {productForm.category !== 'servicio' && productForm.category !== 'programa' && productForm.isComposite && (
            <div className="sm:col-span-2">
              <ProductItemPicker
                label="Componentes posibles (ej. ampollas que pueden ir en este suero)"
                color="amber"
                products={products.filter((p) => p._id !== editingId && !p.isComposite)}
                rows={productForm.components}
                onChange={(rows) => setProductForm({ ...productForm, components: rows })}
              />
            </div>
          )}

          {/* Stock por clínica (inventario por sucursal; el general es la suma) */}
          {productForm.category !== 'servicio' && clinicsList.length > 0 && (
            <div className="sm:col-span-2 bg-indigo-50 border border-indigo-200 rounded-xl p-3">
              <p className="text-sm font-semibold text-indigo-800 mb-1">Stock por clínica</p>
              <p className="text-xs text-slate-500 mb-2">
                El inventario general es la suma del stock de todas las clínicas.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {clinicsList.map((c) => {
                  const row = (productForm.stockByClinic || []).find((s) => s.clinic === c._id);
                  return (
                    <div key={c._id} className="flex items-center gap-2">
                      <span className="text-sm text-slate-700 flex-1 truncate">{c.nombreComercial || c.name}</span>
                      <NumericInput
                        min="0"
                        value={row?.stock ?? ''}
                        placeholder="0"
                        onChange={(e) => {
                          const arr = [...(productForm.stockByClinic || [])];
                          const idx = arr.findIndex((s) => s.clinic === c._id);
                          const val = e.target.value;
                          if (idx >= 0) arr[idx] = { ...arr[idx], stock: val };
                          else arr.push({ clinic: c._id, stock: val });
                          setProductForm({ ...productForm, stockByClinic: arr });
                        }}
                        className="w-24 px-2 py-1.5 border border-slate-200 rounded text-sm bg-white"
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-indigo-700 mt-2 font-medium">
                Total general:{' '}
                {(productForm.stockByClinic || []).reduce((a, s) => a + (parseInt(s.stock) || 0), 0)}
              </p>
            </div>
          )}

          {/* Disponibilidad por clínica (sucursal) */}
          {clinicsList.length > 1 && (
            <div className="sm:col-span-2 bg-sky-50 border border-sky-200 rounded-xl p-3">
              <p className="text-sm font-semibold text-sky-800 mb-2">
                Disponible solo en estas clínicas
              </p>
              <p className="text-xs text-slate-500 mb-2">
                Si no marcas ninguna, estará disponible en todas.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {clinicsList.map((c) => {
                  const checked = (productForm.availableInClinics || []).includes(c._id);
                  return (
                    <label key={c._id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const arr = new Set(productForm.availableInClinics || []);
                          if (e.target.checked) arr.add(c._id); else arr.delete(c._id);
                          setProductForm({ ...productForm, availableInClinics: Array.from(arr) });
                        }}
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <span>{c.nombreComercial || c.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors">Cancelar</button>
          <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50">
            {saving ? 'Guardando...' : editingId ? 'Actualizar' : 'Crear Producto'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Selector de productos con buscador, para items relacionados (servicio) y componentes (compuesto).
function ProductItemPicker({ label, products, rows, onChange, color = 'emerald' }) {
  const [query, setQuery] = useState('');
  const list = rows || [];
  const filtered = query.trim()
    ? products.filter((p) => {
        const q = query.trim().toLowerCase();
        return (
          String(p.name || '').toLowerCase().includes(q) ||
          String(p.code || '').toLowerCase().includes(q)
        );
      })
    : products;
  const addProduct = (id) => {
    if (!id || list.some((r) => r.product === id)) return;
    onChange([...list, { product: id, quantity: 1 }]);
    setQuery('');
  };
  const bg = color === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200';
  return (
    <div className={`${bg} border rounded-xl p-3 space-y-2`}>
      <p className="text-sm font-semibold text-slate-800">{label}</p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar producto por nombre o código..."
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
      />
      {query.trim() && (
        <div className="max-h-32 overflow-y-auto bg-white rounded-lg border border-slate-200">
          {filtered.length === 0 ? (
            <p className="text-xs text-slate-400 px-2 py-1">Sin resultados</p>
          ) : (
            filtered.slice(0, 30).map((p) => (
              <button
                key={p._id}
                type="button"
                onClick={() => addProduct(p._id)}
                className="w-full text-left px-2 py-1.5 text-sm hover:bg-emerald-50 bg-transparent border-none cursor-pointer flex justify-between"
              >
                <span>{p.name}</span>
                <span className="text-xs text-slate-400">{p.code}</span>
              </button>
            ))
          )}
        </div>
      )}
      {list.length === 0 && <p className="text-xs text-slate-500">Sin items seleccionados.</p>}
      {list.map((row, idx) => {
        const p = products.find((x) => x._id === row.product);
        return (
          <div key={row.product || idx} className="flex items-center gap-2 bg-white rounded-lg px-2 py-1.5 border border-slate-200">
            <span className="flex-1 text-sm text-slate-700">{p?.name || 'Producto'}</span>
            <NumericInput
              min={1}
              value={row.quantity}
              onChange={(e) => {
                const arr = [...list];
                arr[idx] = { ...arr[idx], quantity: e.target.value };
                onChange(arr);
              }}
              className="w-16 px-2 py-1 border border-slate-200 rounded text-sm"
              title="Cantidad"
            />
            <button
              type="button"
              onClick={() => onChange(list.filter((_, i) => i !== idx))}
              className="text-rose-600 bg-transparent border-none cursor-pointer p-1"
            >
              <HiOutlineTrash className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
