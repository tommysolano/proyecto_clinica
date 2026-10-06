import { useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { HiOutlineBriefcase, HiOutlinePlus, HiOutlinePencil, HiOutlineDocumentDuplicate } from 'react-icons/hi2';

const empty = { name: '', ruc: '', razonSocial: '', nombreComercial: '', active: true };

const INPUT = 'w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500';

/**
 * EMPRESAS (oct-2026), en la pantalla de Sucursales del super-admin.
 *
 * Cada empresa tiene sus sucursales, su agenda, su personal, sus ventas, su catálogo
 * y su contabilidad; los pacientes y el CRM son de todas. Aquí se crean y editan, y
 * se copia el catálogo de una a otra (la copia queda independiente).
 *
 * Props: companies (con sus `clinics`), onChanged() para recargar.
 */
export default function CompaniesSection({ companies, onChanged }) {
  const [modal, setModal] = useState(null); // null | { editing }
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [copy, setCopy] = useState(null); // empresa destino
  const [fromCompany, setFromCompany] = useState('');

  const openNew = () => { setForm(empty); setModal({ editing: null }); };
  const openEdit = (c) => {
    setForm({ name: c.name || '', ruc: c.ruc || '', razonSocial: c.razonSocial || '', nombreComercial: c.nombreComercial || '', active: c.active !== false });
    setModal({ editing: c });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (modal.editing) await api.put(`/companies/${modal.editing._id}`, form);
      else await api.post('/companies', form);
      toast.success(modal.editing ? 'Empresa actualizada' : 'Empresa creada');
      setModal(null);
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar la empresa');
    } finally {
      setSaving(false);
    }
  };

  const copyCatalog = async () => {
    if (!fromCompany) return;
    setSaving(true);
    try {
      const { data } = await api.post(`/companies/${copy._id}/copy-catalog`, { fromCompany });
      toast.success(`Catálogo copiado: ${data.copied} producto(s) nuevos${data.skipped ? `, ${data.skipped} ya existían` : ''}`);
      setCopy(null);
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al copiar el catálogo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-emerald-50">
        <div>
          <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
            <HiOutlineBriefcase className="w-5 h-5 text-emerald-600" /> Empresas
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Cada empresa lleva su agenda, personal, ventas, catálogo y contabilidad. Pacientes y CRM son de todas.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 border border-emerald-200 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-xl text-sm font-medium cursor-pointer bg-white"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nueva empresa
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50/50 text-emerald-700">
            <tr>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Empresa</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">RUC</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Sucursales</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase">Estado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                <td className="px-5 py-3 text-slate-800 font-medium">
                  {c.name}
                  {c.isDefault && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">principal</span>}
                </td>
                <td className="px-5 py-3 font-mono text-xs">{c.ruc || '—'}</td>
                <td className="px-5 py-3 text-slate-600 text-sm">
                  {(c.clinics || []).filter((s) => s.active !== false).map((s) => s.nombreComercial || s.name).join(', ') || '—'}
                </td>
                <td className="px-5 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${c.active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                    {c.active !== false ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  {companies.length > 1 && (
                    <button
                      onClick={() => { setFromCompany(''); setCopy(c); }}
                      className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                      title="Copiar el catálogo de otra empresa"
                    >
                      <HiOutlineDocumentDuplicate className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => openEdit(c)}
                    className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer ml-1"
                    title="Editar"
                  >
                    <HiOutlinePencil className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!modal} onClose={() => setModal(null)} title={modal?.editing ? 'Editar empresa' : 'Nueva empresa'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm font-medium text-slate-700">Nombre *
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${INPUT} mt-1.5`} />
            </label>
            <label className="block text-sm font-medium text-slate-700">RUC (13 dígitos)
              <input value={form.ruc} maxLength={13} inputMode="numeric" onChange={(e) => setForm({ ...form, ruc: e.target.value })} className={`${INPUT} mt-1.5`} />
            </label>
            <label className="block text-sm font-medium text-slate-700">Razón social
              <input value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} className={`${INPUT} mt-1.5`} />
            </label>
            <label className="block text-sm font-medium text-slate-700">Nombre comercial
              <input value={form.nombreComercial} onChange={(e) => setForm({ ...form, nombreComercial: e.target.value })} className={`${INPUT} mt-1.5`} />
            </label>
          </div>
          {modal?.editing && !modal.editing.isDefault && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Empresa activa
            </label>
          )}
          {!modal?.editing && (
            <p className="text-xs text-slate-500">
              Después crea sus sucursales (botón «Nueva sucursal», eligiendo esta empresa) y, si quieres, copia el catálogo de otra empresa.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModal(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white">Cancelar</button>
            <button type="submit" disabled={saving} className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none">
              {saving ? 'Guardando...' : modal?.editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!copy} onClose={() => setCopy(null)} title={`Copiar catálogo a ${copy?.name || ''}`}>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">Copiar desde
            <select value={fromCompany} onChange={(e) => setFromCompany(e.target.value)} className={`${INPUT} mt-1.5`}>
              <option value="">Seleccionar empresa…</option>
              {companies.filter((c) => c._id !== copy?._id).map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </label>
          <ul className="text-xs text-slate-500 list-disc pl-5 space-y-1">
            <li>Se copian productos, servicios y programas con sus precios, IVA y composición, y la duración y configuración de agenda de cada servicio.</li>
            <li>Después de copiar son <b>independientes</b>: cambiar un precio en una empresa no toca la otra.</li>
            <li>El stock arranca en cero. Las cuentas contables se asignan por código si existen en el plan de cuentas de {copy?.name}; si no, quedan por definir.</li>
            <li>Lo que ya existe en {copy?.name} con el mismo código no se toca: se puede repetir sin duplicar.</li>
          </ul>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCopy(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white">Cancelar</button>
            <button type="button" disabled={saving || !fromCompany} onClick={copyCatalog} className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none">
              {saving ? 'Copiando...' : 'Copiar catálogo'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
