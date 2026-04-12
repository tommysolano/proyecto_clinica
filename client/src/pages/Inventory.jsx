import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus, HiOutlinePencil, HiOutlineTrash,
  HiOutlineMagnifyingGlass, HiOutlineArrowDown, HiOutlineArrowUp,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

const categories = { medicamento: 'Medicamento', insumo: 'Insumo', servicio: 'Servicio', otro: 'Otro' };
const emptyProduct = {
  code: '', name: '', description: '', category: 'otro',
  purchasePrice: '', salePrice: '', stock: '', minStock: '5', unit: 'unidad', taxRate: '15',
};
const emptyMovement = { product: '', type: 'entrada', quantity: '', reason: '' };

export default function Inventory() {
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
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
    });
    setProductModal(true);
  };

  const handleProductSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const data = {
        ...productForm,
        purchasePrice: parseFloat(productForm.purchasePrice) || 0,
        salePrice: parseFloat(productForm.salePrice),
        stock: parseInt(productForm.stock) || 0,
        minStock: parseInt(productForm.minStock) || 5,
        taxRate: parseFloat(productForm.taxRate) || 15,
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
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Inventario</h1>
          <p className="text-sm text-slate-500 mt-1">Gestión de productos y movimientos</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => openNewMovement()}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none transition-colors"
          >
            <HiOutlineArrowDown className="w-4 h-4" /> Movimiento
          </button>
          <button
            onClick={openNewProduct}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 transition-all"
          >
            <HiOutlinePlus className="w-5 h-5" /> Nuevo Producto
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-emerald-50 rounded-xl p-1 mb-6 w-fit">
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
          <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6 p-4">
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
          <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
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
                    <tr><td colSpan="6" className="text-center py-10 text-slate-500">No se encontraron productos</td></tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                        <td className="px-6 py-3.5 text-sm text-slate-600 font-mono">{p.code}</td>
                        <td className="px-6 py-3.5 text-sm font-medium text-slate-800">{p.name}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell capitalize">{categories[p.category]}</td>
                        <td className="px-6 py-3.5 text-sm text-slate-800 text-right">${p.salePrice.toFixed(2)}</td>
                        <td className="px-6 py-3.5 text-right">
                          <span className={`text-sm font-medium ${p.stock <= p.minStock ? 'text-red-500' : 'text-slate-800'}`}>
                            {p.stock}
                          </span>
                          {p.stock <= p.minStock && (
                            <HiOutlineExclamationTriangle className="inline-block w-4 h-4 text-amber-500 ml-1" />
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-right">
                          <button onClick={() => openNewMovement(p._id)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors" title="Movimiento">
                            <HiOutlineArrowUp className="w-4 h-4" />
                          </button>
                          <button onClick={() => openEditProduct(p)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors">
                            <HiOutlinePencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => handleDeleteProduct(p._id)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors">
                            <HiOutlineTrash className="w-4 h-4" />
                          </button>
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
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
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
                  <tr><td colSpan="6" className="text-center py-10 text-slate-500">No hay movimientos</td></tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                      <td className="px-6 py-3 text-sm text-slate-600">{new Date(m.createdAt).toLocaleString('es-EC')}</td>
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
              <select value={productForm.category} onChange={(e) => setProductForm({...productForm, category: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Precio compra</label>
              <input type="number" step="0.01" value={productForm.purchasePrice} onChange={(e) => setProductForm({...productForm, purchasePrice: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Precio venta *</label>
              <input type="number" step="0.01" value={productForm.salePrice} onChange={(e) => setProductForm({...productForm, salePrice: e.target.value})} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">IVA %</label>
              <input type="number" value={productForm.taxRate} onChange={(e) => setProductForm({...productForm, taxRate: e.target.value})} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
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
