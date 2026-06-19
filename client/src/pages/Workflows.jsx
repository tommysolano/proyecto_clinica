import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlineBolt,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlinePencil,
  HiOutlineFolder,
  HiOutlineFolderPlus,
  HiOutlineBars3,
} from 'react-icons/hi2';
import Modal from '../components/Modal';
import WorkflowGraphEditor, { stepsToGraph } from '../components/WorkflowGraphEditor';

const TRIGGERS = [
  { value: 'appointment_created', label: 'Cita agendada' },
  { value: 'appointment_attended', label: 'Cita asistida' },
  { value: 'appointment_no_show', label: 'No asistió (no-show)' },
  { value: 'appointment_cancelled', label: 'Cita cancelada' },
  { value: 'treatment_abandoned', label: 'Tratamiento abandonado' },
  { value: 'patient_birthday', label: 'Cumpleaños del paciente' },
  { value: 'sale_created', label: 'Venta registrada' },
  { value: 'quotation_sent', label: 'Cotización enviada' },
  { value: 'inbound_message', label: 'Mensaje entrante (chat)' },
  { value: 'keyword', label: 'Palabra clave (chat)' },
  { value: 'new_conversation', label: 'Nueva conversación (chat)' },
  { value: 'tag_added', label: 'Etiqueta añadida' },
];
const AUDIENCES = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Solo primera visita' },
  { value: 'existing', label: 'Solo recurrentes' },
];
const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];
const STEP_DEFS = {
  send_message: 'Enviar mensaje',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Esperar (tiempo)',
  wait_until: 'Esperar hasta la cita',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición (si/no)',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  move_stage: 'Mover etapa',
  set_appointment_status: 'Cambiar estado de cita',
  assign_agent: 'Asignar agente',
  create_task: 'Crear tarea',
  webhook: 'Webhook (integración)',
  ai_reply: 'Responder con IA',
  request_review: 'Pedir reseña (reputación)',
  goal: 'Objetivo (terminar si)',
};
const FIELDS = [
  { value: 'tag', label: 'Etiqueta del paciente' },
  { value: 'stage', label: 'Etapa de oportunidad' },
  { value: 'source', label: 'Fuente del paciente' },
  { value: 'lastReply', label: 'Última respuesta del paciente' },
  { value: 'hasPatient', label: 'Tiene paciente vinculado' },
];
const REPLY_VALUES = [
  { value: 'yes', label: 'Sí (confirmó)' },
  { value: 'no', label: 'No (canceló)' },
  { value: 'other', label: 'Otra' },
];
const OPS = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'es distinto de' },
  { value: 'contains', label: 'contiene' },
  { value: 'exists', label: 'existe' },
];

const newStep = (type) => ({ type, body: '', templateName: '', templateLanguage: 'es', emailSubject: '', waitMinutes: 60, waitEvent: 'appointment_date', offsetMinutes: -1440, timeoutMinutes: 720, appointmentStatus: 'confirmada', field: 'tag', op: 'eq', value: '', onFailGoTo: null, tag: '', stage: 'contactado', assignMode: 'roundrobin', assignUser: null, taskTitle: '', taskDueOffsetMinutes: 1440, webhookUrl: '', webhookMethod: 'POST' });
const blank = () => ({ name: '', folder: 'General', active: false, trigger: { type: 'appointment_created', audience: 'all', serviceFilter: null, keywords: [], matchType: 'contains', tagFilter: '' }, steps: [], nodes: [], edges: [] });

