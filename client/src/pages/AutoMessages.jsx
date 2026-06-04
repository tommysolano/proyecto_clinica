import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineBolt,
  HiOutlineFolder,
  HiOutlineFolderPlus,
  HiOutlineChatBubbleLeftRight,
  HiOutlineClock,
  HiOutlineMegaphone,
  HiOutlineArrowLeft,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlineBoltSlash,
  HiOutlineBars3,
} from 'react-icons/hi2';

const TRIGGER_TYPES = [
  { value: 'keyword', label: 'Cuando el cliente escribe (palabras clave)' },
  { value: 'welcome', label: 'Al iniciar una conversación nueva' },
  { value: 'incoming', label: 'Con cualquier mensaje entrante' },
];
const MATCH_TYPES = [
  { value: 'contains', label: 'Contiene' },
  { value: 'exact', label: 'Es exactamente' },
  { value: 'starts', label: 'Empieza con' },
];
const AUDIENCES = [
  { value: 'all', label: 'Todos los contactos' },
  { value: 'new', label: 'Solo contactos nuevos' },
  { value: 'existing', label: 'Solo pacientes registrados' },
];
const STAGES = [
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'contactado', label: 'Contactado' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'agendado', label: 'Agendado' },
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

const newTrigger = () => ({ type: 'keyword', keywords: [], matchType: 'contains', audience: 'all' });
const blankFlow = (folder) => ({
  name: '',
  folder: folder || 'General',
  active: false,
  triggers: [newTrigger()],
  days: [0, 1, 2, 3, 4, 5, 6],
  hourFrom: '00:00',
  hourTo: '23:59',
  steps: [{ type: 'message', body: '', waitMinutes: 0, opportunityStage: 'nuevo' }],
});

