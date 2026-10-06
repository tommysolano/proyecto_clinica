import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SriStatus from '../components/SriStatus';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import EmailStatus from '../components/EmailStatus';
import useEmailValidation from '../hooks/useEmailValidation';
import { nombreSucursal } from '../utils/clinicName';
import { useAuth } from '../context/AuthContext';
import { HiOutlineBuildingOffice2, HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import CompaniesSection from '../components/CompaniesSection';

const empty = {
  name: '',
  ruc: '',
  razonSocial: '',
  nombreComercial: '',
  address: '',
  phone: '',
  email: '',
  company: '',
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
  // Empresas (oct-2026): solo el super-admin las gestiona y mueve sucursales entre ellas.
  const [companies, setCompanies] = useState([]);
  const [moving, setMoving] = useState(null); // sucursal que se mueve
  const [moveTo, setMoveTo] = useState('');

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

  const loadCompanies = async () => {
    if (!isSuper) return;
    try {
      const res = await api.get('/companies', { params: { active: 'all' } });
      setCompanies(res.data || []);
    } catch {
      setCompanies([]);
    }
  };

  useEffect(() => {
    load();
    loadCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * MOVER A OTRA EMPRESA. Nace una sucursal nueva en la empresa destino con el
   * personal, las citas por venir y los consultorios; esta queda inactiva con su
   * historial (ventas, facturas, contabilidad), que es de la empresa donde se emitió.
   */
  const move = async () => {
    if (!moveTo) return;
    setSaving(true);
    try {
      const { data } = await api.post(`/clinics/${moving._id}/move`, { company: moveTo });
      const m = data.moved || {};
      toast.success(`Sucursal movida: ${m.staff || 0} persona(s), ${m.appointments || 0} cita(s) por venir y ${m.rooms || 0} consultorio(s)`);
      setMoving(null);
      await Promise.all([load(), loadCompanies()]);
      await refreshMe?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al mover la sucursal');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.startDate, range.endDate]);

  const money = (n) =>
    `$${Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const openNew = () => {
    setEditing(null);
    // Por defecto, la empresa principal.
    setForm({ ...empty, company: companies.find((c) => c.isDefault)?._id || companies[0]?._id || '' });
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
      company: c.company?._id || c.company || '',
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

      {isSuper && <CompaniesSection companies={companies} onChanged={() => { loadCompanies(); load(); }} />}

      {/* Consolidado por sucursal */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-emerald-50">
          {/* De la empresa de la sucursal activa: cada empresa compara las suyas. */}
          <h2 className="text-base font-semibold text-slate-800">Consolidado por sucursal de la empresa</h2>
          <div className="flex items-center gap-2 text-sm">
            <DateInput
              value={range.startDate}
              onChange={(e) => setRange((r) => ({ ...r, startDate: e.target.value }))}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-slate-50/50"
            />
            <span className="text-slate-400">—</span>
            <DateInput
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
              {/* El nombre VISIBLE, que es el comercial si lo tiene: esta columna
                  enseñaba el legal, así que renombrar una sede aquí parecía no
                  hacer nada en el resto del sistema (ver `nombreSucursal`). */}
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Nombre visible</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Empresa</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">RUC</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Razón social</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Email</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Estado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-10 text-slate-500">Cargando...</td></tr>
            ) : clinics.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-10 text-slate-500">Sin sucursales.</td></tr>
            ) : (
              clinics.map((c) => (
                <tr key={c._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                  <td className="px-5 py-3 text-slate-800 font-medium">
                    {nombreSucursal(c)}
                    {c.nombreComercial && c.nombreComercial !== c.name && (
                      <span className="block text-[11px] font-normal text-slate-400">
                        Nombre legal: {c.name}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-600 text-sm">{c.company?.name || '—'}</td>
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
                    {isSuper && c.active && companies.length > 1 && (
                      <button
                        onClick={() => { setMoveTo(''); setMoving(c); }}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer ml-1"
                        title="Mover a otra empresa"
                      >
                        <HiOutlineArrowsRightLeft className="w-4 h-4" />
                      </button>
                    )}
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
          {/* La empresa se elige al crear; cambiarla después es «Mover a otra empresa». */}
          {isSuper && companies.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Empresa *</label>
              {editing ? (
                <p className="px-4 py-2.5 rounded-xl text-sm bg-slate-50 border border-slate-100 text-slate-600">
                  {editing.company?.name || '—'}
                </p>
              ) : (
                <select
                  required
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                >
                  <option value="">Seleccionar empresa</option>
                  {companies.filter((c) => c.active !== false).map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              )}
            </div>
          )}
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
            {/**
              * CUÁL DE LOS DOS NOMBRES SE VE, dicho aquí.
              *
              * `nombreComercial` gana sobre `name` en TODA la aplicación (ver
              * `nombreSucursal`), y eso no se adivinaba: al renombrar una sede
              * se editaba «Nombre» —que es la columna de esta misma tabla—, se
              * guardaba, y la agenda seguía llamándola como antes. Parecía que
              * el cambio no funcionaba.
              */}
            <Field label="Nombre comercial" value={form.nombreComercial} onChange={(v) => setForm({ ...form, nombreComercial: v })}>
              <p className="text-[11px] text-slate-500 mt-1">
                Es el nombre que se ve en <b>toda la aplicación</b>: agenda, selector de
                sucursal, recetas y hoja clínica. Si lo dejas vacío se usa el «Nombre».
                {(form.nombreComercial || form.name) && (
                  <>
                    {' '}Se verá como <b>{form.nombreComercial || form.name}</b>.
                  </>
                )}
              </p>
            </Field>
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

      <Modal isOpen={!!moving} onClose={() => setMoving(null)} title={`Mover ${moving ? nombreSucursal(moving) : ''} a otra empresa`}>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">Empresa destino
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="w-full mt-1.5 px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
            >
              <option value="">Seleccionar empresa…</option>
              {companies
                .filter((c) => c.active !== false && String(c._id) !== String(moving?.company?._id || moving?.company))
                .map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </label>
          <ul className="text-xs text-slate-500 list-disc pl-5 space-y-1">
            <li>Se crea la sucursal en la empresa destino y pasan a ella el <b>personal</b>, las <b>citas por venir</b>, los bloqueos de agenda por venir y los consultorios.</li>
            <li>El <b>historial se queda</b> en {moving?.company?.name || 'su empresa'}: ventas, facturas, caja, contabilidad y citas pasadas (son de ese RUC). Esta sucursal queda inactiva allí.</li>
            <li>En la empresa destino hay que configurar la facturación electrónica (certificado y puntos de emisión) de la sucursal.</li>
          </ul>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setMoving(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white">Cancelar</button>
            <button type="button" disabled={saving || !moveTo} onClick={move} className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none">
              {saving ? 'Moviendo...' : 'Mover sucursal'}
            </button>
          </div>
        </div>
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
