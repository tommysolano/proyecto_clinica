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
  HiOutlineFolder,
  HiOutlineFolderPlus,
  HiOutlineChatBubbleLeftRight,
} from 'react-icons/hi2';

const TRIGGERS = [
  { value: 'keyword', label: 'Según lo que escribe el cliente (palabras clave)' },
  { value: 'welcome', label: 'Bienvenida (nuevo chat)' },
  { value: 'incoming', label: 'Cuando llega cualquier mensaje' },
  { value: 'out_of_hours', label: 'Fuera de horario' },
  { value: 'scheduled', label: 'Programado a una hora del día' },
];

const MATCH_TYPES = [
  { value: 'contains', label: 'Contiene la palabra' },
  { value: 'exact', label: 'Es exactamente igual' },
  { value: 'starts', label: 'Empieza con' },
];

const STAGES = [
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'contactado', label: 'Contactado' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'agendado', label: 'Agendado' },
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
  folder: 'General',
  trigger: 'keyword',
  keywords: [],
  matchType: 'contains',
  audience: 'all',
  createOpportunity: false,
  opportunityStage: 'nuevo',
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
  const [keywordsText, setKeywordsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState('__all__');

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

  // Carpetas (derivadas de los flujos existentes).
  const folders = useMemo(() => {
    const set = new Set(list.map((m) => (m.folder || 'General').trim() || 'General'));
    return [...set].sort();
  }, [list]);

  const filtered = useMemo(
    () =>
      selectedFolder === '__all__'
        ? list
        : list.filter((m) => (m.folder || 'General') === selectedFolder),
    [list, selectedFolder]
  );

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY, folder: selectedFolder === '__all__' ? 'General' : selectedFolder });
    setKeywordsText('');
    setModalOpen(true);
  };

  const openEdit = (m) => {
    setEditing(m._id);
    setForm({
      name: m.name || '',
      body: m.body || '',
      folder: m.folder || 'General',
      trigger: m.trigger || 'keyword',
      keywords: Array.isArray(m.keywords) ? m.keywords : [],
      matchType: m.matchType || 'contains',
      audience: m.audience || 'all',
      createOpportunity: !!m.createOpportunity,
      opportunityStage: m.opportunityStage || 'nuevo',
      active: !!m.active,
      days: Array.isArray(m.days) ? m.days : [0, 1, 2, 3, 4, 5, 6],
      hourFrom: m.hourFrom || '08:00',
      hourTo: m.hourTo || '18:00',
      scheduledAt: m.scheduledAt || '',
    });
    setKeywordsText((m.keywords || []).join(', '));
    setModalOpen(true);
  };

  const createFolder = () => {
    const name = window.prompt('Nombre de la nueva carpeta:');
    if (!name || !name.trim()) return;
    setSelectedFolder(name.trim());
    setEditing(null);
    setForm({ ...EMPTY, folder: name.trim() });
    setKeywordsText('');
    setModalOpen(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.body.trim()) {
      toast.error('Nombre y mensaje son obligatorios');
      return;
    }
    const keywords = keywordsText
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (form.trigger === 'keyword' && keywords.length === 0) {
      toast.error('Agrega al menos una palabra clave');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, keywords, folder: form.folder.trim() || 'General' };
      if (editing) {
        await api.put(`/chats/auto-messages/${editing}`, payload);
        toast.success('Flujo actualizado');
      } else {
        await api.post('/chats/auto-messages', payload);
        toast.success('Flujo creado');
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
    if (!window.confirm('¿Eliminar este flujo?')) return;
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <HiOutlineBolt className="w-5 h-5" />
            </span>
            Flujos de mensajes automáticos
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Responde automáticamente según lo que escribe el cliente, crea oportunidades y organiza
            tus flujos en carpetas.
          </p>
        </div>
        <button
          onClick={openNew}
          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 flex items-center gap-2"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nuevo flujo
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[230px_1fr] gap-4">
        {/* Carpetas */}
        <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 h-max">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Carpetas</span>
            <button
              onClick={createFolder}
              title="Nueva carpeta"
              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer"
            >
              <HiOutlineFolderPlus className="w-5 h-5" />
            </button>
          </div>
          <button
            onClick={() => setSelectedFolder('__all__')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between ${
              selectedFolder === '__all__' ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'
            }`}
          >
            <span>Todos los flujos</span>
            <span className="text-xs opacity-70">{list.length}</span>
          </button>
          {folders.map((f) => {
            const count = list.filter((m) => (m.folder || 'General') === f).length;
            return (
              <button
                key={f}
                onClick={() => setSelectedFolder(f)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between gap-2 ${
                  selectedFolder === f ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  <HiOutlineFolder className="w-4 h-4 shrink-0" /> {f}
                </span>
                <span className="text-xs opacity-70">{count}</span>
              </button>
            );
          })}
        </aside>

        {/* Tabla de flujos */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-emerald-50/60 border-b border-emerald-100">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Flujo</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Disparador</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acción</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Activo</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="text-center py-6 text-slate-400">Cargando...</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} className="text-center py-10 text-slate-400">Sin flujos en esta carpeta. Crea el primero arriba.</td></tr>
              )}
              {filtered.map((m) => (
                <tr key={m._id} className="border-t border-slate-100 hover:bg-emerald-50/30">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-800">{m.name}</div>
                    <div className="text-xs text-slate-500 truncate max-w-xs">{m.body}</div>
                    {m.trigger === 'keyword' && (m.keywords || []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {m.keywords.slice(0, 6).map((k, i) => (
                          <span key={i} className="text-[10px] bg-sky-50 text-sky-700 px-1.5 py-0.5 rounded-full">{k}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {triggerLabel(m.trigger)}
                    {m.trigger === 'scheduled' && m.scheduledAt && (
                      <div className="text-emerald-700 font-semibold mt-0.5">a las {m.scheduledAt}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div className="flex items-center gap-1 text-slate-500">
                      <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Responde mensaje
                    </div>
                    {m.createOpportunity && (
                      <div className="text-emerald-700 font-medium mt-0.5">+ Crea oportunidad ({m.opportunityStage})</div>
                    )}
                    <div className="text-[10px] text-slate-400 mt-0.5">{audienceLabel(m.audience)}</div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {m.active ? (
                      <HiOutlineCheckCircle className="w-5 h-5 text-emerald-600 inline" />
                    ) : (
                      <HiOutlineXCircle className="w-5 h-5 text-slate-300 inline" />
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(m)} className="p-1.5 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer" title="Editar">
                      <HiOutlinePencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(m._id)} className="p-1.5 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer" title="Eliminar">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar flujo' : 'Nuevo flujo'}
        size="lg"
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">
              Nombre del flujo
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                required
              />
            </label>
            <label className="block text-sm">
              Carpeta
              <input
                list="am-folders"
                value={form.folder}
                onChange={(e) => setForm({ ...form, folder: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="General"
              />
              <datalist id="am-folders">
                {folders.map((f) => <option key={f} value={f} />)}
              </datalist>
            </label>
          </div>

          <label className="block text-sm">
            Disparador
            <select
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>

          {form.trigger === 'keyword' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-sky-50/50 border border-sky-100 rounded-lg p-3">
              <label className="block text-sm sm:col-span-2">
                Palabras clave (separadas por coma)
                <input
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  placeholder="precio, costo, cuánto cuesta"
                  className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                Tipo de coincidencia
                <select
                  value={form.matchType}
                  onChange={(e) => setForm({ ...form, matchType: e.target.value })}
                  className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                >
                  {MATCH_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
            </div>
          )}

          <label className="block text-sm">
            Mensaje que se enviará al cliente
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
              Aplicar a
              <select
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              >
                {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            {form.trigger === 'scheduled' && (
              <label className="block text-sm">
                Hora del envío (HH:MM)
                <input
                  type="time"
                  value={form.scheduledAt}
                  onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                  className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            )}
          </div>

          {/* Acción: crear oportunidad */}
          <div className="bg-emerald-50/50 border border-emerald-100 rounded-lg p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={form.createOpportunity}
                onChange={(e) => setForm({ ...form, createOpportunity: e.target.checked })}
                className="w-4 h-4 accent-emerald-600"
              />
              Crear una oportunidad automáticamente cuando se dispare este flujo
            </label>
            {form.createOpportunity && (
              <label className="block text-sm">
                Etapa inicial de la oportunidad
                <select
                  value={form.opportunityStage}
                  onChange={(e) => setForm({ ...form, opportunityStage: e.target.value })}
                  className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                >
                  {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
            )}
          </div>

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
                      on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'
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
              <input type="time" value={form.hourFrom} onChange={(e) => setForm({ ...form, hourFrom: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm">
              Hasta
              <input type="time" value={form.hourTo} onChange={(e) => setForm({ ...form, hourTo: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="w-4 h-4 accent-emerald-600"
            />
            Activo (se ejecutará cuando se cumplan las condiciones)
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="px-5 py-2.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 bg-white cursor-pointer">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-medium border-none cursor-pointer disabled:opacity-50">
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
