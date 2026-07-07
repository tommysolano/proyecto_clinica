import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SriStatus from '../components/SriStatus';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import EmailStatus from '../components/EmailStatus';
import useEmailValidation from '../hooks/useEmailValidation';
import { useAuth } from '../context/AuthContext';
import { HiOutlineBuildingOffice2, HiOutlinePlus, HiOutlinePencil, HiOutlineTrash } from 'react-icons/hi2';

const empty = {
  name: '',
  ruc: '',
  razonSocial: '',
  nombreComercial: '',
  address: '',
  phone: '',
  email: '',
};

export default function Clinics() {
  const { user, refreshMe } = useAuth();
  const isSuper = !!user?.isSuperAdmin;

  const [clinics, setClinics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);

  // Autocompletado por RUC desde el SRI (razón social, nombre comercial, dirección).
  const rucLookup = useSriLookup(form.ruc, {
    enabled: modalOpen,
    onData: (d, prev) => {
      setForm((f) => ({
        ...f,
        razonSocial: fillField(f.razonSocial, d.found ? d.fullName || '' : '', prev?.fullName),
        nombreComercial: fillField(f.nombreComercial, d.found ? d.commercialName || '' : '', prev?.commercialName),
        address: fillField(f.address, d.found ? d.address || '' : '', prev?.address),
      }));
    },
  });
  const emailCheck = useEmailValidation(form.email, { enabled: modalOpen });

  // Consolidado por sucursal
  const todayStr = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const [overview, setOverview] = useState(null);
  const [range, setRange] = useState({ startDate: firstOfMonth, endDate: todayStr });
  const [loadingOverview, setLoadingOverview] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/clinics');
      setClinics(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar sucursales');
    } finally {
      setLoading(false);
    }
  };

  const loadOverview = async () => {
    setLoadingOverview(true);
    try {
      const res = await api.get('/clinics/overview', { params: range });
      setOverview(res.data);
    } catch {
      setOverview(null);
    } finally {
      setLoadingOverview(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.startDate, range.endDate]);

  const money = (n) =>
    `$${Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const openNew = () => {
    setEditing(null);
    setForm(empty);
    setModalOpen(true);
  };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      name: c.name || '',
      ruc: c.ruc || '',
      razonSocial: c.razonSocial || '',
      nombreComercial: c.nombreComercial || '',
      address: c.address || '',
      phone: c.phone || '',
      email: c.email || '',
    });
    setModalOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/clinics/${editing._id}`, form);
        toast.success('Sucursal actualizada');
      } else {
        await api.post('/clinics', form);
        toast.success('Sucursal creada');
      }
      setModalOpen(false);
      await load();
      await refreshMe?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`¿Desactivar "${c.name}"?`)) return;
    try {
      await api.delete(`/clinics/${c._id}`);
      toast.success('Sucursal desactivada');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al desactivar');
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineBuildingOffice2 className="w-7 h-7 text-emerald-600" />
          Sucursales
        </h1>
        {isSuper && (
          <button
            onClick={openNew}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50"
          >
            <HiOutlinePlus className="w-5 h-5" /> Nueva sucursal
          </button>
        )}
      </div>

      {/* Consolidado por sucursal */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-emerald-50">
          <h2 className="text-base font-semibold text-slate-800">Consolidado por sucursal</h2>
          <div className="flex items-center gap-2 text-sm">
            <input
              type="date"
              value={range.startDate}
              onChange={(e) => setRange((r) => ({ ...r, startDate: e.target.value }))}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-slate-50/50"
            />
            <span className="text-slate-400">—</span>
            <input
              type="date"
              value={range.endDate}
              onChange={(e) => setRange((r) => ({ ...r, endDate: e.target.value }))}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-slate-50/50"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead className="bg-emerald-50/50 text-emerald-700">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Sucursal</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase"># Ventas</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">Vendido</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">Citas</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">Pend.</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">Asist.</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">No asist.</th>
                <th className="text-right px-3 py-3 text-xs font-semibold uppercase">Inventario (u/valor)</th>
              </tr>
            </thead>
            <tbody>
              {loadingOverview ? (
                <tr><td colSpan={8} className="text-center py-8 text-slate-500">Cargando consolidado...</td></tr>
              ) : !overview || overview.clinics.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-slate-400">Sin datos en el rango.</td></tr>
              ) : (
                <>
                  {overview.clinics.map((c) => (
                    <tr key={c._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                      <td className="px-5 py-3 text-slate-800 font-medium">{c.name}</td>
                      <td className="px-3 py-3 text-right text-slate-600">{c.sales.count}</td>
                      <td className="px-3 py-3 text-right font-semibold text-emerald-700">{money(c.sales.total)}</td>
                      <td className="px-3 py-3 text-right text-slate-600">{c.appointments.total}</td>
                      <td className="px-3 py-3 text-right text-amber-600">{c.appointments.pendiente}</td>
                      <td className="px-3 py-3 text-right text-emerald-600">{c.appointments.asistida}</td>
                      <td className="px-3 py-3 text-right text-red-500">{c.appointments.no_asistio}</td>
                      <td className="px-3 py-3 text-right text-slate-600">
                        {c.inventory.units} u · {money(c.inventory.value)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-emerald-100 bg-emerald-50/40 font-semibold text-slate-800">
                    <td className="px-5 py-3">TOTAL EMPRESA</td>
                    <td className="px-3 py-3 text-right">{overview.totals.sales.count}</td>
                    <td className="px-3 py-3 text-right text-emerald-700">{money(overview.totals.sales.total)}</td>
                    <td className="px-3 py-3 text-right">{overview.totals.appointments.total}</td>
                    <td className="px-3 py-3 text-right text-amber-600">{overview.totals.appointments.pendiente}</td>
                    <td className="px-3 py-3 text-right text-emerald-600">{overview.totals.appointments.asistida}</td>
                    <td className="px-3 py-3 text-right text-red-500">{overview.totals.appointments.no_asistio}</td>
                    <td className="px-3 py-3 text-right">{overview.totals.inventory.units} u · {money(overview.totals.inventory.value)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50/50 text-emerald-700">
            <tr>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Nombre</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">RUC</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Razón social</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Email</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Estado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-10 text-slate-500">Cargando...</td></tr>
            ) : clinics.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-10 text-slate-500">Sin sucursales.</td></tr>
            ) : (
              clinics.map((c) => (
                <tr key={c._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                  <td className="px-5 py-3 text-slate-800 font-medium">{c.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{c.ruc || '—'}</td>
                  <td className="px-5 py-3 text-slate-600">{c.razonSocial || '—'}</td>
                  <td className="px-5 py-3 text-slate-600">{c.email || '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${c.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {c.active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => openEdit(c)}
                      className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                      title="Editar"
                    >
                      <HiOutlinePencil className="w-4 h-4" />
                    </button>
                    {isSuper && c.active && (
                      <button
                        onClick={() => remove(c)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer ml-1"
                        title="Desactivar"
                      >
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar sucursal' : 'Nueva sucursal'}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Nombre *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
            <Field
              label="RUC (13 dígitos)"
              value={form.ruc}
              onChange={(v) => setForm({ ...form, ruc: v })}
              maxLength={13}
              inputMode="numeric"
            >
              <SriStatus status={rucLookup} />
            </Field>
            <Field label="Razón social" value={form.razonSocial} onChange={(v) => setForm({ ...form, razonSocial: v })} />
            <Field label="Nombre comercial" value={form.nombreComercial} onChange={(v) => setForm({ ...form, nombreComercial: v })} />
            <Field label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })}>
              <EmailStatus status={emailCheck} onApplySuggestion={(s) => setForm({ ...form, email: s })} />
            </Field>
            <Field label="Teléfono" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          </div>
          <Field label="Dirección" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', required, maxLength, inputMode, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
      <input
        type={type}
        required={required}
        maxLength={maxLength}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
      />
      {children}
    </div>
  );
}
