import { useState, useEffect } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import NumericInput from './NumericInput';
import SearchableSelect from './SearchableSelect';
import { HiOutlineTrash } from 'react-icons/hi2';
import { PRODUCT_TYPES } from '../constants/productCategories';

const types = PRODUCT_TYPES;

const emptyProduct = {
  code: '', name: '', description: '', category: 'insumo', categoria: '', inventoryCategory: '',
  // `salePrices` es la lista; `salePrice` (el activo) lo deriva el backend de ella.
  salePrices: [{ name: 'General', price: '', active: true }],
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
    category: p.category, categoria: p.categoria || '',
    inventoryCategory: p.inventoryCategory?._id || p.inventoryCategory || '',
    purchasePrice: String(p.purchasePrice),
    // Productos anteriores a la lista de precios: se sintetiza una entrada con su precio único,
    // para que el formulario tenga siempre algo que mostrar y editar.
    salePrices: (p.salePrices || []).length
      ? p.salePrices.map((s) => ({ name: s.name || 'General', price: String(s.price ?? ''), active: !!s.active }))
      : [{ name: 'General', price: String(p.salePrice ?? ''), active: true }],
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
  // Catálogo propio para los selectores internos (servicios/insumos/componentes).
  // Se trae SIEMPRE completo, sin filtros, de modo que el buscador del modal sea
  // independiente del buscador de la página que lo abre (p. ej. el filtro del
  // inventario). El prop `products` solo se usa como fallback mientras carga.
  const [catalog, setCatalog] = useState([]);
  // Categorías contables de inventario (fuente principal para productos físicos).
  const [invCategories, setInvCategories] = useState([]);

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

  // Trae el catálogo completo cada vez que se abre el modal, sin heredar el
  // filtro del padre. Así los selectores muestran todos los productos.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.get('/products')
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.products || []);
        setCatalog(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  // Categorías contables (INVENTARIO para insumos, SERVICIO para servicios). Se cargan todas y
  // se filtran por clase según el tipo de producto.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.get('/inventory-advanced/categories')
      .then((r) => { if (!cancelled) setInvCategories((r.data || []).filter((c) => c.active !== false)); })
      .catch(() => { if (!cancelled) setInvCategories([]); });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Lista base para los selectores: catálogo completo; cae al prop mientras carga.
  const pickerProducts = catalog.length ? catalog : products;

  const isInsumo = productForm.category === 'insumo';
  const isService = productForm.category === 'servicio';
  const inventarioCats = invCategories.filter((c) => c.kind === 'INVENTARIO');
  const servicioCats = invCategories.filter((c) => c.kind === 'SERVICIO');
  const selectedCat = invCategories.find((c) => c._id === productForm.inventoryCategory) || null;
  const acctLabel = (a) => (a && (a.code || a.name) ? `${a.code || ''} ${a.name || ''}`.trim() : null);
  // Producto legacy: insumo existente con `categoria` de texto pero sin categoría contable.
  const legacyNoCategory = !!editingId && isInsumo && !productForm.inventoryCategory && !!productForm.categoria;

  const handleProductSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Un servicio (o programa) se considera ilimitado: no maneja stock físico.
      const unlimited = isService || productForm.category === 'programa';
      // Al CREAR un insumo se exige categoría contable; al editar un producto legacy
      // se permite guardar (solo se muestra la advertencia) para no romper flujos.
      if (!editingId && !unlimited && !productForm.inventoryCategory) {
        toast.error('Seleccione una categoría contable de inventario para el insumo.');
        return; // el finally restablece saving
      }
      // La categoría contable es la fuente de cuentas: para insumos físicos (INVENTARIO) y
      // también para SERVICIOS (categoría de clase SERVICIO, que aporta la cuenta de ingreso).
      // Los programas y demás ilimitados no llevan categoría.
      const inventoryCategory = (!unlimited || isService) ? (productForm.inventoryCategory || null) : null;
      // Lista de precios: solo filas con importe válido. El backend normaliza (un único activo)
      // y deja `salePrice` sincronizado con él, que es lo que lee el resto del sistema.
      const salePrices = (productForm.salePrices || [])
        .map((s) => ({ name: String(s.name || '').trim() || 'General', price: parseFloat(s.price), active: !!s.active }))
        .filter((s) => Number.isFinite(s.price) && s.price >= 0);
      if (!salePrices.length) {
        toast.error('Ingresa al menos un precio de venta.');
        return; // el finally restablece saving
      }
      if (!salePrices.some((s) => s.active)) salePrices[0].active = true;
      const activo = salePrices.find((s) => s.active);
      const data = {
        ...productForm,
        inventoryCategory,
        categoria: unlimited ? '' : (productForm.categoria || ''),
        // Código vacío → el backend lo genera automáticamente.
        code: autoCode ? '' : (productForm.code || '').trim(),
        // El costo NO se digita: lo fija la compra (kardex). Se conserva el valor previo.
        purchasePrice: isService ? 0 : (parseFloat(productForm.purchasePrice) || 0),
        salePrices,
        salePrice: activo.price,
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
          {isInsumo ? (
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Categoría contable <span className="text-rose-500">*</span>
              </label>
              <SearchableSelect
                options={inventarioCats}
                value={productForm.inventoryCategory}
                onChange={(v) => setProductForm({ ...productForm, inventoryCategory: v })}
                getLabel={(c) => `${c.code ? c.code + ' - ' : ''}${c.name}`}
                getValue={(c) => c._id}
                getSearchText={(c) => `${c.code || ''} ${c.name}`}
                placeholder="— Seleccione una categoría de inventario —"
                searchPlaceholder="Buscar categoría contable…"
                allowClear
              />
              {inventarioCats.length === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">
                  No hay categorías de inventario configuradas. Créalas en <strong>Contabilidad → Categorías de Inventario</strong>.
                </p>
              )}
              {selectedCat && (
                <div className="mt-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-0.5">
                  <p>Inventario/Activo: <span className="font-mono text-slate-700">{acctLabel(selectedCat.assetAccount) || '— sin configurar —'}</span></p>
                  <p>Costo/Gasto: <span className="font-mono text-slate-700">{acctLabel(selectedCat.expenseAccount) || '— sin configurar —'}</span></p>
                  <p>Ingreso por venta: <span className="font-mono text-slate-700">{acctLabel(selectedCat.incomeAccount) || '— sin configurar —'}</span></p>
                </div>
              )}
              {selectedCat && !selectedCat.assetAccount && (
                <p className="text-[11px] text-rose-600 mt-1 font-medium">⚠ La categoría no tiene cuenta de inventario configurada.</p>
              )}
              {selectedCat && (!selectedCat.expenseAccount || !selectedCat.incomeAccount) && (
                <p className="text-[11px] text-amber-600 mt-1">
                  La categoría no tiene {(!selectedCat.expenseAccount && !selectedCat.incomeAccount) ? 'cuenta de costo ni de ingreso' : (!selectedCat.expenseAccount ? 'cuenta de costo/gasto' : 'cuenta de ingreso')} configurada.
                </p>
              )}
              {legacyNoCategory && (
                <p className="text-[11px] text-amber-700 mt-1 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                  ⚠ Categoría antigua sin configuración contable{productForm.categoria ? ` ("${productForm.categoria}")` : ''}. Debe asignarse una categoría contable.
                </p>
              )}
            </div>
          ) : isService ? (
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Categoría contable de servicio</label>
              <SearchableSelect
                options={servicioCats}
                value={productForm.inventoryCategory}
                onChange={(v) => setProductForm({ ...productForm, inventoryCategory: v })}
                getLabel={(c) => `${c.code ? c.code + ' - ' : ''}${c.name}`}
                getValue={(c) => c._id}
                getSearchText={(c) => `${c.code || ''} ${c.name}`}
                placeholder="— Sin categoría (usa la cuenta genérica de ingreso) —"
                searchPlaceholder="Buscar categoría de servicio…"
                allowClear
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Opcional. Si eliges una categoría de servicio, el ingreso de la venta se contabilizará en la cuenta de ingreso de esa categoría; si no, va a la cuenta genérica de ingresos por servicios.
              </p>
              {servicioCats.length === 0 && (
                <p className="text-[11px] text-amber-600 mt-1">
                  No hay categorías de servicio configuradas. Créalas en <strong>Contabilidad → Categorías de Inventario</strong> (clase «Servicio»).
                </p>
              )}
              {selectedCat && (
                <div className="mt-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2">
                  <p>Ingreso por venta: <span className="font-mono text-slate-700">{acctLabel(selectedCat.incomeAccount) || '— sin configurar —'}</span></p>
                </div>
              )}
            </div>
          ) : null}
          {/* Servicios y programas NO llevan categoría (ni comercial ni contable):
              las categorías son solo para insumos físicos de inventario. */}
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombre *</label>
            <input value={productForm.name} onChange={(e) => setProductForm({...productForm, name: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Descripción</label>
            <input value={productForm.description} onChange={(e) => setProductForm({...productForm, description: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          {/* PRECIO DE COMPRA: ya no se captura. El costo real lo fija la factura de compra
              (capas FIFO del kardex); tecleado a mano quedaba obsoleto y no se usaba para nada
              contable. En edición se muestra el costo promedio, solo informativo. */}
          <div className="sm:col-span-2">
            <SalePriceList
              rows={productForm.salePrices}
              onChange={(rows) => setProductForm({ ...productForm, salePrices: rows })}
            />
          </div>
          {editingId && productForm.category !== 'servicio' && (
            <div className="sm:col-span-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5">
              Costo promedio actual (calculado por el kardex desde las compras):{' '}
              <b className="font-mono text-slate-700">${Number(editingProduct?.averageCost || 0).toFixed(2)}</b>. El costo no se digita: lo fija la factura de compra.
            </div>
          )}
          {productForm.category !== 'servicio' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Stock actual</label>
                {editingId ? (
                  // En edición el stock es SOLO LECTURA: lo fijan las compras, las ventas, los
                  // movimientos de inventario y las tomas físicas. Digitarlo aquí pisaba el
                  // kardex sin dejar rastro de por qué cambió.
                  <>
                    <div className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-100 text-slate-600 font-mono">
                      {Number(productForm.stock || 0)}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      No se edita aquí. Para ajustarlo usa <b>Movimiento</b> en Inventario o una <b>toma física</b>: así queda registrado el motivo.
                    </p>
                  </>
                ) : (
                  <>
                    <NumericInput value={productForm.stock} onChange={(e) => setProductForm({...productForm, stock: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
                    <p className="text-[11px] text-slate-500 mt-1">Saldo inicial. Después solo cambia por compras, ventas, movimientos o tomas físicas.</p>
                  </>
                )}
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
                  <div className="col-span-8">
                    <SearchableSelect
                      options={pickerProducts.filter((p) => p._id !== editingId && (p.category === 'servicio' || p.unlimited))}
                      value={row.product}
                      onChange={(v) => {
                        const arr = [...productForm.programServices];
                        arr[idx] = { ...arr[idx], product: v };
                        setProductForm({ ...productForm, programServices: arr });
                      }}
                      placeholder="— Seleccionar servicio —"
                      searchPlaceholder="Buscar servicio por nombre…"
                      size="sm"
                    />
                  </div>
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
                products={pickerProducts.filter((p) => p._id !== editingId && p.category !== 'servicio' && p.category !== 'programa')}
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
                products={pickerProducts.filter((p) => p._id !== editingId && !p.isComposite)}
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
                {editingId
                  ? 'Solo lectura: el stock de cada sucursal lo mueven las compras, las ventas, los traslados y las tomas físicas.'
                  : 'Saldo inicial por sucursal. El inventario general es la suma del stock de todas las clínicas.'}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {clinicsList.map((c) => {
                  const row = (productForm.stockByClinic || []).find((s) => s.clinic === c._id);
                  return (
                    <div key={c._id} className="flex items-center gap-2">
                      <span className="text-sm text-slate-700 flex-1 truncate">{c.nombreComercial || c.name}</span>
                      {editingId ? (
                        <span className="w-24 px-2 py-1.5 border border-slate-200 rounded text-sm bg-slate-100 text-slate-600 font-mono text-right">
                          {Number(row?.stock || 0)}
                        </span>
                      ) : (
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
                      )}
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

/**
 * LISTA DE PRECIOS DE VENTA. Un mismo producto se cobra distinto según el canal (público,
 * corporativo, promoción, convenio…). El precio marcado con el check es el ACTIVO: el que se
 * propone por defecto al vender; en el modal de venta se puede escoger otro de esta lista.
 *
 * El check se comporta como un radio (solo uno activo): es la invariante que mantiene el
 * backend, así que la UI no debe permitir un estado que el servidor va a corregir por su
 * cuenta —el usuario vería un precio distinto al que guardó—.
 */
function SalePriceList({ rows, onChange }) {
  const list = rows?.length ? rows : [{ name: 'General', price: '', active: true }];
  const set = (idx, patch) => onChange(list.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const setActive = (idx) => onChange(list.map((r, i) => ({ ...r, active: i === idx })));
  const add = () => onChange([...list, { name: '', price: '', active: false }]);
  const remove = (idx) => {
    const next = list.filter((_, i) => i !== idx);
    if (!next.length) return onChange([{ name: 'General', price: '', active: true }]);
    // Si se borró el activo, el primero pasa a serlo (nunca queda la lista sin precio activo).
    if (!next.some((r) => r.active)) next[0] = { ...next[0], active: true };
    onChange(next);
  };

  return (
    <div className="border border-emerald-200 bg-emerald-50/50 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-800">Precios de venta *</p>
          <p className="text-[11px] text-slate-500">Marca con el check cuál es el precio activo (el que se cobra por defecto). Al vender se puede escoger otro de esta lista.</p>
        </div>
        <button type="button" onClick={add} className="text-xs px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg border-none cursor-pointer shrink-0">+ Agregar precio</button>
      </div>
      <div className="space-y-1.5">
        {list.map((row, idx) => (
          <div key={idx} className="flex items-center gap-2 bg-white rounded-lg border border-slate-200 px-2 py-1.5">
            <input
              type="radio"
              name="activeSalePrice"
              checked={!!row.active}
              onChange={() => setActive(idx)}
              title="Precio activo (el que se cobra por defecto)"
              className="w-4 h-4 accent-emerald-600 cursor-pointer shrink-0"
            />
            <input
              value={row.name}
              onChange={(e) => set(idx, { name: e.target.value })}
              placeholder="Nombre (Ej: General, Corporativo, Promoción)"
              className="flex-1 min-w-0 px-2 py-1.5 border border-slate-200 rounded text-sm bg-white"
            />
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-slate-400 text-sm">$</span>
              <NumericInput
                step="0.01" min="0"
                value={row.price}
                onChange={(e) => set(idx, { price: e.target.value })}
                required={idx === 0}
                className="w-28 px-2 py-1.5 border border-slate-200 rounded text-sm text-right bg-white"
              />
            </div>
            {row.active && <span className="text-[10px] uppercase font-semibold text-emerald-700 shrink-0">Activo</span>}
            <button
              type="button"
              onClick={() => remove(idx)}
              disabled={list.length === 1}
              title={list.length === 1 ? 'Debe existir al menos un precio' : 'Quitar precio'}
              className="text-rose-600 disabled:text-slate-300 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer p-1 shrink-0"
            ><HiOutlineTrash className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </div>
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
