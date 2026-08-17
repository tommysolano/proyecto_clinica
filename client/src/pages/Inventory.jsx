import { useState, useEffect, useRef } from 'react';
import api from '../api/axios';
import useDebounce from '../hooks/useDebounce';
import { downloadFile } from '../utils/download';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import NumericInput from '../components/NumericInput';
import SearchableSelect from '../components/SearchableSelect';
import ProductSelect from '../components/ProductSelect';
import ProductFormModal from '../components/ProductFormModal';
import TransferStockModal from '../components/TransferStockModal';
import {
  HiOutlinePlus, HiOutlinePencil, HiOutlineTrash,
  HiOutlineMagnifyingGlass, HiOutlineArrowDown, HiOutlineArrowUp,
  HiOutlineExclamationTriangle, HiOutlineCube, HiOutlineArrowDownTray,
  HiOutlineArrowsRightLeft,
} from 'react-icons/hi2';
import { fmtDateTime } from '../utils/date';
import { PRODUCT_TYPES, PRODUCT_CATEGORIES } from '../constants/productCategories';
import DateInput from '../components/DateInput';

// Tipos de producto (en la UI: "Tipo").
const types = PRODUCT_TYPES;
const emptyMovement = { product: '', type: 'entrada', quantity: '', reason: '', warehouse: '' };

