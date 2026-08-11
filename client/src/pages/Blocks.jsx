import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineNoSymbol } from 'react-icons/hi2';
import { fmtDate } from '../utils/date';
import DateInput from '../components/DateInput';

const EMPTY = {
  doctor: '',
  room: '',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  allDay: true,
  startTime: '08:00',
  endTime: '18:00',
  reason: '',
};

export default function Blocks() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [doctors, setDoctors] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/time-blocks');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.all([
      api.get('/users').then((r) => setDoctors(r.data || [])),
      api.get('/rooms').then((r) => setRooms(r.data || [])),
    ]).catch(() => {});
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/time-blocks', { ...form, doctor: form.doctor || null, room: form.room || null });
      toast.success('Bloqueo creado');
      setShowModal(false);
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (b) => {
    if (!confirm('¿Eliminar bloqueo?')) return;
    try {
      await api.delete(`/time-blocks/${b._id}`);
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
            <HiOutlineNoSymbol className="text-rose-600" /> Bloqueos de horario
          </h1>
          <p className="text-sm text-slate-500">Días feriados, vacaciones de doctores o consultorios cerrados.</p>
        </div>
        <button onClick={() => setShowModal(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700">
          <HiOutlinePlus className="w-4 h-4" /> Nuevo bloqueo
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Inicio</th>
              <th className="text-left px-3 py-2">Fin</th>
              <th className="text-left px-3 py-2">Día completo</th>
              <th className="text-left px-3 py-2">Doctor</th>
              <th className="text-left px-3 py-2">Consultorio</th>
              <th className="text-left px-3 py-2">Motivo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-4 text-slate-400">Cargando...</td></tr>}
            {list.map((b) => (
              <tr key={b._id} className="border-t border-slate-100">
                <td className="px-3 py-2">{fmtDate(b.startDate)} {!b.allDay && b.startTime}</td>
                <td className="px-3 py-2">{fmtDate(b.endDate)} {!b.allDay && b.endTime}</td>
                <td className="px-3 py-2">{b.allDay ? 'Sí' : 'No'}</td>
                <td className="px-3 py-2">{b.doctor?.name || 'Todos'}</td>
                <td className="px-3 py-2">{b.room?.name || 'Todos'}</td>
                <td className="px-3 py-2 text-slate-600">{b.reason}</td>
                <td className="px-3 py-2">
                  <button onClick={() => remove(b)} className="p-1 text-rose-600 hover:bg-rose-50 rounded"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {!loading && list.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-slate-400">Sin bloqueos</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nuevo bloqueo">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Inicio</span>
              <DateInput required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Fin</span>
              <DateInput required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} />
            Día completo
          </label>
          {!form.allDay && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Hora inicio</span>
                <input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Hora fin</span>
                <input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
              </label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Doctor (opcional)</span>
              <select value={form.doctor} onChange={(e) => setForm({ ...form, doctor: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="">Todos</option>
                {doctors.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Consultorio (opcional)</span>
              <select value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="">Todos</option>
                {rooms.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Motivo</span>
            <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
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