export default function AutoMessages() {
  const [folders, setFolders] = useState([]);
  const [flows, setFlows] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('__all__');
  const [loading, setLoading] = useState(true);

  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [f, fl] = await Promise.all([
        api.get('/chats/flow-folders'),
        api.get('/chats/flows'),
      ]);
      setFolders(f.data || []);
      setFlows(fl.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const folderNames = useMemo(() => {
    const set = new Set(folders.map((f) => f.name));
    flows.forEach((fl) => set.add(fl.folder || 'General'));
    return [...set].sort();
  }, [folders, flows]);

  const visibleFlows = useMemo(
    () => (selectedFolder === '__all__' ? flows : flows.filter((f) => (f.folder || 'General') === selectedFolder)),
    [flows, selectedFolder]
  );

  // ─── Carpetas ───
  const createFolder = async () => {
    const name = window.prompt('Nombre de la nueva carpeta:');
    if (!name || !name.trim()) return;
    try {
      await api.post('/chats/flow-folders', { name: name.trim() });
      toast.success('Carpeta creada');
      setSelectedFolder(name.trim());
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear carpeta');
    }
  };
  const deleteFolder = async (folder) => {
    if (!window.confirm(`¿Eliminar la carpeta "${folder.name}"?`)) return;
    try {
      await api.delete(`/chats/flow-folders/${folder._id}`);
      toast.success('Carpeta eliminada');
      if (selectedFolder === folder.name) setSelectedFolder('__all__');
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar carpeta');
    }
  };

  // ─── Flujos ───
  const newFlow = () => {
    const folder = selectedFolder === '__all__' ? (folderNames[0] || 'General') : selectedFolder;
    setEditor(blankFlow(folder));
  };
  const openFlow = async (id) => {
    try {
      const r = await api.get(`/chats/flows/${id}`);
      const fl = r.data;
      const triggers = (fl.triggers && fl.triggers.length)
        ? fl.triggers.map((t) => ({
            type: t.type || 'keyword',
            keywords: t.keywords || [],
            matchType: t.matchType || 'contains',
            audience: t.audience || 'all',
          }))
        : [{
            type: fl.trigger?.type || 'keyword',
            keywords: fl.trigger?.keywords || [],
            matchType: fl.trigger?.matchType || 'contains',
            audience: fl.trigger?.audience || 'all',
          }];
      setEditor({
        _id: fl._id,
        name: fl.name || '',
        folder: fl.folder || 'General',
        active: !!fl.active,
        triggers,
        days: Array.isArray(fl.days) ? fl.days : [0, 1, 2, 3, 4, 5, 6],
        hourFrom: fl.hourFrom || '00:00',
        hourTo: fl.hourTo || '23:59',
        steps: (fl.steps || []).length ? fl.steps : [{ type: 'message', body: '', waitMinutes: 0, opportunityStage: 'nuevo' }],
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al abrir flujo');
    }
  };
  const deleteFlow = async (fl) => {
    if (!window.confirm(`¿Eliminar el flujo "${fl.name}"?`)) return;
    try {
      await api.delete(`/chats/flows/${fl._id}`);
      toast.success('Flujo eliminado');
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };
  const saveFlow = async () => {
    if (!editor.name.trim()) return toast.error('Ponle un nombre al flujo');
    if (editor.triggers.length === 0) return toast.error('Agrega al menos un disparador');
    for (const t of editor.triggers) {
      if (t.type === 'keyword' && (t.keywords || []).filter(Boolean).length === 0) {
        return toast.error('Cada disparador por palabra clave necesita al menos una palabra');
      }
    }
    if (editor.steps.length === 0) return toast.error('Agrega al menos un paso');
    setSaving(true);
    try {
      const payload = {
        ...editor,
        triggers: editor.triggers.map((t) => ({ ...t, keywords: (t.keywords || []).filter(Boolean) })),
      };
      if (editor._id) {
        await api.put(`/chats/flows/${editor._id}`, payload);
        toast.success('Flujo guardado');
      } else {
        await api.post('/chats/flows', payload);
        toast.success('Flujo creado');
      }
      setEditor(null);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  // ─── Disparadores ───
  const addTrigger = () => setEditor((e) => ({ ...e, triggers: [...e.triggers, newTrigger()] }));
  const updateTrigger = (idx, patch) =>
    setEditor((e) => ({ ...e, triggers: e.triggers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) }));
  const removeTrigger = (idx) =>
    setEditor((e) => ({ ...e, triggers: e.triggers.filter((_, i) => i !== idx) }));

  // ─── Días ───
  const toggleDay = (d) =>
    setEditor((e) => ({
      ...e,
      days: e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d].sort(),
    }));

  // ─── Pasos ───
  const addStep = (type) =>
    setEditor((e) => ({
      ...e,
      steps: [...e.steps, { type, body: '', waitMinutes: type === 'wait' ? 60 : 0, opportunityStage: 'nuevo' }],
    }));
  const updateStep = (idx, patch) =>
    setEditor((e) => ({ ...e, steps: e.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));
  const removeStep = (idx) => setEditor((e) => ({ ...e, steps: e.steps.filter((_, i) => i !== idx) }));
  const moveStep = (idx, dir) =>
    setEditor((e) => {
      const steps = [...e.steps];
      const j = idx + dir;
      if (j < 0 || j >= steps.length) return e;
      [steps[idx], steps[j]] = [steps[j], steps[idx]];
      return { ...e, steps };
    });
  const reorderStep = (from, to) =>
    setEditor((e) => {
      if (from === to || from == null || to == null) return e;
      const steps = [...e.steps];
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return { ...e, steps };
    });

  // ============================ EDITOR ============================
  if (editor) {
    return (
      <div className="space-y-5 max-w-3xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setEditor(null)} className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 bg-transparent border-none cursor-pointer">
            <HiOutlineArrowLeft className="w-4 h-4" /> Volver
          </button>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={editor.active} onChange={(e) => setEditor({ ...editor, active: e.target.checked })} className="w-4 h-4 accent-emerald-600" />
              {editor.active ? 'Activo' : 'Borrador'}
            </label>
            <button onClick={saveFlow} disabled={saving} className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar flujo'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-sm">
            Nombre del flujo
            <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" placeholder="Ej: Bienvenida colesterol" />
          </label>
          <label className="block text-sm">
            Carpeta
            <input list="flow-folders" value={editor.folder} onChange={(e) => setEditor({ ...editor, folder: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            <datalist id="flow-folders">{folderNames.map((f) => <option key={f} value={f} />)}</datalist>
          </label>
        </div>

        {/* Horario de actividad */}
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-700 mb-2">Cuándo está activo</div>
          <div className="flex flex-wrap gap-1 mb-3">
            {DAYS.map((d) => {
              const on = editor.days.includes(d.v);
              return (
                <button key={d.v} type="button" onClick={() => toggleDay(d.v)} className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                  {d.l}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span>De</span>
            <input type="time" value={editor.hourFrom} onChange={(e) => setEditor({ ...editor, hourFrom: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            <span>a</span>
            <input type="time" value={editor.hourTo} onChange={(e) => setEditor({ ...editor, hourTo: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          </div>
        </div>

        {/* Diagrama */}
        <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4">
          {/* Disparadores (varios) */}
          <div className="flex flex-col gap-2">
            {editor.triggers.map((tr, idx) => (
              <div key={idx} className="bg-violet-50 border border-violet-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-violet-700 font-semibold text-sm">
                    <HiOutlineBolt className="w-4 h-4" /> Disparador {idx + 1}
                  </div>
                  {editor.triggers.length > 1 && (
                    <button onClick={() => removeTrigger(idx)} className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer" title="Quitar disparador">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select value={tr.type} onChange={(e) => updateTrigger(idx, { type: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                    {TRIGGER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <select value={tr.audience} onChange={(e) => updateTrigger(idx, { audience: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                    {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </div>
                {tr.type === 'keyword' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                    <input
                      value={(tr.keywords || []).join(', ')}
                      onChange={(e) => updateTrigger(idx, { keywords: e.target.value.split(',').map((k) => k.trim()) })}
                      placeholder="precio, costo, cuánto cuesta"
                      className="sm:col-span-2 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
                    />
                    <select value={tr.matchType} onChange={(e) => updateTrigger(idx, { matchType: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                      {MATCH_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                )}
              </div>
            ))}
            <button onClick={addTrigger} className="self-center flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-violet-200 text-violet-700 text-xs cursor-pointer hover:bg-violet-50">
              <HiOutlinePlus className="w-3.5 h-3.5" /> Añadir disparador
            </button>
          </div>

          {/* Pasos (drag and drop) */}
          {editor.steps.map((step, idx) => (
            <div key={idx}>
              <div className="flex justify-center"><div className="w-px h-5 bg-slate-300" /></div>
              <div
                draggable
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { reorderStep(dragIndex, idx); setDragIndex(null); }}
                className={dragIndex === idx ? 'opacity-50' : ''}
              >
                <StepCard
                  step={step}
                  idx={idx}
                  total={editor.steps.length}
                  onChange={(patch) => updateStep(idx, patch)}
                  onRemove={() => removeStep(idx)}
                  onMove={(dir) => moveStep(idx, dir)}
                />
              </div>
            </div>
          ))}

          <div className="flex justify-center"><div className="w-px h-5 bg-slate-300" /></div>
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={() => addStep('message')} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white border border-emerald-200 text-emerald-700 text-sm cursor-pointer hover:bg-emerald-50">
              <HiOutlineChatBubbleLeftRight className="w-4 h-4" /> Mensaje
            </button>
            <button onClick={() => addStep('wait')} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white border border-amber-200 text-amber-700 text-sm cursor-pointer hover:bg-amber-50">
              <HiOutlineClock className="w-4 h-4" /> Espera
            </button>
            <button onClick={() => addStep('opportunity')} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-white border border-sky-200 text-sky-700 text-sm cursor-pointer hover:bg-sky-50">
              <HiOutlineMegaphone className="w-4 h-4" /> Crear oportunidad
            </button>
          </div>
          <p className="text-center text-[11px] text-slate-400 mt-2">Arrastra los pasos para reordenarlos.</p>
        </div>
      </div>
    );
  }

  // ============================ LISTA ============================
  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
              <HiOutlineBolt className="w-5 h-5" />
            </span>
            Flujos de mensajes automáticos
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Organiza flujos en carpetas. Cada flujo puede tener varios disparadores, horario, y una
            secuencia de pasos (mensaje, espera, crear oportunidad).
          </p>
        </div>
        <button onClick={newFlow} className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 flex items-center gap-2">
          <HiOutlinePlus className="w-4 h-4" /> Nuevo flujo
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
        <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 h-max">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Carpetas</span>
            <button onClick={createFolder} title="Nueva carpeta" className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer">
              <HiOutlineFolderPlus className="w-5 h-5" />
            </button>
          </div>
          <button onClick={() => setSelectedFolder('__all__')} className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between ${selectedFolder === '__all__' ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'}`}>
            <span>Todos los flujos</span>
            <span className="text-xs opacity-70">{flows.length}</span>
          </button>
          {folderNames.map((name) => {
            const folderDoc = folders.find((f) => f.name === name);
            const count = flows.filter((fl) => (fl.folder || 'General') === name).length;
            return (
              <div key={name} className="group flex items-center">
                <button onClick={() => setSelectedFolder(name)} className={`flex-1 text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between gap-2 ${selectedFolder === name ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'}`}>
                  <span className="flex items-center gap-2 truncate"><HiOutlineFolder className="w-4 h-4 shrink-0" /> {name}</span>
                  <span className="text-xs opacity-70">{count}</span>
                </button>
                {folderDoc && (
                  <button onClick={() => deleteFolder(folderDoc)} title="Eliminar carpeta" className="p-1 text-slate-300 hover:text-red-500 bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
          {folderNames.length === 0 && <p className="text-xs text-slate-400 px-2 py-3">Crea una carpeta para organizar tus flujos.</p>}
        </aside>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {loading ? (
            <div className="text-center py-10 text-slate-400">Cargando...</div>
          ) : visibleFlows.length === 0 ? (
            <div className="text-center py-12 text-slate-400">Sin flujos {selectedFolder !== '__all__' ? 'en esta carpeta' : ''}. Crea el primero con “Nuevo flujo”.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-emerald-50/60 border-b border-emerald-100">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Flujo</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Carpeta</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Disp.</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Pasos</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Estado</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {visibleFlows.map((fl) => {
                  const trigs = (fl.triggers && fl.triggers.length) ? fl.triggers : (fl.trigger ? [fl.trigger] : []);
                  return (
                    <tr key={fl._id} className="border-t border-slate-100 hover:bg-emerald-50/30">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-800">{fl.name}</div>
                        <div className="text-xs text-slate-500">
                          {trigs.map((t) => t.type === 'keyword' ? (t.keywords || []).join('/') : t.type).filter(Boolean).join(' · ') || '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{fl.folder || 'General'}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{trigs.length}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{(fl.steps || []).length}</td>
                      <td className="px-4 py-3 text-center">
                        {fl.active ? (
                          <span className="text-[11px] px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">Activo</span>
                        ) : (
                          <span className="text-[11px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full inline-flex items-center gap-1"><HiOutlineBoltSlash className="w-3 h-3" /> Borrador</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button onClick={() => openFlow(fl._id)} className="p-1.5 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer" title="Editar">
                          <HiOutlinePencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => deleteFlow(fl)} className="p-1.5 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer" title="Eliminar">
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function StepCard({ step, idx, total, onChange, onRemove, onMove }) {
  const meta = {
    message: { border: 'border-emerald-200', text: 'text-emerald-700', icon: HiOutlineChatBubbleLeftRight, label: 'Enviar mensaje' },
    wait: { border: 'border-amber-200', text: 'text-amber-700', icon: HiOutlineClock, label: 'Esperar' },
    opportunity: { border: 'border-sky-200', text: 'text-sky-700', icon: HiOutlineMegaphone, label: 'Crear oportunidad' },
  }[step.type] || { border: 'border-slate-200', text: 'text-slate-700', icon: HiOutlineChatBubbleLeftRight, label: step.type };
  const Icon = meta.icon;
  return (
    <div className={`bg-white border rounded-xl p-3 ${meta.border}`}>
      <div className="flex items-center justify-between mb-2">
        <div className={`flex items-center gap-2 ${meta.text} font-semibold text-sm`}>
          <HiOutlineBars3 className="w-4 h-4 text-slate-300 cursor-grab" title="Arrastra para reordenar" />
          <Icon className="w-4 h-4" /> {idx + 1}. {meta.label}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onMove(-1)} disabled={idx === 0} className="p-1 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer disabled:opacity-30" title="Subir">
            <HiOutlineArrowUp className="w-4 h-4" />
          </button>
          <button onClick={() => onMove(1)} disabled={idx === total - 1} className="p-1 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer disabled:opacity-30" title="Bajar">
            <HiOutlineArrowDown className="w-4 h-4" />
          </button>
          <button onClick={onRemove} className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer" title="Eliminar paso">
            <HiOutlineTrash className="w-4 h-4" />
          </button>
        </div>
      </div>

      {step.type === 'message' && (
        <textarea value={step.body} onChange={(e) => onChange({ body: e.target.value })} rows={3} placeholder="Mensaje que se enviará al cliente. Usa {{nombre}} para personalizar." className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-none" />
      )}
      {step.type === 'wait' && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Esperar
          <input type="number" min="0" value={step.waitMinutes} onChange={(e) => onChange({ waitMinutes: Number(e.target.value) })} className="w-24 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          minutos antes del siguiente paso
        </label>
      )}
      {step.type === 'opportunity' && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Crear oportunidad en etapa
          <select value={step.opportunityStage} onChange={(e) => onChange({ opportunityStage: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
            {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