export default function Inventory() {
  const { hasRole } = useAuth();
  const canWrite = hasRole('admin', 'contabilidad');
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [transfers, setTransfers] = useState([]);
  // Carga propia de cada pestaña: el `loading` de arriba es solo el de productos.
  // Sin esto, Movimientos y Traslados afirman "No hay…" mientras aún consultan.
  const [movLoading, setMovLoading] = useState(true);
  const [trLoading, setTrLoading] = useState(true);
  const [clinicsList, setClinicsList] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  // Filtros del historial de traslados (el usuario pregunta "qué se movió y cuándo").
  const [trFilters, setTrFilters] = useState({ from: '', to: '', warehouse: '', q: '' });
  const [transferModal, setTransferModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [categoryFilter, setCategoryFilter] = useState(''); // filtro por tipo
  const [categoriaFilter, setCategoriaFilter] = useState(''); // filtro por categoría
  const [showLowStock, setShowLowStock] = useState(false);
  const [tab, setTab] = useState('products');

  // Product modal (formulario reutilizable)
  const [productModal, setProductModal] = useState(false);
  const [editingProductObj, setEditingProductObj] = useState(null);
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

  // Contador de peticiones: solo la respuesta de la última búsqueda actualiza
  // la lista. Evita que una respuesta antigua (fuera de orden) sobrescriba los
  // resultados con datos obsoletos, p. ej. "vuelve a mostrar todos".
  const reqRef = useRef(0);
  const fetchProducts = async () => {
    const reqId = ++reqRef.current;
    try {
      const res = await api.get('/products', {
        params: { search: debouncedSearch, category: categoryFilter, categoria: categoriaFilter, lowStock: showLowStock || undefined },
      });
      if (reqId !== reqRef.current) return; // respuesta obsoleta: descartar
      setProducts(res.data);
    } catch {
      if (reqId === reqRef.current) toast.error('Error al cargar productos');
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  };

  const fetchMovements = async () => {
    setMovLoading(true);
    try {
      const res = await api.get('/inventory');
      setMovements(res.data);
    } catch {
      toast.error('No se pudieron cargar los movimientos');
    } finally {
      setMovLoading(false);
    }
  };

  /** Historial de traslados: el servidor ya devuelve UNA fila por documento con sus productos. */
  const fetchTransfers = async () => {
    setTrLoading(true);
    try {
      const res = await api.get('/inventory-advanced/transfers', {
        params: {
          from: trFilters.from || undefined,
          to: trFilters.to || undefined,
          warehouse: trFilters.warehouse || undefined,
          q: trFilters.q || undefined,
        },
      });
      setTransfers(res.data || []);
    } catch {
      toast.error('No se pudieron cargar los traslados');
    } finally {
      setTrLoading(false);
    }
  };

  useEffect(() => { fetchProducts(); }, [debouncedSearch, categoryFilter, categoriaFilter, showLowStock]);
  useEffect(() => { if (tab === 'movements') fetchMovements(); }, [tab]);
  useEffect(() => { if (tab === 'transfers') fetchTransfers(); }, [tab, trFilters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.get('/clinics').then((r) => setClinicsList(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
  }, []);

  // Product CRUD
  const openNewProduct = () => {
    setEditingProductObj(null);
    setProductModal(true);
  };

  const openEditProduct = (p) => {
    setEditingProductObj(p);
    setProductModal(true);
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
    const mainWh = warehouses.find((w) => w.isMain) || warehouses[0];
    setMovementForm({ ...emptyMovement, product: productId, warehouse: mainWh?._id || '' });
    setMovementModal(true);
  };

  const handleMovementSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/inventory', {
        ...movementForm,
        warehouse: movementForm.warehouse || null,
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
              <HiOutlineArrowDown className="w-4 h-4" /> Entrada / salida
            </button>
            {warehouses.length >= 2 && (
              <button onClick={() => setTransferModal(true)} className="btn-secondary">
                <HiOutlineArrowsRightLeft className="w-4 h-4" /> Traslado entre bodegas
              </button>
            )}
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
        <button
          onClick={() => setTab('transfers')}
          className={`px-5 py-2.5 rounded-lg text-sm font-medium cursor-pointer border-none transition-colors ${
            tab === 'transfers' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-emerald-700 bg-transparent'
          }`}
        >
          Traslados entre bodegas
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
                <option value="">Todos los tipos</option>
                {Object.entries(types).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <div className="w-full sm:w-56">
                <SearchableSelect
                  options={PRODUCT_CATEGORIES}
                  value={categoriaFilter}
                  onChange={(v) => setCategoriaFilter(v)}
                  getLabel={(o) => o}
                  getValue={(o) => o}
                  placeholder="Todas las categorías"
                  searchPlaceholder="Buscar categoría…"
                  allowClear
                />
              </div>
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
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Tipo</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden lg:table-cell">Categoría</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Precio</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Stock</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan="7" className="text-center py-10 text-slate-500">Cargando...</td></tr>
                  ) : products.length === 0 ? (
                    <tr><td colSpan="7"><EmptyState icon={HiOutlineCube} title="No se encontraron productos" hint="Ajusta la búsqueda o crea un nuevo producto." /></td></tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                        <td className="px-6 py-3.5 text-sm text-slate-600 font-mono">{p.code}</td>
                        <td className="px-6 py-3.5 text-sm font-medium text-slate-800">{p.name}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell capitalize">{types[p.category] || p.category}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-600 hidden lg:table-cell">{p.categoria || '—'}</td>
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
                {movLoading ? (
                  <tr><td colSpan="6" className="text-center py-10 text-slate-400 text-sm">Cargando movimientos…</td></tr>
                ) : movements.length === 0 ? (
                  <tr><td colSpan="6"><EmptyState icon={HiOutlineArrowDown} title="No hay movimientos" hint="Los movimientos de inventario aparecerán aquí." /></td></tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                      {/* La fecha que vale es la FUNCIONAL del movimiento (la del documento);
                          los registros viejos no la tienen y caen en la de grabación. */}
                      <td className="px-6 py-3 text-sm text-slate-600">{fmtDateTime(m.movementDate || m.createdAt)}</td>
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
                      <td className="px-6 py-3 text-sm text-slate-600 hidden md:table-cell">
                        {m.type === 'traslado'
                          ? `${m.warehouse?.name || '?'} → ${m.toWarehouse?.name || '?'}`
                          : (m.reason || (m.warehouse?.name ? `Bodega: ${m.warehouse.name}` : '—'))}
                      </td>
                      <td className="px-6 py-3 text-sm text-slate-600 hidden md:table-cell">{m.createdBy?.name || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Traslados entre bodegas: qué se movió, de dónde a dónde y cuándo */}
      {tab === 'transfers' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Desde</label>
                <DateInput value={trFilters.from} onChange={(e) => setTrFilters({ ...trFilters, from: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Hasta</label>
                <DateInput value={trFilters.to} onChange={(e) => setTrFilters({ ...trFilters, to: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Bodega (origen o destino)</label>
                <select value={trFilters.warehouse} onChange={(e) => setTrFilters({ ...trFilters, warehouse: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50">
                  <option value="">Todas</option>
                  {warehouses.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Buscar</label>
                <input placeholder="Producto, bodega o motivo…" value={trFilters.q} onChange={(e) => setTrFilters({ ...trFilters, q: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr className="bg-emerald-50/50 border-b border-emerald-100">
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Fecha</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Origen → Destino</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Productos</th>
                    <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Unidades</th>
                    <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Usuario</th>
                  </tr>
                </thead>
                <tbody>
                  {trLoading ? (
                    <tr><td colSpan="5" className="text-center py-10 text-slate-400 text-sm">Cargando traslados…</td></tr>
                  ) : transfers.length === 0 ? (
                    <tr><td colSpan="5"><EmptyState icon={HiOutlineArrowsRightLeft} title="Sin traslados" hint="Usa «Traslado entre bodegas» para mover uno o varios productos de una bodega a otra." /></td></tr>
                  ) : (
                    transfers.map((t) => (
                      <tr key={t._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors align-top">
                        <td className="px-6 py-3 text-sm text-slate-600 whitespace-nowrap">
                          {new Date(t.date).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' })}
                          <div className="text-[10px] text-slate-400">{t.reference}</div>
                        </td>
                        <td className="px-6 py-3 text-sm text-slate-700 whitespace-nowrap">
                          {t.fromWarehouse?.name || '—'} <span className="text-slate-400">→</span> {t.toWarehouse?.name || '—'}
                        </td>
                        <td className="px-6 py-3 text-sm text-slate-700">
                          {t.items.map((it) => (
                            <div key={String(it.movementId)} className="flex gap-2">
                              <span>{it.product?.name || '—'}</span>
                              <span className="text-slate-400 font-mono">×{it.quantity}</span>
                            </div>
                          ))}
                          {t.reason && <div className="text-[11px] text-slate-400 italic mt-0.5">{t.reason}</div>}
                        </td>
                        <td className="px-6 py-3 text-sm text-right font-medium whitespace-nowrap">{t.totalQty}</td>
                        <td className="px-6 py-3 text-sm text-slate-600 hidden md:table-cell whitespace-nowrap">{t.createdBy?.name || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
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

      {/* Traslado entre bodegas (uno o varios productos en el mismo documento) */}
      <TransferStockModal
        isOpen={transferModal}
        onClose={() => setTransferModal(false)}
        onDone={() => { fetchProducts(); if (tab === 'transfers') fetchTransfers(); if (tab === 'movements') fetchMovements(); }}
        warehouses={warehouses}
        products={products}
        costCenters={costCenters}
      />

      {/* Product Modal (formulario completo reutilizable) */}
      <ProductFormModal
        isOpen={productModal}
        onClose={() => setProductModal(false)}
        editingProduct={editingProductObj}
        products={products}
        clinicsList={clinicsList}
        onSaved={() => { setProductModal(false); fetchProducts(); }}
      />

      {/* Movement Modal */}
      <Modal isOpen={movementModal} onClose={() => setMovementModal(false)} title="Registrar Movimiento">
        <form onSubmit={handleMovementSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Producto *</label>
            <ProductSelect products={products} value={movementForm.product} onChange={(v) => setMovementForm({ ...movementForm, product: v })} placeholder="Seleccionar" required />
          </div>
          {warehouses.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Bodega</label>
              <SearchableSelect
                options={[{ _id: '', name: 'Sin bodega (general)' }, ...warehouses]}
                value={movementForm.warehouse}
                onChange={(v) => setMovementForm({ ...movementForm, warehouse: v })}
                getLabel={(w) => (w.code ? `${w.code} - ${w.name}` : w.name)}
                getSearchText={(w) => `${w.code || ''} ${w.name || ''}`}
                placeholder="Sin bodega (general)"
                searchPlaceholder="Buscar bodega…"
                menuMinWidth={320}
                wrapOptions
              />
            </div>
          )}
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
              <NumericInput min="1" value={movementForm.quantity} onChange={(e) => setMovementForm({...movementForm, quantity: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
          </div>
          {movementForm.type === 'ajuste' && (
            <p className="text-[11px] text-slate-500 -mt-1">En un <strong>ajuste</strong>, la cantidad es el stock final que debe quedar en la bodega seleccionada (no lo que se suma).</p>
          )}
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
