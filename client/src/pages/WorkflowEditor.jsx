import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowLeft, HiOutlineBolt } from 'react-icons/hi2';
import WorkflowGraphEditor, { stepsToGraph, TRIGGERS } from '../components/WorkflowGraphEditor';

const blank = () => ({
  name: '',
  folder: 'General',
  active: false,
  trigger: { type: 'appointment_created', audience: 'all', serviceFilter: null, keywords: [], matchType: 'contains', tagFilter: '' },
  steps: [],
  nodes: [],
  edges: [],
});

export default function WorkflowEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [wf, setWf] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [agents, setAgents] = useState([]);
  const [folderNames, setFolderNames] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [tpls, ags, fld, list] = await Promise.all([
          api.get('/message-templates?channel=whatsapp').catch(() => ({ data: [] })),
          api.get('/call-center/agents').catch(() => ({ data: [] })),
          api.get('/workflows/folders').catch(() => ({ data: [] })),
          api.get('/workflows').catch(() => ({ data: [] })),
        ]);
        if (!active) return;
        setTemplates((tpls.data || []).filter((t) => t.status === 'approved'));
        setAgents(ags.data || []);
        const names = new Set((fld.data || []).map((f) => f.name));
        (list.data || []).forEach((w) => names.add(w.folder || 'General'));
        setFolderNames([...names].sort());

        if (isNew) {
          const folder = new URLSearchParams(window.location.search).get('folder');
          setWf({ ...blank(), folder: folder || 'General' });
        } else {
          const { data } = await api.get(`/workflows/${id}`);
          const triggerLabel = TRIGGERS.find((t) => t.value === data.trigger?.type)?.label || 'Disparador';
          const hasGraph = Array.isArray(data.nodes) && data.nodes.length > 0;
          const graph = hasGraph
            ? { nodes: data.nodes.map((n) => ({ ...n, data: { ...n.data } })), edges: (data.edges || []).map((e) => ({ ...e })) }
            : stepsToGraph(data.steps || [], triggerLabel);
          setWf({ ...data, trigger: { ...data.trigger }, steps: [], nodes: graph.nodes, edges: graph.edges });
        }
      } catch (e) {
        toast.error(e.response?.data?.message || 'Error al cargar');
        navigate('/workflows');
      }
    };
    load();
    return () => { active = false; };
  }, [id, isNew, navigate]);

  const save = async (close = true) => {
    if (!wf.name.trim()) return toast.error('Ponle un nombre al workflow');
    const actionNodes = (wf.nodes || []).filter((n) => n.type !== 'trigger');
    if (actionNodes.length === 0) return toast.error('Agrega al menos un paso al diagrama');
    setSaving(true);
    const payload = {
      ...wf,
      trigger: { ...wf.trigger, serviceFilter: wf.trigger?.serviceFilter || null },
      steps: [],
      nodes: wf.nodes || [],
      edges: wf.edges || [],
    };
    try {
      if (wf._id) await api.put(`/workflows/${wf._id}`, payload);
      else {
        const { data } = await api.post('/workflows', payload);
        setWf((p) => ({ ...p, _id: data._id }));
      }
      toast.success('Workflow guardado');
      if (close) navigate('/workflows');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  if (!wf) {
    return (
      <div className="fixed inset-0 z-50 bg-white flex items-center justify-center text-slate-400 text-sm">Cargando…</div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col">
      {/* Barra superior */}
      <header className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-slate-200 shrink-0">
        <button onClick={() => navigate('/workflows')} title="Volver" className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer">
          <HiOutlineArrowLeft className="w-5 h-5" />
        </button>
        <HiOutlineBolt className="text-emerald-600 w-5 h-5 shrink-0" />
        <input
          value={wf.name}
          onChange={(e) => setWf({ ...wf, name: e.target.value })}
          placeholder="Nombre de la automatización"
          className="text-base font-semibold text-slate-800 border-none focus:ring-0 outline-none bg-transparent flex-1 min-w-0"
        />
        <input
          list="wf-folders"
          value={wf.folder || 'General'}
          onChange={(e) => setWf({ ...wf, folder: e.target.value })}
          placeholder="Carpeta"
          className="w-36 border border-slate-200 rounded-lg px-3 py-1.5 text-sm shrink-0"
        />
        <datalist id="wf-folders">{folderNames.map((f) => <option key={f} value={f} />)}</datalist>
        <label className="flex items-center gap-2 text-sm text-slate-600 shrink-0 cursor-pointer select-none">
          <input type="checkbox" checked={wf.active} onChange={(e) => setWf({ ...wf, active: e.target.checked })} />
          Activo
        </label>
        <button onClick={() => navigate('/workflows')} className="px-4 py-1.5 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer shrink-0">Cancelar</button>
        <button onClick={() => save(true)} disabled={saving} className="px-5 py-1.5 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none shrink-0 disabled:opacity-60">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </header>

      {/* Lienzo a pantalla completa */}
      <main className="flex-1 min-h-0">
        <WorkflowGraphEditor
          nodes={wf.nodes || []}
          edges={wf.edges || []}
          onChange={({ nodes, edges }) => setWf({ ...wf, nodes, edges })}
          trigger={wf.trigger}
          onTriggerChange={(trigger) => setWf({ ...wf, trigger })}
          templates={templates}
          agents={agents}
        />
      </main>
    </div>
  );
}
