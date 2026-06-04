import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import { downloadFile } from '../utils/download';
import ProductAutocomplete from '../components/ProductAutocomplete';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineXCircle,
  HiOutlineTrash,
  HiOutlineDocumentText,
  HiOutlineBanknotes,
} from 'react-icons/hi2';

const paymentMethods = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito (CxC)',
};

export default function Sales() {
  const { hasRole } = useAuth();
  const canCreate = hasRole('admin', 'cajero');
  const canCancel = hasRole('admin');
  const canInvoice = hasRole('admin', 'cajero');
  // El cajero crea ventas pero NO ve el historial (solo admin/contabilidad).
  const canViewHistory = hasRole('admin', 'contabilidad');

  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [patients, setPatients] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [invoicingId, setInvoicingId] = useState(null);
  const [filter, setFilter] = useState({ startDate: '', endDate: '', product: '' });
  const [topProducts, setTopProducts] = useState([]);
  const [showChart, setShowChart] = useState(false);

  const [form, setForm] = useState({
    clientName: 'Consumidor Final',
    clientCedula: '9999999999999',
    clientEmail: '',
    clientPhone: '',
    clientAddress: '',
    clientCity: 'Guayaquil',
    clientZone: '',
    patient: '',
    paymentMethod: 'efectivo',
    bankAccount: '',
    creditCard: '',
    cardPos: '',
    recommendedBy: '',
    notes: '',
    items: [],
  });
  const [currentItem, setCurrentItem] = useState({ product: '', quantity: 1 });
  const [patientSearch, setPatientSearch] = useState('');
  const [guayaquilZones, setGuayaquilZones] = useState([]);
  // Medios de pago (cuentas bancarias / tarjetas) y personal para recomendación
  const [payOptions, setPayOptions] = useState({ accounts: [], cards: [] });
  const [staff, setStaff] = useState([]);

  useEffect(() => {
    api
      .get('/marketing/guayaquil-zones')
      .then((r) => setGuayaquilZones(r.data || []))
      .catch(() => setGuayaquilZones([]));
  }, []);

  const fetchSales = async () => {
    if (!canViewHistory) { setLoading(false); return; }
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      if (filter.product) params.product = filter.product;
      const res = await api.get('/sales', { params });
      setSales(res.data.sales);
    } catch {
      toast.error('Error al cargar ventas');
    } finally {
      setLoading(false);
    }
  };

  const fetchTopProducts = async () => {
    try {
      const params = {};
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      const res = await api.get('/dashboard/top-products', { params });
      setTopProducts(res.data || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    if (showChart) fetchTopProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChart, filter.startDate, filter.endDate]);

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
      api.get('/banks/payment-options')
        .then((r) => setPayOptions({ accounts: r.data?.accounts || [], cards: r.data?.cards || [] }))
        .catch(() => setPayOptions({ accounts: [], cards: [] }));
      api.get('/users')
        .then((r) => setStaff(r.data || []))
        .catch(() => setStaff([]));
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
      clientCity: 'Guayaquil',
      clientZone: '',
      patient: '',
      paymentMethod: 'efectivo',
      bankAccount: '',
      creditCard: '',
      cardPos: '',
      recommendedBy: '',
      notes: '',
      items: [],
    });
    setCurrentItem({ product: '', quantity: 1 });
    setPatientSearch('');
    setModalOpen(true);
  };

  const addItem = () => {
    if (!currentItem.product) return toast.error('Selecciona un producto');
    const product = products.find((p) => p._id === currentItem.product);
    if (!product) return;

    const isService = product.category === 'servicio' || product.unlimited === true;
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
          unlimited: product.unlimited === true,
          quantity: qty,
          unitPrice: product.salePrice,
          taxRate: product.taxRate,
          stock: product.stock,
          discount: 0,
          treatment: '',
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
    const isService = it.category === 'servicio' || it.unlimited === true;
    if (!isService && newQty > it.stock) {
      toast.error(`Stock máximo: ${it.stock}`);
      return;
    }
    items[idx].quantity = newQty;
    setForm({ ...form, items });
  };

  const subtotal = form.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const discountTotal = form.items.reduce((s, i) => s + (Number(i.discount) || 0), 0);
  // No se cobra IVA en la venta (el precio del inventario ya lo contempla).
  const taxAmount = 0;
  const total = subtotal - discountTotal;

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
      setPatientSearch(`${patient.firstName} ${patient.lastName} - ${patient.cedula}`);
      // cargar tratamientos activos del paciente
      api
        .get('/treatments', { params: { patient: patientId } })
        .then((r) => setTreatments(r.data || []))
        .catch(() => setTreatments([]));
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
      setPatientSearch('');
      setTreatments([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.items.length === 0) return toast.error('Agrega al menos un producto');
    setSaving(true);
    try {
      if (form.paymentMethod === 'transferencia' && payOptions.accounts.length && !form.bankAccount) {
        setSaving(false);
        return toast.error('Selecciona la cuenta bancaria de destino');
      }
      if (form.paymentMethod === 'tarjeta' && payOptions.cards.length && !form.creditCard) {
        setSaving(false);
        return toast.error('Selecciona la tarjeta / POS');
      }
      await api.post('/sales', {
        ...form,
        bankAccount: form.paymentMethod === 'transferencia' ? form.bankAccount || null : null,
        creditCard: form.paymentMethod === 'tarjeta' ? form.creditCard || null : null,
        cardPos: form.paymentMethod === 'tarjeta' ? form.cardPos || '' : '',
        recommendedBy: form.recommendedBy || null,
        items: form.items.map((i) => ({
          product: i.product,
          quantity: i.quantity,
          discount: Number(i.discount) || 0,
          treatment: i.treatment || null,
        })),
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

  const collectSale = async (s) => {
    const input = window.prompt(`Saldo pendiente: $${(s.balance || 0).toFixed(2)}\nMonto a cobrar (efectivo):`, (s.balance || 0).toFixed(2));
    if (input == null) return;
    const amount = parseFloat(input);
    if (!amount || amount <= 0) return toast.error('Monto inválido');
    try {
      const r = await api.post(`/sales/${s._id}/collect`, { amount, paymentMethod: 'efectivo' });
      toast.success(r.data.paid ? 'Cobro completado (saldado)' : `Cobro registrado. Saldo: $${r.data.balance.toFixed(2)}`);
      fetchSales();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Ventas</h1>
          <p className="text-sm text-slate-500 mt-1">Registro y facturación electrónica</p>
        </div>
        {canCreate && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  const params = {};
                  if (filter.startDate) params.startDate = filter.startDate;
                  if (filter.endDate) params.endDate = filter.endDate;
                  await downloadFile('/reports/sales.xlsx', { params, filename: `ventas_${Date.now()}.xlsx` });
                } catch (err) {
                  toast.error(err.message || 'Error al exportar');
                }
              }}
              className="px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            >
              Excel
            </button>
            <button
              onClick={openNew}
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              <HiOutlinePlus className="w-5 h-5" /> Nueva Venta
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 mb-6 p-4">
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
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
          <div className="flex-1 min-w-[200px]">
            <ProductAutocomplete
              products={products}
              value={filter.product}
              onSelect={(p) => setFilter({ ...filter, product: p?._id || '' })}
              placeholder="Filtrar por producto/servicio..."
            />
          </div>
          <button
            type="button"
            onClick={() => setShowChart((s) => !s)}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium border cursor-pointer ${
              showChart
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
            }`}
          >
            {showChart ? 'Ocultar gráfico' : 'Top productos'}
          </button>
        </div>
      </div>

      {showChart && <TopProductsChart data={topProducts} />}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
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
                    <td className="px-6 py-3 text-sm text-slate-800">
                      <div className="flex items-center gap-2">
                        <span>{s.clientName}</span>
                        {s.isFirstVisit && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                            Nuevo
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-sm font-bold text-slate-800 text-right">
                      ${s.total.toFixed(2)}
                      {s.paymentMethod === 'credito' && s.balance > 0.01 && (
                        <span className="block text-[10px] font-medium text-amber-600">Saldo ${s.balance.toFixed(2)}</span>
                      )}
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
                      {s.status === 'completada' && s.paymentMethod === 'credito' && s.balance > 0.01 && (
                        <button
                          onClick={() => collectSale(s)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                          title="Registrar cobro"
                        >
                          <HiOutlineBanknotes className="w-4 h-4" />
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
            <div className="sm:col-span-3 relative">
              <label className="lbl">Buscar paciente registrado (opcional)</label>
              <input
                type="text"
                value={patientSearch}
                onChange={(e) => {
                  setPatientSearch(e.target.value);
                  if (form.patient) {
                    setForm((f) => ({ ...f, patient: '' }));
                  }
                }}
                placeholder="Escribe nombre o cédula..."
                className="input"
              />
              {patientSearch && !form.patient && (
                <div className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
                  {patients
                    .filter((p) => {
                      const q = patientSearch.toLowerCase();
                      return (
                        p.firstName?.toLowerCase().includes(q) ||
                        p.lastName?.toLowerCase().includes(q) ||
                        p.cedula?.includes(q) ||
                        p.phone?.includes(q)
                      );
                    })
                    .slice(0, 20)
                    .map((p) => (
                      <button
                        type="button"
                        key={p._id}
                        onClick={() => handlePatientSelect(p._id)}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50"
                      >
                        <span className="font-medium text-slate-800">
                          {p.firstName} {p.lastName}
                        </span>
                        <span className="text-slate-400 ml-2">{p.cedula}</span>
                        {p.phone && (
                          <span className="text-slate-400 ml-2">• {p.phone}</span>
                        )}
                      </button>
                    ))}
                  {patients.filter((p) => {
                    const q = patientSearch.toLowerCase();
                    return (
                      p.firstName?.toLowerCase().includes(q) ||
                      p.lastName?.toLowerCase().includes(q) ||
                      p.cedula?.includes(q) ||
                      p.phone?.includes(q)
                    );
                  }).length === 0 && (
                    <p className="px-4 py-2 text-xs text-slate-400">Sin coincidencias</p>
                  )}
                </div>
              )}
              {form.patient && (
                <button
                  type="button"
                  onClick={() => handlePatientSelect('')}
                  className="absolute right-3 top-9 text-xs text-emerald-600 hover:text-emerald-800 bg-transparent border-none cursor-pointer"
                >
                  Limpiar
                </button>
              )}
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
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value, bankAccount: '', creditCard: '', cardPos: '' })}
                className="input"
              >
                {Object.entries(paymentMethods).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            {form.paymentMethod === 'transferencia' && (
              <div>
                <label className="lbl">Cuenta bancaria de destino</label>
                <select
                  value={form.bankAccount || ''}
                  onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
                  className="input"
                >
                  <option value="">{payOptions.accounts.length ? 'Seleccionar cuenta…' : 'No hay cuentas configuradas'}</option>
                  {payOptions.accounts.map((a) => (
                    <option key={a._id} value={a._id}>{a.name} — {a.bank} ({a.accountNumber})</option>
                  ))}
                </select>
              </div>
            )}
            {form.paymentMethod === 'tarjeta' && (
              <>
                <div>
                  <label className="lbl">Tarjeta / Adquirente</label>
                  <select
                    value={form.creditCard || ''}
                    onChange={(e) => setForm({ ...form, creditCard: e.target.value, cardPos: '' })}
                    className="input"
                  >
                    <option value="">{payOptions.cards.length ? 'Seleccionar tarjeta…' : 'No hay tarjetas configuradas'}</option>
                    {payOptions.cards.map((c) => (
                      <option key={c._id} value={c._id}>{c.name} ({c.brand}{c.acquirer ? ` · ${c.acquirer}` : ''})</option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const card = payOptions.cards.find((c) => c._id === form.creditCard);
                  if (!card || !card.pos?.length) return null;
                  return (
                    <div>
                      <label className="lbl">POS / Terminal</label>
                      <select
                        value={form.cardPos || ''}
                        onChange={(e) => setForm({ ...form, cardPos: e.target.value })}
                        className="input"
                      >
                        <option value="">Seleccionar POS…</option>
                        {card.pos.map((p) => (
                          <option key={p.code} value={p.code}>{p.name || p.code}{p.terminal ? ` · ${p.terminal}` : ''}</option>
                        ))}
                      </select>
                    </div>
                  );
                })()}
              </>
            )}
            {form.paymentMethod === 'credito' && (
              <div>
                <label className="lbl">Vence (crédito)</label>
                <input type="date" value={form.dueDate || ''} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="input" />
              </div>
            )}
            <div>
              <label className="lbl">Recomendado por (comisión)</label>
              <select
                value={form.recommendedBy || ''}
                onChange={(e) => setForm({ ...form, recommendedBy: e.target.value })}
                className="input"
              >
                <option value="">— Nadie / No aplica —</option>
                {staff.map((u) => (
                  <option key={u._id} value={u._id}>{u.name}</option>
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="lbl">Ciudad</label>
              <select
                value={form.clientCity === 'Guayaquil' ? 'Guayaquil' : 'Otra'}
                onChange={(e) => {
                  if (e.target.value === 'Guayaquil') {
                    setForm({ ...form, clientCity: 'Guayaquil' });
                  } else {
                    setForm({ ...form, clientCity: '', clientZone: '' });
                  }
                }}
                className="input"
              >
                <option value="Guayaquil">Guayaquil</option>
                <option value="Otra">Otra ciudad</option>
              </select>
              {form.clientCity !== 'Guayaquil' && (
                <input
                  value={form.clientCity}
                  onChange={(e) => setForm({ ...form, clientCity: e.target.value })}
                  placeholder="Nombre de la ciudad"
                  className="input mt-1"
                />
              )}
            </div>
            <div>
              <label className="lbl">
                {form.clientCity === 'Guayaquil' ? 'Zona / Parroquia' : 'Sector'}
              </label>
              {form.clientCity === 'Guayaquil' ? (
                <>
                  <input
                    list="guayaquil-zones-datalist"
                    value={form.clientZone}
                    onChange={(e) => setForm({ ...form, clientZone: e.target.value })}
                    placeholder="Ej. Tarqui, Urdesa, Alborada..."
                    className="input"
                  />
                  <datalist id="guayaquil-zones-datalist">
                    {guayaquilZones.map((z) => (
                      <option key={z.name} value={z.name}>
                        {z.parroquia}
                      </option>
                    ))}
                  </datalist>
                  {form.clientZone && !guayaquilZones.some((z) => z.name.toLowerCase() === form.clientZone.toLowerCase()) && (
                    <p className="text-[11px] text-amber-600 mt-1">
                      Zona no reconocida. Selecciona una de la lista.
                    </p>
                  )}
                </>
              ) : (
                <input
                  value={form.clientZone}
                  onChange={(e) => setForm({ ...form, clientZone: e.target.value })}
                  className="input"
                />
              )}
            </div>
          </div>

          <div className="bg-emerald-50/50 rounded-xl p-4">
            <p className="text-sm font-medium text-emerald-700 mb-3">Agregar productos</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <ProductAutocomplete
                  products={products}
                  value={currentItem.product}
                  onSelect={(p) =>
                    setCurrentItem({ ...currentItem, product: p?._id || '' })
                  }
                  placeholder="Buscar producto o servicio..."
                  filter={(p) => p.active !== false}
                />
              </div>
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
                    <th className="text-right py-2">Desc. $</th>
                    {form.patient && treatments.length > 0 && (
                      <th className="text-left py-2 pl-2">Tratamiento</th>
                    )}
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
                      <td className="py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.discount ?? 0}
                          onChange={(e) => {
                            const items = [...form.items];
                            items[idx].discount = parseFloat(e.target.value) || 0;
                            setForm({ ...form, items });
                          }}
                          className="w-20 px-2 py-1 border border-slate-300 rounded text-right text-sm outline-none"
                        />
                      </td>
                      {form.patient && treatments.length > 0 && (
                        <td className="py-2 pl-2">
                          <select
                            value={item.treatment || ''}
                            onChange={(e) => {
                              const items = [...form.items];
                              items[idx].treatment = e.target.value;
                              setForm({ ...form, items });
                            }}
                            className="w-full px-2 py-1 border border-slate-300 rounded text-sm bg-white"
                          >
                            <option value="">— Ninguno —</option>
                            {treatments.map((t) => (
                              <option key={t._id} value={t._id}>
                                {t.name || t.product?.name || 'Tratamiento'}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="py-2 text-right font-medium">
                        ${(item.unitPrice * item.quantity - (Number(item.discount) || 0)).toFixed(2)}
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
              {discountTotal > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Descuento:</span>
                  <span className="font-medium text-rose-600">-${discountTotal.toFixed(2)}</span>
                </div>
              )}
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
            {detailModal.isFirstVisit && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-amber-700 text-sm font-semibold uppercase tracking-wide">
                ✨ Paciente Nuevo
              </div>
            )}
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
                <p className="capitalize">
                  {paymentMethods[detailModal.paymentMethod]}
                  {detailModal.bankAccount && ` · ${detailModal.bankAccount.name}`}
                  {detailModal.creditCard && ` · ${detailModal.creditCard.name}${detailModal.cardPos ? ` (POS ${detailModal.cardPos})` : ''}`}
                </p>
              </div>
            </div>
            {(detailModal.cashier || detailModal.callCenter || detailModal.doctor || detailModal.nurse || detailModal.recommendedBy) && (
              <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                {detailModal.recommendedBy && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Recomendado por</p>
                    <p className="text-slate-700">{detailModal.recommendedBy.name}</p>
                  </div>
                )}
                {detailModal.cashier && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Cajero</p>
                    <p className="text-slate-700">{detailModal.cashier.name}</p>
                  </div>
                )}
                {detailModal.callCenter && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Call Center</p>
                    <p className="text-slate-700">{detailModal.callCenter.name}</p>
                  </div>
                )}
                {detailModal.doctor && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Doctor</p>
                    <p className="text-slate-700">{detailModal.doctor.name}</p>
                  </div>
                )}
                {detailModal.nurse && (
                  <div>
                    <p className="text-indigo-700 font-semibold">Enfermero/a</p>
                    <p className="text-slate-700">{detailModal.nurse.name}</p>
                  </div>
                )}
              </div>
            )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2">Producto</th>
                  <th className="text-right py-2">Precio</th>
                  <th className="text-center py-2">Cant.</th>
                  <th className="text-right py-2">Desc.</th>
                  <th className="text-right py-2">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {detailModal.items.map((item, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="py-2">
                      {item.productName}
                      {item.treatment && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                          tratamiento
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">${item.unitPrice.toFixed(2)}</td>
                    <td className="py-2 text-center">{item.quantity}</td>
                    <td className="py-2 text-right text-rose-600">
                      {item.discount ? `-$${Number(item.discount).toFixed(2)}` : '—'}
                    </td>
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
              {detailModal.discountTotal > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Descuento:</span>
                  <span className="text-rose-600">-${detailModal.discountTotal.toFixed(2)}</span>
                </div>
              )}
              {detailModal.taxAmount > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">IVA:</span>
                  <span>${detailModal.taxAmount.toFixed(2)}</span>
                </div>
              )}
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

function TopProductsChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-6 mb-6 text-center text-slate-400 text-sm">
        Sin datos para mostrar
      </div>
    );
  }
  const top = data.slice(0, 10);
  const maxQty = Math.max(...top.map((d) => d.quantity || 0), 1);
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-6 mb-6">
      <h3 className="text-lg font-bold text-slate-800 mb-4">Top productos/servicios vendidos</h3>
      <div className="space-y-3">
        {top.map((p) => {
          const pct = ((p.quantity || 0) / maxQty) * 100;
          return (
            <div key={p._id} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-4 text-sm text-slate-700 truncate" title={p.name}>
                {p.name}
              </div>
              <div className="col-span-6 bg-slate-100 rounded-full h-6 overflow-hidden relative">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full flex items-center justify-end pr-2 text-white text-xs font-bold"
                  style={{ width: `${pct}%` }}
                >
                  {p.quantity}
                </div>
              </div>
              <div className="col-span-2 text-right text-sm font-medium text-emerald-700">
                ${Number(p.revenue || 0).toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
