import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineXCircle,
  HiOutlineTrash,
  HiOutlineDocumentText,
} from 'react-icons/hi2';

const paymentMethods = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
};

export default function Sales() {
  const { hasRole } = useAuth();
  const canCreate = hasRole('admin', 'cajero');
  const canCancel = hasRole('admin');
  const canInvoice = hasRole('admin', 'cajero');

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [patients, setPatients] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [invoicingId, setInvoicingId] = useState(null);
  const [filter, setFilter] = useState({ startDate: '', endDate: '' });

  const [form, setForm] = useState({
    clientName: 'Consumidor Final',
    clientCedula: '9999999999999',
    clientEmail: '',
    clientPhone: '',
    clientAddress: '',
    patient: '',
    paymentMethod: 'efectivo',
    notes: '',
    items: [],
  });
  const [currentItem, setCurrentItem] = useState({ product: '', quantity: 1 });

  const fetchSales = async () => {
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      const res = await api.get('/sales', { params });
      setSales(res.data.sales);
    } catch {
      toast.error('Error al cargar ventas');
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const res = await api.get('/products');
      setProducts(res.data);
    } catch (err) {
      // contabilidad puede no tener acceso a /products en algunos casos; ignoramos.
      void err;
    }
  };

  const fetchPatients = async () => {
    try {
      const res = await api.get('/patients', { params: { limit: 1000 } });
      setPatients(res.data.patients);
    } catch (err) {
      void err;
    }
  };

  useEffect(() => {
    fetchSales();
    if (canCreate) {
      fetchProducts();
      fetchPatients();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchSales();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const openNew = () => {
    setForm({
      clientName: 'Consumidor Final',
      clientCedula: '9999999999999',
      clientEmail: '',
      clientPhone: '',
      clientAddress: '',
      patient: '',
      paymentMethod: 'efectivo',
      notes: '',
      items: [],
    });
    setCurrentItem({ product: '', quantity: 1 });
    setModalOpen(true);
  };

  const addItem = () => {
    if (!currentItem.product) return toast.error('Selecciona un producto');
    const product = products.find((p) => p._id === currentItem.product);
    if (!product) return;

    const isService = product.category === 'servicio';
    if (!isService && product.stock <= 0) {
      return toast.error(`${product.name} sin stock disponible`);
    }
    if (form.items.find((i) => i.product === currentItem.product)) {
      return toast.error('El producto ya está en la lista');
    }
    const qty = parseInt(currentItem.quantity) || 1;
    if (!isService && qty > product.stock) {
      return toast.error(`Stock insuficiente. Disponible: ${product.stock}`);
    }

    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        {
          product: product._id,
          productName: product.name,
          category: product.category,
          quantity: qty,
          unitPrice: product.salePrice,
          taxRate: product.taxRate,
          stock: product.stock,
        },
      ],
    }));
    setCurrentItem({ product: '', quantity: 1 });
  };

  const removeItem = (idx) => {
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  };

  const updateItemQty = (idx, qty) => {
    const items = [...form.items];
    const newQty = parseInt(qty) || 1;
    const it = items[idx];
    if (it.category !== 'servicio' && newQty > it.stock) {
      toast.error(`Stock máximo: ${it.stock}`);
      return;
    }
    items[idx].quantity = newQty;
    setForm({ ...form, items });
  };

  const subtotal = form.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const taxAmount = form.items.reduce(
    (s, i) => s + (i.unitPrice * i.quantity * i.taxRate) / 100,
    0
  );
  const total = subtotal + taxAmount;

  const handlePatientSelect = (patientId) => {
    const patient = patients.find((p) => p._id === patientId);
    if (patient) {
      setForm((f) => ({
        ...f,
        patient: patientId,
        clientName: `${patient.firstName} ${patient.lastName}`,
        clientCedula: patient.cedula,
        clientEmail: patient.email || '',
        clientPhone: patient.phone || '',
        clientAddress: patient.address || '',
      }));
    } else {
      setForm((f) => ({
        ...f,
        patient: '',
        clientName: 'Consumidor Final',
        clientCedula: '9999999999999',
        clientEmail: '',
        clientPhone: '',
        clientAddress: '',
      }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.items.length === 0) return toast.error('Agrega al menos un producto');
    setSaving(true);
    try {
      await api.post('/sales', {
        ...form,
        items: form.items.map((i) => ({ product: i.product, quantity: i.quantity })),
      });
      toast.success('Venta registrada');
      setModalOpen(false);
      fetchSales();
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear venta');
    } finally {
      setSaving(false);
    }
  };

  const cancelSale = async (sale) => {
    if (sale.invoice && sale.invoice.estado === 'AUTORIZADO') {
      return toast.error('No se puede anular: la factura ya fue autorizada por el SRI');
    }
    if (!window.confirm('¿Anular esta venta? Se restaurará el stock.')) return;
    try {
      await api.put(`/sales/${sale._id}/cancel`);
      toast.success('Venta anulada');
      fetchSales();
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al anular');
    }
  };

  const facturar = async (sale) => {
    if (sale.invoice) return toast.error('Esta venta ya tiene factura asociada');
    if (!window.confirm(`¿Emitir factura electrónica para la venta ${sale.saleNumber}?`)) return;
    setInvoicingId(sale._id);
    try {
      const res = await api.post(`/invoices/from-sale/${sale._id}`);
      const inv = res.data;
      if (inv.estado === 'AUTORIZADO') {
        toast.success('Factura autorizada por el SRI');
      } else if (inv.estado === 'DEVUELTA' || inv.estado === 'NO_AUTORIZADO') {
        toast.error(`Factura rechazada: ${inv.errorMessage || inv.estado}`);
      } else {
        toast.success(`Factura emitida (${inv.estado})`);
      }
      fetchSales();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al facturar');
    } finally {
      setInvoicingId(null);
    }
  };

  const openDetail = async (id) => {
    try {
      const res = await api.get(`/sales/${id}`);
      setDetailModal(res.data);
    } catch {
      toast.error('Error al cargar detalle');
    }
  };

  return (
    <div className="p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Ventas</h1>
          <p className="text-sm text-slate-500 mt-1">Registro y facturación electrónica</p>
        </div>
        {canCreate && (
          <button
            onClick={openNew}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50"
          >
            <HiOutlinePlus className="w-5 h-5" /> Nueva Venta
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="date"
            value={filter.startDate}
            onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <input
            type="date"
            value={filter.endDate}
            onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">N° Venta</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Fecha</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cliente</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Total</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Estado</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Factura</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7" className="text-center py-10 text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : sales.length === 0 ? (
                <tr>
                  <td colSpan="7" className="text-center py-10 text-slate-500">
                    No se encontraron ventas
                  </td>
                </tr>
              ) : (
                sales.map((s) => (
                  <tr key={s._id} className="border-b border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-6 py-3 text-sm font-mono text-slate-600">{s.saleNumber}</td>
                    <td className="px-6 py-3 text-sm text-slate-600">
                      {new Date(s.createdAt).toLocaleString('es-EC')}
                    </td>
                    <td className="px-6 py-3 text-sm text-slate-800">{s.clientName}</td>
                    <td className="px-6 py-3 text-sm font-bold text-slate-800 text-right">
                      ${s.total.toFixed(2)}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          s.status === 'completada'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {s.status === 'completada' ? 'Completada' : 'Anulada'}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-xs">
                      {s.invoice ? (
                        <span
                          className={`px-2 py-0.5 rounded ${
                            s.invoice.estado === 'AUTORIZADO'
                              ? 'bg-emerald-100 text-emerald-700'
                              : s.invoice.estado === 'ANULADA'
                              ? 'bg-slate-300 text-slate-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {s.invoice.estado}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => openDetail(s._id)}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                        title="Detalle"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </button>
                      {canInvoice && s.status === 'completada' && !s.invoice && (
                        <button
                          onClick={() => facturar(s)}
                          disabled={invoicingId === s._id}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 bg-transparent border-none cursor-pointer disabled:opacity-50"
                          title="Facturar electrónicamente"
                        >
                          <HiOutlineDocumentText className="w-4 h-4" />
                        </button>
                      )}
                      {canCancel && s.status === 'completada' && (
                        <button
                          onClick={() => cancelSale(s)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                          title="Anular"
                        >
                          <HiOutlineXCircle className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Nueva Venta" size="xl">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="lbl">Paciente (opcional)</label>
              <select
                value={form.patient}
                onChange={(e) => handlePatientSelect(e.target.value)}
                className="input"
              >
                <option value="">Consumidor Final</option>
                {patients.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.firstName} {p.lastName} - {p.cedula}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl">Cliente</label>
              <input
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Cédula / RUC</label>
              <input
                value={form.clientCedula}
                onChange={(e) => setForm({ ...form, clientCedula: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Email cliente</label>
              <input
                type="email"
                value={form.clientEmail}
                onChange={(e) => setForm({ ...form, clientEmail: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Teléfono cliente</label>
              <input
                value={form.clientPhone}
                onChange={(e) => setForm({ ...form, clientPhone: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="lbl">Método de pago</label>
              <select
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                className="input"
              >
                {Object.entries(paymentMethods).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="lbl">Dirección cliente</label>
            <input
              value={form.clientAddress}
              onChange={(e) => setForm({ ...form, clientAddress: e.target.value })}
              className="input"
            />
          </div>

          <div className="bg-emerald-50/50 rounded-xl p-4">
            <p className="text-sm font-medium text-emerald-700 mb-3">Agregar productos</p>
            <div className="flex gap-2">
              <select
                value={currentItem.product}
                onChange={(e) =>
                  setCurrentItem({ ...currentItem, product: e.target.value })
                }
                className="input flex-1 bg-white"
              >
                <option value="">Seleccionar producto</option>
                {products
                  .filter((p) => p.active)
                  .map((p) => {
                    const isService = p.category === 'servicio';
                    const noStock = !isService && p.stock <= 0;
                    return (
                      <option key={p._id} value={p._id} disabled={noStock}>
                        {p.name} - ${p.salePrice.toFixed(2)}
                        {isService ? ' (servicio)' : ` (Stock: ${p.stock})`}
                        {noStock ? ' — SIN STOCK' : ''}
                      </option>
                    );
                  })}
              </select>
              <input
                type="number"
                min="1"
                value={currentItem.quantity}
                onChange={(e) =>
                  setCurrentItem({ ...currentItem, quantity: e.target.value })
                }
                className="input w-20 bg-white"
              />
              <button
                type="button"
                onClick={addItem}
                className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl text-sm font-medium cursor-pointer border-none"
              >
                Agregar
              </button>
            </div>
          </div>

          {form.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2">Producto</th>
                    <th className="text-right py-2">Precio</th>
                    <th className="text-center py-2">Cant.</th>
                    <th className="text-right py-2">IVA</th>
                    <th className="text-right py-2">Subtotal</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((item, idx) => (
                    <tr key={idx} className="border-b border-slate-100">
                      <td className="py-2 text-slate-800">{item.productName}</td>
                      <td className="py-2 text-right">${item.unitPrice.toFixed(2)}</td>
                      <td className="py-2 text-center">
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItemQty(idx, e.target.value)}
                          className="w-16 px-2 py-1 border border-slate-300 rounded text-center text-sm outline-none"
                        />
                      </td>
                      <td className="py-2 text-right text-slate-500">{item.taxRate}%</td>
                      <td className="py-2 text-right font-medium">
                        ${(item.unitPrice * item.quantity).toFixed(2)}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="p-1 text-red-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {form.items.length > 0 && (
            <div className="bg-emerald-50/50 rounded-xl p-4 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Subtotal:</span>
                <span className="font-medium">${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">IVA:</span>
                <span className="font-medium">${taxAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base font-bold border-t border-emerald-200 pt-2">
                <span>Total:</span>
                <span className="text-emerald-700">${total.toFixed(2)}</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || form.items.length === 0}
              className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving ? 'Procesando...' : `Cobrar $${total.toFixed(2)}`}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!detailModal}
        onClose={() => setDetailModal(null)}
        title={`Venta ${detailModal?.saleNumber || ''}`}
        size="lg"
      >
        {detailModal && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500">Cliente</p>
                <p className="font-medium">{detailModal.clientName}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Cédula / RUC</p>
                <p>{detailModal.clientCedula}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Fecha</p>
                <p>{new Date(detailModal.createdAt).toLocaleString('es-EC')}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Método de pago</p>
                <p className="capitalize">{paymentMethods[detailModal.paymentMethod]}</p>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2">Producto</th>
                  <th className="text-right py-2">Precio</th>
                  <th className="text-center py-2">Cant.</th>
                  <th className="text-right py-2">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {detailModal.items.map((item, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="py-2">{item.productName}</td>
                    <td className="py-2 text-right">${item.unitPrice.toFixed(2)}</td>
                    <td className="py-2 text-center">{item.quantity}</td>
                    <td className="py-2 text-right">${item.subtotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="bg-emerald-50/50 rounded-xl p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal:</span>
                <span>${detailModal.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">IVA:</span>
                <span>${detailModal.taxAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold border-t border-emerald-200 pt-2">
                <span>Total:</span>
                <span className="text-emerald-700">${detailModal.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <style>{`
        .lbl { display:block; font-size:0.875rem; font-weight:500; color:#334155; margin-bottom:0.375rem; }
        .input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border: 1px solid #e2e8f0;
          border-radius: 0.75rem;
          font-size: 0.875rem;
          background: rgba(248, 250, 252, 0.5);
          outline: none;
        }
        .input:focus { border-color: #10b981; background: white; }
      `}</style>
    </div>
  );
}
