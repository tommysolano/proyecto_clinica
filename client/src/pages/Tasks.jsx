import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineCheckCircle, HiOutlineTrash, HiOutlineClipboardDocumentList } from 'react-icons/hi2';
import Modal from '../components/Modal';
import DateTimeInput from '../components/DateTimeInput';

const blank = () => ({ title: '', notes: '', dueAt: '', assignedTo: '' });

export default function Tasks() {
  const [list, setList] = useState([]);
  const [agents, setAgents] = useState([]);
  const [creating, setCreating] = useState(null);
  const [filter, setFilter] = useState('open');
  // Mientras carga no se puede afirmar que no haya tareas (ver Workflows.jsx).
  // También cubre el cambio de filtro, que vuelve a consultar al servidor.
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [tasks, ag] = await Promise.all([
        api.get(`/agent-tasks?status=${filter}`),
        api.get('/call-center/agents').catch(() => ({ data: [] })),
      ]);
      setList(tasks.data);
      setAgents(ag.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar tareas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const save = async () => {
    if (!creating.title.trim()) return toast.error('Escribe un título');
    try {
      await api.post('/agent-tasks', {
        title: creating.title,
        notes: creating.notes,
        dueAt: creating.dueAt || null,
        assignedTo: creating.assignedTo || undefined,
      });
      toast.success('Tarea creada');
      setCreating(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al crear');
    }
  };

  const complete = async (t) => {
    try {
      await api.put(`/agent-tasks/${t._id}`, { status: t.status === 'done' ? 'open' : 'done' });
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar tarea?')) return;
    try {
      await api.delete(`/agent-tasks/${id}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  const overdue = (t) => t.status === 'open' && t.dueAt && new Date(t.dueAt) < new Date();

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HiOutlineClipboardDocumentList className="text-emerald-600" /> Tareas
        </h1>
        <button onClick={() => setCreating(blank())} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none">
          <HiOutlinePlus /> Nueva tarea
        </button>
      </div>

      <div className="flex gap-2 mb-4 text-sm">
        {['open', 'done'].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-lg border cursor-pointer ${filter === s ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
            {s === 'open' ? 'Pendientes' : 'Completadas'}
          </button>
        ))}
      </div>

      <div className="grid gap-2">
        {loading && <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">Cargando tareas…</div>}
        {!loading && list.length === 0 && <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">Sin tareas.</div>}
        {list.map((t) => (
          <div key={t._id} className={`border rounded-xl p-3 bg-white flex items-center gap-3 ${overdue(t) ? 'border-red-200' : 'border-slate-200'}`}>
            <button onClick={() => complete(t)} className="bg-transparent border-none cursor-pointer p-0">
              <HiOutlineCheckCircle className={`text-2xl ${t.status === 'done' ? 'text-emerald-500' : 'text-slate-300'}`} />
            </button>
            <div className="flex-1 min-w-0">
              <div className={`font-medium ${t.status === 'done' ? 'line-through text-slate-400' : ''}`}>{t.title}</div>
              <div className="text-xs text-slate-400 flex gap-2 flex-wrap">
                {t.assignedTo?.name && <span>👤 {t.assignedTo.name}</span>}
                {t.patient && <span>🧑‍⚕️ {t.patient.firstName} {t.patient.lastName}</span>}
                {t.dueAt && <span className={overdue(t) ? 'text-red-500 font-medium' : ''}>📅 {new Date(t.dueAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</span>}
              </div>
              {t.notes && <div className="text-xs text-slate-500 mt-1">{t.notes}</div>}
            </div>
            <button onClick={() => remove(t._id)} className="p-2 text-slate-400 hover:text-red-500 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
          </div>
        ))}
      </div>

      <Modal isOpen={!!creating} onClose={() => setCreating(null)} title="Nueva tarea" size="sm">
        {creating && (
          <>
            <div className="grid gap-3">
              <label className="text-sm">
                <span className="text-slate-600">Título de la tarea</span>
                <input value={creating.title} onChange={(e) => setCreating({ ...creating, title: e.target.value })} placeholder="¿Qué hay que hacer?" className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="text-slate-600">Notas (opcional)</span>
                <textarea value={creating.notes} onChange={(e) => setCreating({ ...creating, notes: e.target.value })} rows={2} placeholder="Detalles adicionales" className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="text-slate-600">Vence</span>
                <DateTimeInput value={creating.dueAt} onChange={(e) => setCreating({ ...creating, dueAt: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </label>
              {agents.length > 0 && (
                <label className="text-sm">
                  <span className="text-slate-600">Asignar a</span>
                  <select value={creating.assignedTo} onChange={(e) => setCreating({ ...creating, assignedTo: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                    <option value="">Yo</option>
                    {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setCreating(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Crear</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
