import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { HiOutlinePlus, HiOutlineDocumentDuplicate, HiOutlineArrowDownTray } from 'react-icons/hi2';

const EMPTY_ITEM = { product: '', productName: '', quantity: 1, unitPrice: 0, taxRate: 15, discount: 0 };
const EMPTY = {
  patient: '',
  clientName: '',
  clientCedula: '',
  clientEmail: '',
  clientPhone: '',
  notes: '',
  validUntil: '',
  items: [{ ...EMPTY_ITEM }],
};

export default function Quotations() {
  const { hasRole } = useAuth();
  const canEdit = hasRole('admin', 'cajero', 'call_center');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [products, setProducts] = useState([]);
  const [patients, setPatients] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/quotations');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.all([
      api.get('/products').then((r) => setProducts(r.data.products || r.data || [])),
      api.get('/patients').then((r) => setPatients(r.data.patients || r.data || [])),
    ]).catch(() => {});
    load();
  }, []);

  const updateItem = (idx, field, value) => {
    const items = [...form.items];
    items[idx] = { ...items[idx], [field]: value };
    if (field === 'product') {
      const p = products.find((pr) => pr._id === value);
      if (p) {
        items[idx].productName = p.name;
        items[idx].unitPrice = p.salePrice;
        items[idx].taxRate = p.taxRate ?? 15;
      }
    }
    setForm({ ...form, items });
  };

  const totals = () => {
    let subtotal = 0;
    let discountTotal = 0;
    let taxAmount = 0;
    form.items.forEach((it) => {
      const base = Number(it.unitPrice || 0) * Number(it.quantity || 0);
      const disc = Number(it.discount || 0);
      const sub = base - disc;
      subtotal += base;
      discountTotal += disc;
      taxAmount += sub * (Number(it.taxRate || 0) / 100);
    });
    return {
      subtotal: subtotal.toFixed(2),
      discountTotal: discountTotal.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      total: (subtotal - discountTotal + taxAmount).toFixed(2),
    };
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { ...form, items: form.items.filter((it) => it.product) };
      await api.post('/quotations', body);
      toast.success('Cotización creada');
      setShowModal(false);
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const downloadPdf = async (q) => {
    try {
      const res = await api.get(`/quotations/${q._id}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `cotizacion_${q.quotationNumber}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('No se pudo generar PDF');
    }
  };

  const t = totals();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HiOutlineDocumentDuplicate className="text-emerald-600" /> Cotizaciones
          </h1>
          <p className="text-sm text-slate-500">
            Genera y descarga cotizaciones para tus pacientes/clientes.
          </p>
        </div>
        {canEdit && (
          <button onClick={() => setShowModal(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 hover:bg-emerald-700">
            <HiOutlinePlus className="w-4 h-4" /> Nueva cotización
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Número</th>
              <th className="text-left px-3 py-2">Cliente</th>
              <th className="text-right px-3 py-2">Total</th>
              <th className="text-left px-3 py-2">Estado</th>
              <th className="text-left px-3 py-2">Creado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-4 text-slate-400">Cargando...</td></tr>
            )}
            {list.map((q) => (
              <tr key={q._id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-semibold">{q.quotationNumber}</td>
                <td className="px-3 py-2">{q.clientName || `${q.patient?.firstName || ''} ${q.patient?.lastName || ''}`}</td>
                <td className="px-3 py-2 text-right">${Number(q.total || 0).toFixed(2)}</td>
                <td className="px-3 py-2"><span className="text-xs px-2 py-1 rounded bg-slate-100">{q.status}</span></td>
                <td className="px-3 py-2 text-slate-500">{new Date(q.createdAt).toLocaleDateString('es-EC')}</td>
                <td className="px-3 py-2">
                  <button onClick={() => downloadPdf(q)} className="px-2 py-1 text-xs bg-sky-50 text-sky-700 rounded hover:bg-sky-100 flex items-center gap-1">
                    <HiOutlineArrowDownTray className="w-3 h-3" /> PDF
                  </button>
                </td>
              </tr>
            ))}
            {!loading && list.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400">Sin cotizaciones</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nueva cotización" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Paciente (opcional)</span>
              <select value={form.patient} onChange={(e) => {
                const p = patients.find((pp) => pp._id === e.target.value);
                setForm({
                  ...form,
                  patient: e.target.value,
                  clientName: p ? `${p.firstName} ${p.lastName}` : form.clientName,
                  clientCedula: p?.cedula || form.clientCedula,
                  clientEmail: p?.email || form.clientEmail,
                  clientPhone: p?.phone || form.clientPhone,
                });
              }} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="">—</option>
                {patients.map((p) => (
                  <option key={p._id} value={p._id}>{p.firstName} {p.lastName}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Válida hasta</span>
              <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Cliente</span>
              <input value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Cédula/RUC</span>
              <input value={form.clientCedula} onChange={(e) => setForm({ ...form, clientCedula: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Email</span>
              <input type="email" value={form.clientEmail} onChange={(e) => setForm({ ...form, clientEmail: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Teléfono</span>
              <input value={form.clientPhone} onChange={(e) => setForm({ ...form, clientPhone: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-600">Ítems</span>
              <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { ...EMPTY_ITEM }] })} className="text-xs text-emerald-600 hover:underline">
                + Agregar
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2">
                  <select value={it.product} onChange={(e) => updateItem(idx, 'product', e.target.value)} className="col-span-5 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                    <option value="">Producto/servicio...</option>
                    {products.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                  </select>
                  <input type="number" min="1" value={it.quantity} onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))} className="col-span-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="Cant" />
                  <input type="number" step="0.01" value={it.unitPrice} onChange={(e) => updateItem(idx, 'unitPrice', Number(e.target.value))} className="col-span-2 border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="P. Unit" />
                  <input type="number" step="0.01" value={it.discount} onChange={(e) => updateItem(idx, 'discount', Number(e.target.value))} className="col-span-2 border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="Desc" />
                  <input type="number" step="0.01" value={it.taxRate} onChange={(e) => updateItem(idx, 'taxRate', Number(e.target.value))} className="col-span-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="%IVA" />
                  <button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })} className="col-span-1 text-rose-600">×</button>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-50 rounded-lg p-3 text-sm">
            <div className="flex justify-between"><span>Subtotal:</span><span>${t.subtotal}</span></div>
            <div className="flex justify-between"><span>Descuento:</span><span>${t.discountTotal}</span></div>
            <div className="flex justify-between"><span>IVA:</span><span>${t.taxAmount}</span></div>
            <div className="flex justify-between font-bold text-emerald-700 text-base"><span>Total:</span><span>${t.total}</span></div>
          </div>

          <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notas / términos" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">Cancelar</button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Crear cotización</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
