import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus,
  HiOutlineDocumentDuplicate,
  HiOutlineArrowDownTray,
  HiOutlineChatBubbleLeftRight,
  HiOutlineMagnifyingGlass,
  HiOutlinePhoto,
  HiOutlineTrash,
} from 'react-icons/hi2';

const EMPTY_ITEM = { product: '', productName: '', quantity: 1, unitPrice: 0, discount: 0 };
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

const STATUS_STYLES = {
  borrador: 'bg-slate-100 text-slate-700',
  enviada: 'bg-sky-100 text-sky-700',
  aceptada: 'bg-emerald-100 text-emerald-700',
  rechazada: 'bg-rose-100 text-rose-700',
  vencida: 'bg-amber-100 text-amber-700',
};

export default function Quotations() {
  const { hasRole, user, activeClinic } = useAuth();
  const canEdit = hasRole('admin', 'cajero', 'call_center', 'marketing');
  const canManageLogo = hasRole('admin') || user?.isSuperAdmin;
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showLogoModal, setShowLogoModal] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [products, setProducts] = useState([]);
  const [patients, setPatients] = useState([]);
  const [search, setSearch] = useState('');

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
      }
    }
    setForm({ ...form, items });
  };

  const totals = () => {
    let subtotal = 0;
    let discountTotal = 0;
    form.items.forEach((it) => {
      const base = Number(it.unitPrice || 0) * Number(it.quantity || 0);
      const discPct = Math.min(Math.max(Number(it.discount || 0), 0), 100);
      subtotal += base;
      discountTotal += base * (discPct / 100);
    });
    return {
      subtotal: subtotal.toFixed(2),
      discountTotal: discountTotal.toFixed(2),
      total: (subtotal - discountTotal).toFixed(2),
    };
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { ...form, items: form.items.filter((it) => it.product) };
      if (body.items.length === 0) {
        toast.error('Agrega al menos un ítem');
        return;
      }
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
      await downloadFile(`/quotations/${q._id}/pdf`, { filename: `cotizacion_${q.quotationNumber}.pdf` });
    } catch (err) {
      toast.error(err.message || 'No se pudo generar PDF');
    }
  };

  const sendWhatsapp = async (q) => {
    try {
      const phone = q.clientPhone || q.patient?.phone || '';
      const res = await api.get(`/quotations/${q._id}/whatsapp`, { params: { phone } });
      window.open(res.data.waUrl, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo generar el enlace de WhatsApp');
    }
  };

  const t = totals();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((x) =>
      String(x.quotationNumber || '').toLowerCase().includes(q) ||
      String(x.clientName || '').toLowerCase().includes(q) ||
      String(x.clientCedula || '').toLowerCase().includes(q)
    );
  }, [list, search]);

  const totalAmount = useMemo(
    () => list.reduce((s, x) => s + Number(x.total || 0), 0),
    [list]
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <HiOutlineDocumentDuplicate className="w-5 h-5" />
            </span>
            Cotizaciones
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Genera, descarga y comparte cotizaciones profesionales con tus pacientes.
          </p>
        </div>
        <div className="flex gap-2">
          {canManageLogo && (
            <button
              onClick={() => setShowLogoModal(true)}
              className="px-4 py-2.5 rounded-xl border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 text-sm font-medium cursor-pointer flex items-center gap-2"
            >
              <HiOutlinePhoto className="w-4 h-4" /> Logo de cotización
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setShowModal(true)}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 flex items-center gap-2"
            >
              <HiOutlinePlus className="w-4 h-4" /> Nueva cotización
            </button>
          )}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl border border-emerald-100 p-4">
          <p className="text-xs text-emerald-700 font-medium uppercase tracking-wider">Total cotizaciones</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{list.length}</p>
        </div>
        <div className="bg-gradient-to-br from-sky-50 to-indigo-50 rounded-2xl border border-sky-100 p-4">
          <p className="text-xs text-sky-700 font-medium uppercase tracking-wider">Monto total</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">${totalAmount.toFixed(2)}</p>
        </div>
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-100 p-4">
          <p className="text-xs text-amber-700 font-medium uppercase tracking-wider">Aceptadas</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">
            {list.filter((q) => q.status === 'aceptada').length}
          </p>
        </div>
      </div>

      {/* Buscador */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3">
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por número, cliente o cédula..."
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50/60 border-b border-emerald-100">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Número</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cliente</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Total</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Estado</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Creado</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400">Cargando...</td></tr>
            )}
            {filtered.map((q) => (
              <tr key={q._id} className="border-t border-slate-100 hover:bg-emerald-50/30 transition-colors">
                <td className="px-4 py-3 font-semibold text-slate-800">{q.quotationNumber}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">
                    {q.clientName || `${q.patient?.firstName || ''} ${q.patient?.lastName || ''}`.trim() || '—'}
                  </div>
                  {q.clientCedula && <div className="text-xs text-slate-400">{q.clientCedula}</div>}
                </td>
                <td className="px-4 py-3 text-right font-bold text-emerald-700">${Number(q.total || 0).toFixed(2)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-full capitalize ${STATUS_STYLES[q.status] || STATUS_STYLES.borrador}`}>
                    {q.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500 text-xs">{new Date(q.createdAt).toLocaleDateString('es-EC')}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => downloadPdf(q)} className="px-2.5 py-1.5 text-xs bg-sky-50 text-sky-700 rounded-lg hover:bg-sky-100 border-none cursor-pointer flex items-center gap-1">
                      <HiOutlineArrowDownTray className="w-3.5 h-3.5" /> PDF
                    </button>
                    <button onClick={() => sendWhatsapp(q)} className="px-2.5 py-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 border-none cursor-pointer flex items-center gap-1">
                      <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> WhatsApp
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-400">Sin cotizaciones</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal nueva cotización */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nueva cotización" size="xl">
        <form onSubmit={submit} className="space-y-5">
          {/* Sección cliente */}
          <section>
            <h3 className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">Datos del cliente</h3>
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
                }} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                  <option value="">—</option>
                  {patients.map((p) => (
                    <option key={p._id} value={p._id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Válida hasta</span>
                <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Cliente *</span>
                <input value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Cédula/RUC</span>
                <input value={form.clientCedula} onChange={(e) => setForm({ ...form, clientCedula: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Email</span>
                <input type="email" value={form.clientEmail} onChange={(e) => setForm({ ...form, clientEmail: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Teléfono</span>
                <input value={form.clientPhone} onChange={(e) => setForm({ ...form, clientPhone: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
              </label>
            </div>
          </section>

          {/* Sección ítems */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-emerald-700 uppercase tracking-wider">Ítems</h3>
              <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { ...EMPTY_ITEM }] })} className="text-xs px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 border-none cursor-pointer">
                + Agregar ítem
              </button>
            </div>
            <div className="bg-slate-50/50 rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="grid grid-cols-12 gap-2 px-1 hidden sm:grid">
                <span className="col-span-6 text-[11px] font-semibold text-slate-500 uppercase">Producto / Servicio</span>
                <span className="col-span-1 text-[11px] font-semibold text-slate-500 uppercase text-center">Cant.</span>
                <span className="col-span-2 text-[11px] font-semibold text-slate-500 uppercase text-right">P. Unit.</span>
                <span className="col-span-2 text-[11px] font-semibold text-slate-500 uppercase text-right">Desc. (%)</span>
                <span className="col-span-1"></span>
              </div>
              {form.items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-12 sm:col-span-6">
                    <ProductAutocomplete
                      products={products}
                      value={it.product}
                      onSelect={(p) => updateItem(idx, 'product', p?._id || '')}
                      placeholder="Buscar producto/servicio..."
                    />
                  </div>
                  <input type="number" min="1" value={it.quantity} onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value))} className="col-span-3 sm:col-span-1 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white text-center" />
                  <input type="number" step="0.01" value={it.unitPrice} onChange={(e) => updateItem(idx, 'unitPrice', Number(e.target.value))} className="col-span-4 sm:col-span-2 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white text-right" />
                  <input type="number" min="0" max="100" step="1" value={it.discount} onChange={(e) => updateItem(idx, 'discount', Number(e.target.value))} className="col-span-4 sm:col-span-2 border border-slate-200 rounded-lg px-2 py-2 text-sm bg-white text-right" />
                  <button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_, i) => i !== idx) })} className="col-span-1 text-rose-600 hover:text-rose-800 bg-transparent border-none cursor-pointer text-lg">×</button>
                </div>
              ))}
            </div>
          </section>

          {/* Totales */}
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-200 p-4 space-y-1">
            <div className="flex justify-between text-sm text-slate-700"><span>Subtotal:</span><span className="font-medium">${t.subtotal}</span></div>
            <div className="flex justify-between text-sm text-slate-700"><span>Descuento:</span><span className="font-medium">- ${t.discountTotal}</span></div>
            <div className="flex justify-between text-lg font-bold text-emerald-700 pt-2 border-t border-emerald-200"><span>Total:</span><span>${t.total}</span></div>
          </div>

          {/* Notas */}
          <div>
            <label className="text-xs font-bold text-emerald-700 uppercase tracking-wider">Notas / términos</label>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Condiciones de pago, términos, etc." className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-5 py-2.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 bg-white cursor-pointer">Cancelar</button>
            <button type="submit" className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium border-none cursor-pointer shadow-lg shadow-emerald-200/50">Crear cotización</button>
          </div>
        </form>
      </Modal>

      {canManageLogo && (
        <LogoModal
          isOpen={showLogoModal}
          onClose={() => setShowLogoModal(false)}
          clinic={activeClinic}
        />
      )}
    </div>
  );
}

function LogoModal({ isOpen, onClose, clinic }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(clinic?.logoUrl || '');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setPreview(clinic?.logoUrl || ''); setFile(null); }, [clinic, isOpen]);

  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast.error('Máximo 2MB'); return; }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target.result);
    reader.readAsDataURL(f);
  };

  const upload = async () => {
    if (!file) return toast.error('Selecciona una imagen');
    if (!clinic?._id) return toast.error('Sin clínica activa');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      await api.post(`/clinics/${clinic._id}/logo`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Logo actualizado. Recarga para aplicarlo en toda la app.');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al subir logo');
    } finally {
      setSaving(false);
    }
  };

  const removeLogo = async () => {
    if (!clinic?._id) return;
    if (!window.confirm('¿Quitar el logo actual?')) return;
    setSaving(true);
    try {
      await api.delete(`/clinics/${clinic._id}/logo`);
      setPreview('');
      setFile(null);
      toast.success('Logo eliminado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Logo de cotización" size="md">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Sube el logo del consultorio. Aparecerá en la parte superior de las cotizaciones PDF.
        </p>

        <div className="border-2 border-dashed border-slate-300 rounded-xl p-6 flex flex-col items-center gap-3 bg-slate-50/50">
          {preview ? (
            <img src={preview} alt="Logo" className="max-h-32 max-w-full object-contain" />
          ) : (
            <div className="text-slate-400 text-sm flex flex-col items-center gap-2">
              <HiOutlinePhoto className="w-10 h-10" />
              Sin logo configurado
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onPick} className="hidden" />
          <button type="button" onClick={() => fileRef.current?.click()} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 cursor-pointer border-none">
            {preview ? 'Cambiar imagen' : 'Elegir imagen'}
          </button>
          <p className="text-xs text-slate-400">PNG, JPG, WEBP o SVG · Máx. 2MB</p>
        </div>

        <div className="flex justify-between items-center gap-2 pt-2">
          {clinic?.logoUrl && (
            <button onClick={removeLogo} disabled={saving} className="text-xs text-rose-600 hover:underline bg-transparent border-none cursor-pointer flex items-center gap-1">
              <HiOutlineTrash className="w-3.5 h-3.5" /> Quitar logo
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 cursor-pointer">Cerrar</button>
            <button onClick={upload} disabled={!file || saving} className="px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-700 cursor-pointer border-none disabled:opacity-50">
              {saving ? 'Subiendo...' : 'Guardar logo'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
