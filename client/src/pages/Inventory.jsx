import { useState, useEffect } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus, HiOutlinePencil, HiOutlineTrash,
  HiOutlineMagnifyingGlass, HiOutlineArrowDown, HiOutlineArrowUp,
  HiOutlineExclamationTriangle, HiOutlineCube, HiOutlineArrowDownTray,
} from 'react-icons/hi2';
import { fmtDateTime } from '../utils/date';

const categories = { medicamento: 'Medicamento', insumo: 'Insumo', servicio: 'Servicio', programa: 'Programa', otro: 'Otro' };
const emptyProduct = {
  code: '', name: '', description: '', category: 'otro',
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
const emptyMovement = { product: '', type: 'entrada', quantity: '', reason: '' };

export default function Inventory() {
  const { hasRole } = useAuth();
  const canWrite = hasRole('admin', 'contabilidad');
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [clinicsList, setClinicsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showLowStock, setShowLowStock] = useState(false);
  const [tab, setTab] = useState('products');

  // Product modal
  const [productModal, setProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState(emptyProduct);
  const [saving, setSaving] = useState(false);

  // Movement modal
  const [movementModal, setMovementModal] = useState(false);
  const [movementForm, setMovementForm] = useState(emptyMovement);

  // Bulk upload modal
  const [bulkModal, setBulkModal] = useState(false);
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkUploading, setBulkUploading] = useState(false);

  const downloadTemplate = async () => {
    try {
      await downloadFile('/inventory-advanced/template/products', { filename: 'plantilla_productos.xlsx' });
    } catch (err) { toast.error(err.message || 'Error al descargar plantilla'); }
  };

  const uploadBulk = async () => {
    if (!bulkFile) return;
    setBulkUploading(true); setBulkResult(null);
    try {
      const fd = new FormData();
      fd.append('file', bulkFile);
      const res = await api.post('/inventory-advanced/import/products-excel', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setBulkResult(res.data);
      toast.success(`${res.data.created} creados, ${res.data.updated} actualizados`);
      fetchProducts();
    } catch (e) { toast.error(e.response?.data?.message || 'Error al importar'); }
    finally { setBulkUploading(false); }
  };

  const fetchProducts = async () => {
    try {
      const res = await api.get('/products', {
        params: { search, category: categoryFilter, lowStock: showLowStock || undefined },
      });
      setProducts(res.data);
    } catch {
      toast.error('Error al cargar productos');
    } finally {
      setLoading(false);
    }
  };

  const fetchMovements = async () => {
    try {
      const res = await api.get('/inventory');
      setMovements(res.data);
    } catch {}
  };

  useEffect(() => { fetchProducts(); }, [search, categoryFilter, showLowStock]);
  useEffect(() => { if (tab === 'movements') fetchMovements(); }, [tab]);
  useEffect(() => {
    api.get('/clinics').then((r) => setClinicsList(r.data || [])).catch(() => {});
  }, []);

  // Product CRUD
  const openNewProduct = () => {
    setEditingProduct(null);
    setProductForm(emptyProduct);
    setProductModal(true);
  };

  const openEditProduct = (p) => {
    setEditingProduct(p._id);
    setProductForm({
      code: p.code, name: p.name, description: p.description || '',
      category: p.category, purchasePrice: String(p.purchasePrice),
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
    });
    setProductModal(true);
  };

  const handleProductSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const isService = productForm.category === 'servicio';
      // Un servicio (o programa) se considera ilimitado: no maneja stock físico.
      const unlimited = isService || productForm.category === 'programa';
      const data = {
        ...productForm,
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
      if (editingProduct) {
        await api.put(`/products/${editingProduct}`, data);
        toast.success('Producto actualizado');
      } else {
        await api.post('/products', data);
        toast.success('Producto creado');
      }
      setProductModal(false);
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProduct = async (id) => {
    if (!window.confirm('¿Eliminar este producto?')) return;
    try {
      await api.delete(`/products/${id}`);
      toast.success('Producto eliminado');
      fetchProducts();
    } catch {
      toast.error('Error al eliminar');
    }
  };

  // Movement
  const openNewMovement = (productId = '') => {
    setMovementForm({ ...emptyMovement, product: productId });
    setMovementModal(true);
  };

  const handleMovementSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/inventory', {
        ...movementForm,
        quantity: parseInt(movementForm.quantity),
      });
      toast.success('Movimiento registrado');
      setMovementModal(false);
      fetchProducts();
      if (tab === 'movements') fetchMovements();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al registrar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={HiOutlineCube} title="Inventario" subtitle="Gestión de productos y movimientos">
        {canWrite && (
          <>
            <button
              onClick={async () => {
                try {
                  await downloadFile('/reports/inventory.xlsx', { filename: `inventario_${Date.now()}.xlsx` });
                } catch (err) {
                  toast.error(err.message || 'Error al exportar');
                }
              }}
              className="btn-secondary"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            <button onClick={() => { setBulkResult(null); setBulkFile(null); setBulkModal(true); }} className="btn-secondary">
              Carga masiva
            </button>
            <button onClick={() => openNewMovement()} className="btn-secondary">
              <HiOutlineArrowDown className="w-4 h-4" /> Movimiento
            </button>
            <button onClick={openNewProduct} className="btn-primary">
              <HiOutlinePlus className="w-5 h-5" /> Nuevo Producto
            </button>
          </>
        )}
      </PageHeader>

      {/* Tabs */}
      <div className="flex gap-1 bg-emerald-50 rounded-xl p-1 w-fit">
        <button
          onClick={() => setTab('products')}
          className={`px-5 py-2.5 rounded-lg text-sm font-medium cursor-pointer border-none transition-colors ${
            tab === 'products' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-emerald-700 bg-transparent'
          }`}
        >
          Productos
        </button>
        <button
          onClick={() => setTab('movements')}
          className={`px-5 py-2.5 rounded-lg text-sm font-medium cursor-pointer border-none transition-colors ${
            tab === 'movements' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-emerald-700 bg-transparent'
          }`}
        >
          Movimientos
        </button>
      </div>

      {tab === 'products' && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 mb-6 p-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <HiOutlineMagnifyingGlass className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Buscar por nombre o código..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-11 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              >
                <option value="">Todas las categorías</option>
                {Object.entries(categories).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button
                onClick={() => setShowLowStock(!showLowStock)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border transition-colors ${
                  showLowStock
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-emerald-50'
                }`}
              >
                <HiOutlineExclamationTriangle className="w-4 h-4" />
                Stock bajo
              </button>
            </div>
          </div>

          {/* Products Table */}
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr className="bg-emerald-50/50 border-b border-emerald-100">
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Código</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Producto</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Categoría</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Precio</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Stock</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan="6" className="text-center py-10 text-slate-500">Cargando...</td></tr>
                  ) : products.length === 0 ? (
                    <tr><td colSpan="6"><EmptyState icon={HiOutlineCube} title="No se encontraron productos" hint="Ajusta la búsqueda o crea un nuevo producto." /></td></tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                        <td className="px-6 py-3.5 text-sm text-slate-600 font-mono">{p.code}</td>
                        <td className="px-6 py-3.5 text-sm font-medium text-slate-800">{p.name}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell capitalize">{categories[p.category]}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-800 text-right">${p.salePrice.toFixed(2)}</td>
                        <td className="px-6 py-3.5 text-right">
                          {p.unlimited ? (
                            <span className="text-sm font-medium text-emerald-600">∞</span>
                          ) : (
                            <>
                              <span className={`text-sm font-medium ${p.stock <= p.minStock ? 'text-red-500' : 'text-slate-800'}`}>
                                {p.stock}
                              </span>
                              {p.stock <= p.minStock && (
                                <HiOutlineExclamationTriangle className="inline-block w-4 h-4 text-amber-500 ml-1" />
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-right">
                          {canWrite && (
                            <>
                              <button onClick={() => openNewMovement(p._id)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors" title="Movimiento">
                                <HiOutlineArrowUp className="w-4 h-4" />
                              </button>
                              <button onClick={() => openEditProduct(p)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors">
                                <HiOutlinePencil className="w-4 h-4" />
                              </button>
                              <button onClick={() => handleDeleteProduct(p._id)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors">
                                <HiOutlineTrash className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {!canWrite && <span className="text-xs text-slate-400">—</span>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'movements' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr className="bg-emerald-50/50 border-b border-emerald-100">
                  <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Fecha</th>
                  <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Producto</th>
                  <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Tipo</th>
                  <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cantidad</th>
                  <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Razón</th>
                  <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Usuario</th>
                </tr>
              </thead>
              <tbody>
                {movements.length === 0 ? (
                  <tr><td colSpan="6"><EmptyState icon={HiOutlineArrowDown} title="No hay movimientos" hint="Los movimientos de inventario aparecerán aquí." /></td></tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                      <td className="px-6 py-3 text-sm text-slate-600">{fmtDateTime(m.createdAt)}</td>
                      <td className="px-6 py-3 text-sm font-medium text-slate-800">{m.product?.name}</td>
                      <td className="px-6 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          m.type === 'entrada' ? 'bg-emerald-100 text-emerald-700' :
                          m.type === 'salida' ? 'bg-red-100 text-red-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>
                          {m.type.charAt(0).toUpperCase() + m.type.slice(1)}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-sm text-right font-medium">{m.quantity}</td>
                      <td className="px-6 py-3 text-sm text-slate-600 hidden md:table-cell">{m.reason || '—'}</td>
                      <td className="px-6 py-3 text-sm text-slate-600 hidden md:table-cell">{m.createdBy?.name || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk upload Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Carga masiva de productos">
        <div className="space-y-4">
          <div className="bg-emerald-50 rounded-lg p-3 text-sm text-slate-600">
            <p className="font-semibold text-emerald-800 mb-1">1. Descarga la plantilla</p>
            <p>Descarga el Excel, llénalo con tus productos (no borres los encabezados) y vuelve a subirlo aquí.</p>
            <button onClick={downloadTemplate} className="mt-2 px-3 py-1.5 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">Descargar plantilla Excel</button>
          </div>
          <div>
            <p className="font-semibold text-slate-700 mb-1 text-sm">2. Sube el archivo lleno</p>
            <input type="file" accept=".xlsx,.xls" onChange={(e) => setBulkFile(e.target.files[0])} className="block w-full text-sm border border-slate-200 rounded-lg p-2" />
          </div>
          {bulkResult && (
            <div className="text-sm bg-slate-50 rounded-lg p-3">
              <p className="text-emerald-700 font-semibold">{bulkResult.created} creados · {bulkResult.updated} actualizados</p>
              {bulkResult.errors?.length > 0 && <ul className="text-rose-600 text-xs mt-1 list-disc pl-4">{bulkResult.errors.map((er, i) => <li key={i}>{er}</li>)}</ul>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setBulkModal(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cerrar</button>
            <button onClick={uploadBulk} disabled={!bulkFile || bulkUploading} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">{bulkUploading ? 'Subiendo...' : 'Importar'}</button>
          </div>
        </div>
      </Modal>

      {/* Product Modal */}
      <Modal isOpen={productModal} onClose={() => setProductModal(false)} title={editingProduct ? 'Editar Producto' : 'Nuevo Producto'} size="lg">
        <form onSubmit={handleProductSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Código *</label>
              <input name="code" value={productForm.code} onChange={(e) => setProductForm({...productForm, code: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Categoría</label>
              <select value={productForm.category} onChange={(e) => {
                const category = e.target.value;
                // Servicios y programas no llevan IVA: al elegir esa categoría se pone
                // el IVA en 0 automáticamente (el usuario aún puede editarlo después).
                const isExempt = category === 'servicio' || category === 'programa';
                setProductForm((prev) => ({
                  ...prev,
                  category,
                  taxRate: isExempt ? '0' : prev.taxRate,
                }));
              }} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                {Object.entries(categories).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
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
                <input type="number" step="0.01" value={productForm.purchasePrice} onChange={(e) => setProductForm({...productForm, purchasePrice: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Precio venta *</label>
              <input type="number" step="0.01" value={productForm.salePrice} onChange={(e) => setProductForm({...productForm, salePrice: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            {productForm.category !== 'servicio' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Stock actual</label>
                  <input type="number" value={productForm.stock} onChange={(e) => setProductForm({...productForm, stock: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Stock mínimo</label>
                  <input type="number" value={productForm.minStock} onChange={(e) => setProductForm({...productForm, minStock: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unidad</label>
                  <input value={productForm.unit} onChange={(e) => setProductForm({...productForm, unit: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">IVA %</label>
              <input type="number" min="0" step="0.01" value={productForm.taxRate} onChange={(e) => setProductForm({...productForm, taxRate: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
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
                <input
                  type="number"
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
                    <input type="number" min="0" value={productForm.sessionsIncluded}
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
                        .filter((p) => p._id !== editingProduct && (p.category === 'servicio' || p.unlimited))
                        .map((p) => (
                          <option key={p._id} value={p._id}>{p.name}</option>
                        ))}
                    </select>
                    <input
                      type="number"
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
                  products={products.filter((p) => p._id !== editingProduct && p.category !== 'servicio' && p.category !== 'programa')}
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
                  products={products.filter((p) => p._id !== editingProduct && !p.isComposite)}
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
                        <input
                          type="number"
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
            <button type="button" onClick={() => setProductModal(false)} className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors">Cancelar</button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50">
              {saving ? 'Guardando...' : editingProduct ? 'Actualizar' : 'Crear Producto'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Movement Modal */}
      <Modal isOpen={movementModal} onClose={() => setMovementModal(false)} title="Registrar Movimiento">
        <form onSubmit={handleMovementSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Producto *</label>
            <select value={movementForm.product} onChange={(e) => setMovementForm({...movementForm, product: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
              <option value="">Seleccionar</option>
              {products.map(p => (
                <option key={p._id} value={p._id}>{p.code} - {p.name} (Stock: {p.stock})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo *</label>
              <select value={movementForm.type} onChange={(e) => setMovementForm({...movementForm, type: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                <option value="entrada">Entrada</option>
                <option value="salida">Salida</option>
                <option value="ajuste">Ajuste</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Cantidad *</label>
              <input type="number" min="1" value={movementForm.quantity} onChange={(e) => setMovementForm({...movementForm, quantity: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Razón</label>
            <input value={movementForm.reason} onChange={(e) => setMovementForm({...movementForm, reason: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setMovementModal(false)} className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors">Cancelar</button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50">
              {saving ? 'Registrando...' : 'Registrar'}
            </button>
          </div>
        </form>
      </Modal>
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
            <input
              type="number"
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
