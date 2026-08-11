import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import { fmtDate } from '../utils/date';
import {
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlinePencilSquare,
  HiOutlineNoSymbol,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';

const WEEKDAYS = [
  { v: 1, l: 'Lun' },
  { v: 2, l: 'Mar' },
  { v: 3, l: 'Mié' },
  { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' },
  { v: 6, l: 'Sáb' },
  { v: 0, l: 'Dom' },
];

const EMPTY = {
  name: '',
  active: true,
  mode: 'recurring',
  weekdays: [],
  date: new Date().toISOString().slice(0, 10),
  allDay: false,
  startTime: '19:00',
  endTime: '06:00',
  exceptUsers: [],
};

// Texto legible de "cuándo aplica".
const whenText = (b) => {
  if (b.mode === 'date') return fmtDate(b.date);
  if (!b.weekdays || b.weekdays.length === 0) return 'Todos los días';
  return WEEKDAYS.filter((d) => b.weekdays.includes(d.v)).map((d) => d.l).join(', ');
};
const scheduleText = (b) => (b.allDay ? 'Todo el día' : `${b.startTime}–${b.endTime}`);

export default function AccessBlocks() {
  const [list, setList] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/access-blocks');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    api.get('/users', { params: { all: 1 } }).then((r) => setUsers(r.data || [])).catch(() => {});
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setShowModal(true);
  };

  const openEdit = (b) => {
    setEditing(b);
    setForm({
      name: b.name || '',
      active: b.active,
      mode: b.mode || 'recurring',
      weekdays: b.weekdays || [],
      date: b.date || new Date().toISOString().slice(0, 10),
      allDay: !!b.allDay,
      startTime: b.startTime || '19:00',
      endTime: b.endTime || '06:00',
      exceptUsers: (b.exceptUsers || []).map((u) => u._id || u),
    });
    setShowModal(true);
  };

  const toggleWeekday = (v) =>
    setForm((f) => ({
      ...f,
      weekdays: f.weekdays.includes(v) ? f.weekdays.filter((x) => x !== v) : [...f.weekdays, v],
    }));

  const toggleExcept = (uid) =>
    setForm((f) => ({
      ...f,
      exceptUsers: f.exceptUsers.includes(uid)
        ? f.exceptUsers.filter((x) => x !== uid)
        : [...f.exceptUsers, uid],
    }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.mode === 'date' && !form.date) {
      toast.error('Selecciona una fecha');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/access-blocks/${editing._id}`, form);
        toast.success('Bloqueo actualizado');
      } else {
        await api.post('/access-blocks', form);
        toast.success('Bloqueo creado');
      }
      setShowModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (b) => {
    try {
      await api.put(`/access-blocks/${b._id}`, { ...b, active: !b.active, exceptUsers: (b.exceptUsers || []).map((u) => u._id || u) });
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (b) => {
    if (!confirm('¿Eliminar esta regla de bloqueo de acceso?')) return;
    try {
      await api.delete(`/access-blocks/${b._id}`);
      toast.success('Bloqueo eliminado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={HiOutlineNoSymbol}
        title="Bloqueo de acceso al sistema"
        subtitle="Impide el ingreso de los usuarios en los horarios o días que definas. El super-admin y los usuarios exceptuados nunca se bloquean."
      >
        <button
          onClick={openNew}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700 cursor-pointer border-none"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nueva regla
        </button>
      </PageHeader>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Nombre</th>
              <th className="text-left px-4 py-2.5 font-semibold">Cuándo</th>
              <th className="text-left px-4 py-2.5 font-semibold">Horario</th>
              <th className="text-left px-4 py-2.5 font-semibold">Excepciones</th>
              <th className="text-left px-4 py-2.5 font-semibold">Estado</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-6 text-slate-400">Cargando...</td></tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={HiOutlineNoSymbol}
                    title="Sin reglas de bloqueo"
                    hint="Crea una regla para restringir el acceso al sistema por horario o día."
                  />
                </td>
              </tr>
            )}
            {list.map((b) => (
              <tr key={b._id} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2.5 text-slate-800 font-medium">
                  {b.name || <span className="text-slate-400 italic">Sin nombre</span>}
                  <div className="text-[11px] text-slate-400">{b.mode === 'date' ? 'Fecha específica' : 'Recurrente'}</div>
                </td>
                <td className="px-4 py-2.5 text-slate-600">{whenText(b)}</td>
                <td className="px-4 py-2.5 text-slate-600">{scheduleText(b)}</td>
                <td className="px-4 py-2.5 text-slate-600">
                  {(b.exceptUsers || []).length === 0 ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <span className="text-xs">{b.exceptUsers.map((u) => u.name).join(', ')}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => toggleActive(b)}
                    className={`text-xs px-2 py-0.5 rounded-full cursor-pointer border-none ${
                      b.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {b.active ? 'Activa' : 'Inactiva'}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => openEdit(b)} className="p-1 text-slate-500 hover:text-emerald-600 cursor-pointer bg-transparent border-none" title="Editar">
                      <HiOutlinePencilSquare className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(b)} className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer bg-transparent border-none" title="Eliminar">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Editar bloqueo' : 'Nueva regla de bloqueo'}>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Nombre / motivo (opcional)</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Ej. Cierre nocturno"
              className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            />
          </label>

          {/* Tipo: recurrente vs fecha específica */}
          <div>
            <span className="text-xs font-medium text-slate-600 block mb-1.5">Tipo de bloqueo</span>
            <div className="flex gap-2">
              {[
                { v: 'recurring', l: 'Recurrente (días de la semana)' },
                { v: 'date', l: 'Fecha específica' },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setForm({ ...form, mode: opt.v })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                    form.mode === opt.v ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'
                  }`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>

          {form.mode === 'recurring' ? (
            <div>
              <span className="text-xs font-medium text-slate-600 block mb-1.5">
                Días (ninguno seleccionado = todos los días)
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, weekdays: [] })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                    form.weekdays.length === 0 ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'
                  }`}
                >
                  Todos
                </button>
                {WEEKDAYS.map((d) => (
                  <button
                    key={d.v}
                    type="button"
                    onClick={() => toggleWeekday(d.v)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer border ${
                      form.weekdays.includes(d.v) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'
                    }`}
                  >
                    {d.l}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Fecha</span>
              <DateInput
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
              />
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} />
            Bloquear todo el día
          </label>

          {!form.allDay && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Desde</span>
                <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Hasta</span>
                <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
              <p className="col-span-2 text-[11px] text-slate-400">
                Si la hora "hasta" es menor que la "desde", el bloqueo cruza la medianoche (ej. 19:00 → 06:00).
              </p>
            </div>
          )}

          {/* Excepciones */}
          <div>
            <span className="text-xs font-medium text-slate-600 block mb-1.5">
              Usuarios exceptuados (no se les bloquea)
            </span>
            <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
              {users.length === 0 && <p className="text-xs text-slate-400 p-3">No hay usuarios.</p>}
              {users.map((u) => (
                <label key={u._id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" checked={form.exceptUsers.includes(u._id)} onChange={() => toggleExcept(u._id)} />
                  <span className="text-slate-700">{u.name}</span>
                  <span className="text-xs text-slate-400">{u.email}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Regla activa
          </label>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer bg-white text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer border-none text-sm">
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
