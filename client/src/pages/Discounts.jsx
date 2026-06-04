import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { HiOutlinePlus, HiOutlineTag, HiOutlineTrash, HiOutlinePencilSquare } from 'react-icons/hi2';

const DAYS = [['Dom', 0], ['Lun', 1], ['Mar', 2], ['Mié', 3], ['Jue', 4], ['Vie', 5], ['Sáb', 6]];
const AUDIENCES = [['todos', 'Todos'], ['nuevos', 'Pacientes nuevos'], ['recurrentes', 'Pacientes recurrentes'], ['cumpleanos', 'Cumpleañeros']];

const EMPTY = {
  name: '',
  type: 'percentage',
  value: 0,
  scope: 'all',
  products: [],
  startDate: '',
  endDate: '',
  daysOfWeek: [],
  startTime: '',
  endTime: '',
  clinics: [],
  audience: 'todos',
  minAmount: 0,
  maxUses: 0,
  active: true,
};

export default function Discounts() {
  const { clinics = [] } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [products, setProducts] = useState([]);

  const toggleDay = (d) => setForm((f) => ({ ...f, daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d] }));
  const toggleClinic = (id) => setForm((f) => ({ ...f, clinics: f.clinics.includes(id) ? f.clinics.filter((x) => x !== id) : [...f.clinics, id] }));

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/discounts');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/products').then((r) => setProducts(r.data.products || r.data || []));
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) {
        await api.put(`/discounts/${editing._id}`, form);
        toast.success('Descuento actualizado');
      } else {
        await api.post('/discounts', form);
        toast.success('Descuento creado');
      }
      setShowModal(false);
      setEditing(null);
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const openEdit = (d) => {
    setEditing(d);
    setForm({
      name: d.name,
      type: d.type,
      value: d.value,
      scope: d.scope,
      products: (d.products || []).map((p) => p._id || p),
      startDate: (d.startDate || '').slice(0, 10),
      endDate: (d.endDate || '').slice(0, 10),
      daysOfWeek: d.daysOfWeek || [],
      startTime: d.startTime || '',
      endTime: d.endTime || '',
      clinics: (d.clinics || []).map((c) => c._id || c),
      audience: d.audience || 'todos',
      minAmount: d.minAmount || 0,
      maxUses: d.maxUses || 0,
      active: d.active,
    });
    setShowModal(true);
  };

  const remove = async (d) => {
    if (!confirm('¿Eliminar descuento?')) return;
    try {
      await api.delete(`/discounts/${d._id}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineTag className="text-emerald-600" /> Descuentos
          </h1>
          <p className="text-sm text-slate-500">
            Cumple con la normativa SRI: los descuentos se aplican por ítem y se reportan en la factura electrónica.
          </p>
        </div>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShowModal(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700">
          <HiOutlinePlus className="w-4 h-4" /> Nuevo descuento
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Tipo</th>
              <th className="text-left px-3 py-2">Valor</th>
              <th className="text-left px-3 py-2">Alcance</th>
              <th className="text-left px-3 py-2">Vigencia</th>
              <th className="text-left px-3 py-2">Activo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-4 text-slate-400">Cargando...</td></tr>}
            {list.map((d) => (
              <tr key={d._id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">{d.name}</td>
                <td className="px-3 py-2">{d.type === 'percentage' ? '% Porcentaje' : '$ Valor'}</td>
                <td className="px-3 py-2">{d.type === 'percentage' ? `${d.value}%` : `$${d.value}`}</td>
                <td className="px-3 py-2">{d.scope === 'all' ? 'Todos' : `${(d.products || []).length} productos`}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {(d.startDate || '').slice(0, 10) || '—'} → {(d.endDate || '').slice(0, 10) || '—'}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-2 py-1 rounded ${d.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                    {d.active ? 'Sí' : 'No'}
                  </span>
                </td>
                <td className="px-3 py-2 flex gap-1">
                  <button onClick={() => openEdit(d)} className="p-1 text-sky-600 hover:bg-sky-50 rounded"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(d)} className="p-1 text-rose-600 hover:bg-rose-50 rounded"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {!loading && list.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-slate-400">Sin descuentos</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Editar descuento' : 'Nuevo descuento'}>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Nombre</span>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Tipo</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="percentage">Porcentaje (%)</option>
                <option value="amount">Valor ($)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Valor</span>
              <input type="number" step="0.01" required value={form.value} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Alcance</span>
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
              <option value="all">Todos los productos</option>
              <option value="specific">Productos específicos</option>
            </select>
          </label>
          {form.scope === 'specific' && (
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Productos aplicables</span>
              <select multiple value={form.products} onChange={(e) => setForm({ ...form, products: Array.from(e.target.selectedOptions, (o) => o.value) })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm h-32">
                {products.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Inicio</span>
              <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Fin</span>
              <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
          </div>
          {/* Parametrizaciones */}
          <div className="border-t pt-3 space-y-3">
            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Parametrizaciones</p>

            <div>
              <span className="text-xs font-medium text-slate-600">Días de la semana <span className="text-slate-400">(vacío = todos)</span></span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {DAYS.map(([label, n]) => (
                  <button type="button" key={n} onClick={() => toggleDay(n)} className={`px-2.5 py-1 rounded-lg text-xs border ${form.daysOfWeek.includes(n) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{label}</button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="text-xs font-medium text-slate-600">Hora desde</span>
                <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
              <label className="block"><span className="text-xs font-medium text-slate-600">Hora hasta</span>
                <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
            </div>

            {clinics.length > 1 && (
              <div>
                <span className="text-xs font-medium text-slate-600">Sucursales <span className="text-slate-400">(vacío = todas)</span></span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {clinics.map((c) => (
                    <button type="button" key={c._id} onClick={() => toggleClinic(c._id)} className={`px-2.5 py-1 rounded-lg text-xs border ${form.clinics.includes(c._id) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{c.name}</button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <label className="block"><span className="text-xs font-medium text-slate-600">Público objetivo</span>
                <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                  {AUDIENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="block"><span className="text-xs font-medium text-slate-600">Compra mínima ($)</span>
                <input type="number" step="0.01" value={form.minAmount} onChange={(e) => setForm({ ...form, minAmount: Number(e.target.value) })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" />
              </label>
              <label className="block"><span className="text-xs font-medium text-slate-600">Límite de usos <span className="text-slate-400">(0=∞)</span></span>
                <input type="number" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-right" />
              </label>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Activo
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">Cancelar</button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Guardar</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