export default function Workflows() {
  const [list, setList] = useState([]);
  const [folders, setFolders] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('__all__');
  const [templates, setTemplates] = useState([]);
  const [presets, setPresets] = useState([]);
  const [agents, setAgents] = useState([]);
  const [editing, setEditing] = useState(null);
  const [enrollView, setEnrollView] = useState(null); // workflow cuyas inscripciones se ven
  const [dragStep, setDragStep] = useState(null); // índice del paso que se arrastra

  const load = async () => {
    try {
      const [wfs, fld, tpls, ps, ags] = await Promise.all([
        api.get('/workflows'),
        api.get('/workflows/folders').catch(() => ({ data: [] })),
        api.get('/message-templates?channel=whatsapp').catch(() => ({ data: [] })),
        api.get('/workflows/presets').catch(() => ({ data: [] })),
        api.get('/call-center/agents').catch(() => ({ data: [] })),
      ]);
      setList(wfs.data);
      setFolders(fld.data || []);
      setTemplates(tpls.data.filter((t) => t.status === 'approved'));
      setPresets(ps.data);
      setAgents(ags.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar workflows');
    }
  };
  useEffect(() => { load(); }, []);

  // Nombres de carpeta = carpetas creadas + las usadas por algún workflow.
  const folderNames = useMemo(() => {
    const set = new Set(folders.map((f) => f.name));
    list.forEach((wf) => set.add(wf.folder || 'General'));
    return [...set].sort();
  }, [folders, list]);

  const visibleList = useMemo(
    () => (selectedFolder === '__all__' ? list : list.filter((wf) => (wf.folder || 'General') === selectedFolder)),
    [list, selectedFolder]
  );

  const createFolder = async () => {
    const name = window.prompt('Nombre de la nueva carpeta:');
    if (!name || !name.trim()) return;
    try {
      await api.post('/workflows/folders', { name: name.trim() });
      toast.success('Carpeta creada');
      setSelectedFolder(name.trim());
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al crear carpeta');
    }
  };
  const deleteFolder = async (folder) => {
    if (!window.confirm(`¿Eliminar la carpeta "${folder.name}"?`)) return;
    try {
      await api.delete(`/workflows/folders/${folder._id}`);
      toast.success('Carpeta eliminada');
      if (selectedFolder === folder.name) setSelectedFolder('__all__');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al eliminar carpeta');
    }
  };

  const openNew = () => {
    const folder = selectedFolder === '__all__' ? (folderNames[0] || 'General') : selectedFolder;
    setEditing({ ...blank(), folder });
  };

  // Abre un workflow para editar; convierte los legacy (steps) a grafo (nodes/edges).
  const openEdit = (wf) => {
    const triggerLabel = TRIGGERS.find((t) => t.value === wf.trigger?.type)?.label || 'Disparador';
    const hasGraph = Array.isArray(wf.nodes) && wf.nodes.length > 0;
    const graph = hasGraph
      ? { nodes: wf.nodes.map((n) => ({ ...n, data: { ...n.data } })), edges: (wf.edges || []).map((e) => ({ ...e })) }
      : stepsToGraph(wf.steps || [], triggerLabel);
    setEditing({ ...wf, trigger: { ...wf.trigger }, steps: [], nodes: graph.nodes, edges: graph.edges });
  };

  const installPreset = async (key) => {
    try {
      await api.post(`/workflows/presets/${key}`);
      toast.success('Automatización instalada (pausada). Revísala y actívala.');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al instalar');
    }
  };

  const save = async () => {
    if (!editing.name.trim()) return toast.error('Ponle un nombre al workflow');
    const actionNodes = (editing.nodes || []).filter((n) => n.type !== 'trigger');
    if (actionNodes.length === 0) return toast.error('Agrega al menos un paso al diagrama');
    // Sanea ObjectId vacíos ('' → null) que romperían el cast en Mongoose.
    const payload = {
      ...editing,
      trigger: { ...editing.trigger, serviceFilter: editing.trigger?.serviceFilter || null },
      steps: [], // los workflows nuevos viven como grafo (nodes/edges)
      nodes: editing.nodes || [],
      edges: editing.edges || [],
    };
    try {
      if (editing._id) await api.put(`/workflows/${editing._id}`, payload);
      else await api.post('/workflows', payload);
      toast.success('Workflow guardado');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    }
  };

  const toggleActive = async (wf) => {
    try {
      await api.put(`/workflows/${wf._id}`, { active: !wf.active });
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar este workflow? Se cancelan sus inscripciones activas.')) return;
    try {
      await api.delete(`/workflows/${id}`);
      toast.success('Eliminado');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  // ---- edición de pasos ----
  const setStep = (idx, patch) => {
    const steps = editing.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    setEditing({ ...editing, steps });
  };
  const moveStep = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= editing.steps.length) return;
    const steps = [...editing.steps];
    [steps[idx], steps[j]] = [steps[j], steps[idx]];
    setEditing({ ...editing, steps });
  };
  const removeStep = (idx) => setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== idx) });
  const addStep = (type) => setEditing({ ...editing, steps: [...editing.steps, newStep(type)] });
  const reorderStep = (from, to) => {
    if (from == null || to == null || from === to) return;
    const steps = [...editing.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    setEditing({ ...editing, steps });
  };

  const isApptTrigger = editing?.trigger?.type?.startsWith('appointment');
  const isChatTrigger = ['inbound_message', 'keyword', 'new_conversation'].includes(editing?.trigger?.type);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><HiOutlineBolt className="text-emerald-600" /> Automatizaciones (Workflows)</h1>
          <p className="text-sm text-slate-500 mt-1">Organízalas en carpetas. Cada automatización se dispara por eventos (citas, tratamientos, ventas, cumpleaños) o por chat (palabra clave, mensaje entrante).</p>
        </div>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"><HiOutlinePlus /> Nuevo workflow</button>
      </div>

      {presets.length > 0 && (
        <div className="mb-5 border border-emerald-100 bg-emerald-50/50 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-600 mb-2">Instalar automatización de clínica (se crea pausada para revisar):</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button key={p.key} onClick={() => installPreset(p.key)} className="px-3 py-1.5 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-xs cursor-pointer hover:border-emerald-400">
                + {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
        {/* Sidebar de carpetas */}
        <aside className="bg-white rounded-2xl border border-slate-200 shadow-sm p-3 h-max">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Carpetas</span>
            <button onClick={createFolder} title="Nueva carpeta" className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg bg-transparent border-none cursor-pointer">
              <HiOutlineFolderPlus className="w-5 h-5" />
            </button>
          </div>
          <button onClick={() => setSelectedFolder('__all__')} className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 cursor-pointer border-none flex items-center justify-between ${selectedFolder === '__all__' ? 'bg-emerald-600 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-50'}`}>
            <span>Todas</span>
            <span className="text-xs opacity-70">{list.length}</span>
          </button>
          {folderNames.map((name) => {
            const folderDoc = folders.find((f) => f.name === name);
            const count = list.filter((wf) => (wf.folder || 'General') === name).length;
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
          {folderNames.length === 0 && <p className="text-xs text-slate-400 px-2 py-3">Crea una carpeta para organizar tus automatizaciones.</p>}
        </aside>

        {/* Lista de automatizaciones (filtrada por carpeta) */}
        <div className="grid gap-3 content-start">
          {visibleList.length === 0 && (
            <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
              {selectedFolder === '__all__' ? 'Aún no hay automatizaciones.' : 'Sin automatizaciones en esta carpeta.'}
            </div>
          )}
          {visibleList.map((wf) => (
            <div key={wf._id} className="border border-slate-200 rounded-xl p-4 bg-white flex justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{wf.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${wf.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{wf.active ? 'Activo' : 'Pausado'}</span>
                  <span className="text-xs text-slate-400 inline-flex items-center gap-1"><HiOutlineFolder className="w-3.5 h-3.5" /> {wf.folder || 'General'}</span>
                  <span className="text-xs text-slate-400">{TRIGGERS.find((t) => t.value === wf.trigger?.type)?.label} · {wf.steps?.length || 0} paso(s)</span>
                </div>
                <div className="text-xs text-slate-400 mt-1">Inscritos: {wf.stats?.enrolled || 0} · Completados: {wf.stats?.completed || 0}</div>
              </div>
              <div className="flex items-start gap-1 shrink-0">
                <button onClick={() => toggleActive(wf)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer">{wf.active ? 'Pausar' : 'Activar'}</button>
                <button onClick={() => setEnrollView(wf)} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer">Inscritos</button>
                <button onClick={() => openEdit(wf)} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer"><HiOutlinePencil /></button>
                <button onClick={() => remove(wf._id)} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={editing?._id ? 'Editar workflow' : 'Nuevo workflow'} size="2xl">
        {editing && (
          <>
            <div className="grid gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-sm">
                  <span className="text-slate-600 block mb-1">Nombre de la automatización</span>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="ej. Recordatorio de cita 24h" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="text-slate-600 block mb-1">Carpeta</span>
                  <input list="wf-folders" value={editing.folder || 'General'} onChange={(e) => setEditing({ ...editing, folder: e.target.value })} placeholder="General" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                  <datalist id="wf-folders">{folderNames.map((f) => <option key={f} value={f} />)}</datalist>
                </label>
              </div>

              <div className="border border-slate-100 rounded-lg p-3 bg-slate-50">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Disparador</p>
                <label className="text-xs text-slate-500 block mb-1">Evento que inicia la automatización</label>
                <select value={editing.trigger.type} onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, type: e.target.value } })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
                  {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {(isApptTrigger || isChatTrigger) && (
                  <div className="mt-2">
                    <label className="text-xs text-slate-500 block mb-1">Audiencia</label>
                    <select value={editing.trigger.audience} onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, audience: e.target.value } })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  </div>
                )}
                {editing.trigger.type === 'keyword' && (
                  <div className="mt-2 grid gap-2">
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Palabras clave (separadas por coma)</label>
                      <input
                        value={(editing.trigger.keywords || []).join(', ')}
                        onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) } })}
                        placeholder="precio, info, agendar"
                        className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Tipo de coincidencia</label>
                      <select value={editing.trigger.matchType || 'contains'} onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, matchType: e.target.value } })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
                        <option value="contains">El mensaje contiene la palabra</option>
                        <option value="exact">El mensaje es exactamente la palabra</option>
                        <option value="starts">El mensaje empieza con la palabra</option>
                      </select>
                    </div>
                  </div>
                )}
                {editing.trigger.type === 'tag_added' && (
                  <div className="mt-2">
                    <label className="text-xs text-slate-500 block mb-1">Etiqueta (vacío = cualquier etiqueta)</label>
                    <input
                      value={editing.trigger.tagFilter || ''}
                      onChange={(e) => setEditing({ ...editing, trigger: { ...editing.trigger, tagFilter: e.target.value } })}
                      placeholder="vip"
                      className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
                    />
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Diagrama de la automatización</p>
                <WorkflowGraphEditor
                  nodes={editing.nodes || []}
                  edges={editing.edges || []}
                  onChange={({ nodes, edges }) => setEditing({ ...editing, nodes, edges })}
                  triggerLabel={TRIGGERS.find((t) => t.value === editing.trigger?.type)?.label || 'Disparador'}
                  templates={templates}
                  agents={agents}
                />
              </div>

              {false && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Pasos</p>
                  {editing.steps.length > 1 && <span className="text-[11px] text-slate-400">Arrastra los pasos para reordenarlos</span>}
                </div>
                <div className="grid gap-2">
                  {editing.steps.map((s, idx) => (
                    <div
                      key={idx}
                      draggable
                      onDragStart={() => setDragStep(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { reorderStep(dragStep, idx); setDragStep(null); }}
                      onDragEnd={() => setDragStep(null)}
                      className={`border border-slate-200 rounded-lg p-3 bg-white ${dragStep === idx ? 'opacity-50 ring-2 ring-emerald-300' : ''}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium flex items-center gap-2">
                          <HiOutlineBars3 className="w-4 h-4 text-slate-300 cursor-grab" title="Arrastra para reordenar" />
                          {idx + 1}. {STEP_DEFS[s.type]}
                        </span>
                        <div className="flex gap-1">
                          <button onClick={() => moveStep(idx, -1)} className="p-1 text-slate-400 bg-transparent border-none cursor-pointer"><HiOutlineArrowUp /></button>
                          <button onClick={() => moveStep(idx, 1)} className="p-1 text-slate-400 bg-transparent border-none cursor-pointer"><HiOutlineArrowDown /></button>
                          <button onClick={() => removeStep(idx)} className="p-1 text-red-400 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
                        </div>
                      </div>
                      {s.type === 'send_message' && (
                        <textarea value={s.body} onChange={(e) => setStep(idx, { body: e.target.value })} rows={2} placeholder="Mensaje (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                      )}
                      {s.type === 'send_template' && (
                        <select value={s.templateName} onChange={(e) => setStep(idx, { templateName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          <option value="">Selecciona plantilla…</option>
                          {templates.map((t) => <option key={t._id} value={t.name}>{t.name}</option>)}
                        </select>
                      )}
                      {s.type === 'wait' && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-slate-600">Esperar</span>
                          <input type="number" value={s.waitMinutes} onChange={(e) => setStep(idx, { waitMinutes: Number(e.target.value) })} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">minutos</span>
                        </div>
                      )}
                      {s.type === 'wait_until' && (
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          <span className="text-slate-600">Esperar hasta</span>
                          <input type="number" value={Math.abs(s.offsetMinutes / 60)} onChange={(e) => setStep(idx, { offsetMinutes: (s.offsetMinutes < 0 ? -1 : 1) * Number(e.target.value) * 60 })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">horas</span>
                          <select value={s.offsetMinutes < 0 ? 'before' : 'after'} onChange={(e) => setStep(idx, { offsetMinutes: (e.target.value === 'before' ? -1 : 1) * Math.abs(s.offsetMinutes) })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            <option value="before">antes de la cita</option>
                            <option value="after">después de la cita</option>
                          </select>
                        </div>
                      )}
                      {(s.type === 'condition' || s.type === 'goal') && (
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          <select value={s.field} onChange={(e) => setStep(idx, { field: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            {FIELDS.map((ff) => <option key={ff.value} value={ff.value}>{ff.label}</option>)}
                          </select>
                          <select value={s.op} onChange={(e) => setStep(idx, { op: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                            {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          {s.op !== 'exists' && s.field === 'lastReply' && (
                            <select value={s.value} onChange={(e) => setStep(idx, { value: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                              {REPLY_VALUES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          )}
                          {s.op !== 'exists' && s.field !== 'hasPatient' && s.field !== 'lastReply' && (
                            <input value={s.value} onChange={(e) => setStep(idx, { value: e.target.value })} placeholder="valor" className="w-28 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          )}
                        </div>
                      )}
                      {s.type === 'wait_reply' && (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-slate-600">Esperar respuesta hasta</span>
                          <input type="number" value={Math.round(s.timeoutMinutes / 60)} onChange={(e) => setStep(idx, { timeoutMinutes: Number(e.target.value) * 60 })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <span className="text-slate-500">horas (luego continúa sin respuesta)</span>
                        </div>
                      )}
                      {s.type === 'set_appointment_status' && (
                        <select value={s.appointmentStatus} onChange={(e) => setStep(idx, { appointmentStatus: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          <option value="confirmada">Marcar cita como CONFIRMADA</option>
                          <option value="cancelada">Marcar cita como CANCELADA</option>
                        </select>
                      )}
                      {(s.type === 'add_tag' || s.type === 'remove_tag') && (
                        <input value={s.tag} onChange={(e) => setStep(idx, { tag: e.target.value })} placeholder="etiqueta" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                      )}
                      {s.type === 'move_stage' && (
                        <select value={s.stage} onChange={(e) => setStep(idx, { stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                          {STAGES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      )}
                      {s.type === 'send_email' && (
                        <div className="grid gap-2">
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Asunto del email</label>
                            <input value={s.emailSubject} onChange={(e) => setStep(idx, { emailSubject: e.target.value })} placeholder="Asunto" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          </div>
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Cuerpo del email (usa {'{{nombre}}'})</label>
                            <textarea value={s.body} onChange={(e) => setStep(idx, { body: e.target.value })} rows={3} placeholder="Contenido del correo" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          </div>
                          <p className="text-[11px] text-slate-400">Se envía al email del paciente. Incluye enlace de baja automático.</p>
                        </div>
                      )}
                      {s.type === 'assign_agent' && (
                        <div className="grid gap-2">
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Modo de asignación</label>
                            <select value={s.assignMode} onChange={(e) => setStep(idx, { assignMode: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                              <option value="roundrobin">Round-robin (agente con menos chats)</option>
                              <option value="user">Agente específico</option>
                            </select>
                          </div>
                          {s.assignMode === 'user' && (
                            <div>
                              <label className="text-xs text-slate-500 block mb-1">Agente</label>
                              <select value={s.assignUser || ''} onChange={(e) => setStep(idx, { assignUser: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                                <option value="">Selecciona…</option>
                                {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      )}
                      {s.type === 'create_task' && (
                        <div className="grid gap-2">
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Título de la tarea</label>
                            <input value={s.taskTitle} onChange={(e) => setStep(idx, { taskTitle: e.target.value })} placeholder="Ej. Llamar a {{nombre}}" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-xs text-slate-500">Vence en</label>
                            <input type="number" value={Math.round((s.taskDueOffsetMinutes || 0) / 60)} onChange={(e) => setStep(idx, { taskDueOffsetMinutes: Number(e.target.value) * 60 })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                            <span className="text-xs text-slate-500">horas</span>
                            <select value={s.assignUser || ''} onChange={(e) => setStep(idx, { assignUser: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" title="Asignar a">
                              <option value="">Auto (round-robin)</option>
                              {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                            </select>
                          </div>
                        </div>
                      )}
                      {s.type === 'webhook' && (
                        <div className="grid gap-2">
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">URL del webhook</label>
                            <input value={s.webhookUrl} onChange={(e) => setStep(idx, { webhookUrl: e.target.value })} placeholder="https://…" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          </div>
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Método HTTP</label>
                            <select value={s.webhookMethod} onChange={(e) => setStep(idx, { webhookMethod: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                              <option value="POST">POST (envía datos del paciente)</option>
                              <option value="GET">GET</option>
                            </select>
                          </div>
                        </div>
                      )}
                      {s.type === 'ai_reply' && (
                        <p className="text-xs text-slate-500">La IA redacta y envía una respuesta automática usando el contexto de la conversación. Útil para primer contacto.</p>
                      )}
                      {s.type === 'request_review' && (
                        <div>
                          <label className="text-xs text-slate-500 block mb-1">Mensaje de invitación a calificar (usa {'{{nombre}}'})</label>
                          <textarea value={s.body} onChange={(e) => setStep(idx, { body: e.target.value })} rows={2} placeholder="¡Gracias por tu visita! Califícanos:" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                          <p className="text-[11px] text-slate-400 mt-1">Se adjunta un enlace de calificación 1-5. Configura tu URL de Google en Configuración Call Center.</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {Object.entries(STEP_DEFS).map(([type, label]) => (
                    <button key={type} onClick={() => addStep(type)} className="px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer hover:border-emerald-400">+ {label}</button>
                  ))}
                </div>
              </div>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Activar al guardar
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
            </div>
          </>
        )}
      </Modal>

      {enrollView && (
        <EnrollmentsModal workflow={enrollView} onClose={() => setEnrollView(null)} />
      )}
    </div>
  );
}

const ENROLL_STATUS = {
  active: { label: 'Ejecutando', cls: 'bg-blue-100 text-blue-700' },
  waiting: { label: 'En espera', cls: 'bg-amber-100 text-amber-700' },
  done: { label: 'Completado', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-500' },
};

// Vista de inscripciones de un workflow (quién está en qué paso) para depurar.
function EnrollmentsModal({ workflow, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    api
      .get(`/workflows/${workflow._id}/enrollments`, { params: statusFilter ? { status: statusFilter } : {} })
      .then((r) => setRows(r.data || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [workflow._id, statusFilter]);

  const fmt = (d) => (d ? new Date(d).toLocaleString('es-EC', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  return (
    <Modal isOpen onClose={onClose} title={`Inscritos — ${workflow.name}`} size="xl">
      <div>
        <p className="text-xs text-slate-500 -mt-1 mb-4">Pacientes que pasaron por esta automatización y su paso actual.</p>
        <div className="mb-3">
          <label className="text-xs text-slate-500 mr-2">Filtrar por estado</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="">Todos</option>
            <option value="active">Ejecutando</option>
            <option value="waiting">En espera</option>
            <option value="done">Completado</option>
            <option value="cancelled">Cancelado</option>
          </select>
        </div>
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">Cargando…</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">Sin inscripciones.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Paciente / Teléfono</th>
                  <th className="text-center px-3 py-2">Estado</th>
                  <th className="text-center px-3 py-2">Paso</th>
                  <th className="text-left px-3 py-2">Próxima ejecución</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const st = ENROLL_STATUS[e.status] || ENROLL_STATUS.active;
                  const name = e.patient ? `${e.patient.firstName || ''} ${e.patient.lastName || ''}`.trim() : '';
                  return (
                    <tr key={e._id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{name || e.patient?.phone || e.context?.phone || 'Contacto'}</td>
                      <td className="px-3 py-2 text-center"><span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span></td>
                      <td className="px-3 py-2 text-center">{e.stepIndex}</td>
                      <td className="px-3 py-2">{e.status === 'waiting' ? fmt(e.nextRunAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
