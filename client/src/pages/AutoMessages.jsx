import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineBolt,
  HiOutlineCheckCircle,
  HiOutlineXCircle,
} from 'react-icons/hi2';

const TRIGGERS = [
  { value: 'welcome', label: 'Bienvenida (nuevo chat)' },
  { value: 'incoming', label: 'Cuando llega un mensaje' },
  { value: 'out_of_hours', label: 'Fuera de horario' },
  { value: 'scheduled', label: 'Programado a una hora del día' },
];

const AUDIENCES = [
  { value: 'all', label: 'Todos los contactos' },
  { value: 'new', label: 'Solo contactos nuevos (sin paciente)' },
  { value: 'existing', label: 'Solo pacientes registrados' },
];

const DAYS = [
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
  body: '',
  trigger: 'incoming',
  audience: 'all',
  active: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  hourFrom: '08:00',
  hourTo: '18:00',
  scheduledAt: '',
};

export default function AutoMessages() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/chats/auto-messages');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setModalOpen(true);
  };

  const openEdit = (m) => {
    setEditing(m._id);
    setForm({
      name: m.name || '',
      body: m.body || '',
      trigger: m.trigger || 'incoming',
      audience: m.audience || 'all',
      active: !!m.active,
      days: Array.isArray(m.days) ? m.days : [0, 1, 2, 3, 4, 5, 6],
      hourFrom: m.hourFrom || '08:00',
      hourTo: m.hourTo || '18:00',
      scheduledAt: m.scheduledAt || '',
    });
    setModalOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.body.trim()) {
      toast.error('Nombre y mensaje son obligatorios');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/chats/auto-messages/${editing}`, form);
        toast.success('Mensaje actualizado');
      } else {
        await api.post('/chats/auto-messages', form);
        toast.success('Mensaje creado');
      }
      setModalOpen(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar este mensaje automático?')) return;
    try {
      await api.delete(`/chats/auto-messages/${id}`);
      toast.success('Eliminado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const toggleDay = (d) => {
    setForm((f) => ({
      ...f,
      days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort(),
    }));
  };

  const triggerLabel = (v) => TRIGGERS.find((t) => t.value === v)?.label || v;
  const audienceLabel = (v) => AUDIENCES.find((a) => a.value === v)?.label || v;

  const counts = useMemo(
    () => ({
      total: list.length,
      active: list.filter((x) => x.active).length,
    }),
    [list]
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <HiOutlineBolt className="w-5 h-5" />
            </span>
            Mensajes automáticos
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Configura respuestas que se envían automáticamente según horarios, días y tipo de
            contacto.
          </p>
        </div>
        <button
          onClick={openNew}
          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 flex items-center gap-2"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nuevo mensaje automático
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl border border-emerald-100 p-4">
          <p className="text-xs text-emerald-700 font-medium uppercase tracking-wider">Total</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{counts.total}</p>
        </div>
        <div className="bg-gradient-to-br from-sky-50 to-indigo-50 rounded-2xl border border-sky-100 p-4">
          <p className="text-xs text-sky-700 font-medium uppercase tracking-wider">Activos</p>
          <p className="text-3xl font-bold text-slate-800 mt-1">{counts.active}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50/60 border-b border-emerald-100">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Nombre
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Disparador
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Audiencia
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Horario
              </th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Activo
              </th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                Acciones
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center py-6 text-slate-400">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-10 text-slate-400">
                  Sin mensajes configurados. Crea el primero arriba.
                </td>
              </tr>
            )}
            {list.map((m) => (
              <tr key={m._id} className="border-t border-slate-100 hover:bg-emerald-50/30">
                <td className="px-4 py-3">
                  <div className="font-semibold text-slate-800">{m.name}</div>
                  <div className="text-xs text-slate-500 truncate max-w-xs">{m.body}</div>
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  {triggerLabel(m.trigger)}
                  {m.trigger === 'scheduled' && m.scheduledAt && (
                    <div className="text-emerald-700 font-semibold mt-0.5">a las {m.scheduledAt}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-600">{audienceLabel(m.audience)}</td>
                <td className="px-4 py-3 text-xs text-slate-600">
                  {m.hourFrom} – {m.hourTo}
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {(m.days || []).length === 7
                      ? 'Todos los días'
                      : (m.days || [])
                          .map((d) => DAYS.find((x) => x.v === d)?.l || d)
                          .join(', ')}
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  {m.active ? (
                    <HiOutlineCheckCircle className="w-5 h-5 text-emerald-600 inline" />
                  ) : (
                    <HiOutlineXCircle className="w-5 h-5 text-slate-300 inline" />
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    onClick={() => openEdit(m)}
                    className="p-1.5 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                    title="Editar"
                  >
                    <HiOutlinePencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => remove(m._id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"
                    title="Eliminar"
                  >
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar mensaje automático' : 'Nuevo mensaje automático'}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm">
            Nombre interno
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              required
            />
          </label>

          <label className="block text-sm">
            Mensaje (se envía tal cual)
            <textarea
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={4}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
              required
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              Disparador
              <select
                value={form.trigger}
                onChange={(e) => setForm({ ...form, trigger: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              >
                {TRIGGERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              Aplicar a
              <select
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              >
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {form.trigger === 'scheduled' && (
            <label className="block text-sm">
              Hora del envío programado (HH:MM)
              <input
                type="time"
                value={form.scheduledAt}
                onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                required
              />
            </label>
          )}

          <div>
            <p className="text-sm font-medium text-slate-700 mb-1">Días en los que se activa</p>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d) => {
                const on = form.days.includes(d.v);
                return (
                  <button
                    key={d.v}
                    type="button"
                    onClick={() => toggleDay(d.v)}
                    className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${
                      on
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-slate-600 border-slate-200'
                    }`}
                  >
                    {d.l}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Desde
              <input
                type="time"
                value={form.hourFrom}
                onChange={(e) => setForm({ ...form, hourFrom: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              Hasta
              <input
                type="time"
                value={form.hourTo}
                onChange={(e) => setForm({ ...form, hourTo: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="w-4 h-4 accent-emerald-600"
            />
            Activo (se enviará cuando se cumplan las condiciones)
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 bg-white cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium border-none cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
