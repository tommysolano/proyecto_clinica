import { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { HiOutlineTrash } from 'react-icons/hi2';

// Tipos de paso disponibles en el lienzo (sin 'trigger', que es el nodo inicial).
export const STEP_DEFS = {
  send_message: 'Enviar mensaje',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Esperar (tiempo)',
  wait_until: 'Esperar hasta la cita',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición (sí/no)',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  move_stage: 'Mover etapa',
  set_appointment_status: 'Cambiar estado de cita',
  assign_agent: 'Asignar agente',
  create_task: 'Crear tarea',
  webhook: 'Webhook (integración)',
  ai_reply: 'Responder con IA',
  request_review: 'Pedir reseña',
  goal: 'Objetivo (terminar si)',
};

const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];
const FIELDS = [
  { value: 'tag', label: 'Etiqueta del paciente' },
  { value: 'stage', label: 'Etapa de oportunidad' },
  { value: 'source', label: 'Fuente del paciente' },
  { value: 'lastReply', label: 'Última respuesta del paciente' },
  { value: 'hasPatient', label: 'Tiene paciente vinculado' },
];
const OPS = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'es distinto de' },
  { value: 'contains', label: 'contiene' },
  { value: 'exists', label: 'existe' },
];
const REPLY_VALUES = [
  { value: 'yes', label: 'Sí (confirmó)' },
  { value: 'no', label: 'No (canceló)' },
  { value: 'other', label: 'Otra' },
];

export const newNodeData = (type) => ({
  body: '', templateName: '', templateLanguage: 'es', emailSubject: '',
  waitMinutes: 60, waitEvent: 'appointment_date', offsetMinutes: -1440, timeoutMinutes: 720,
  appointmentStatus: 'confirmada', field: 'tag', op: 'eq', value: '', tag: '', stage: 'contactado',
  assignMode: 'roundrobin', assignUser: null, taskTitle: '', taskDueOffsetMinutes: 1440,
  webhookUrl: '', webhookMethod: 'POST',
});

const isBranch = (t) => t === 'condition' || t === 'goal';

// Convierte el modelo lineal `steps` a nodos/aristas (migración de workflows viejos).
export function stepsToGraph(steps = [], triggerLabel = 'Disparador') {
  const nodes = [{ id: 'trigger', type: 'trigger', position: { x: 240, y: 0 }, data: { label: triggerLabel } }];
  const edges = [];
  let prevId = 'trigger';
  steps.forEach((s, i) => {
    const id = `n${i}`;
    nodes.push({ id, type: s.type, position: { x: 240, y: (i + 1) * 130 }, data: { ...s } });
    edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id, sourceHandle: 'default' });
    prevId = id;
  });
  return { nodes, edges };
}

// ─────────── Nodos personalizados ───────────
function TriggerNode({ data }) {
  return (
    <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 shadow-sm min-w-[160px] text-center">
      ⚡ {data.label || 'Disparador'}
      <Handle type="source" position={Position.Bottom} style={{ background: '#10b981' }} />
    </div>
  );
}

function ActionNode({ data, selected }) {
  return (
    <div className={`rounded-xl border bg-white px-3 py-2 text-xs shadow-sm min-w-[170px] ${selected ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-300'}`}>
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
      <div className="font-semibold text-slate-700">{STEP_DEFS[data._type] || data._type}</div>
      {data._summary && <div className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[160px]">{data._summary}</div>}
      <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8' }} />
    </div>
  );
}

function BranchNode({ data, selected }) {
  return (
    <div className={`rounded-xl border bg-amber-50 px-3 py-2 text-xs shadow-sm min-w-[180px] ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-300'}`}>
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
      <div className="font-semibold text-amber-700">◆ {STEP_DEFS[data._type] || data._type}</div>
      {data._summary && <div className="text-[10px] text-amber-600/80 mt-0.5 truncate max-w-[170px]">{data._summary}</div>}
      <div className="flex justify-between text-[9px] font-bold mt-1">
        <span className="text-emerald-600">SÍ</span>
        <span className="text-rose-600">NO</span>
      </div>
      <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '25%', background: '#10b981' }} />
      <Handle id="no" type="source" position={Position.Bottom} style={{ left: '75%', background: '#f43f5e' }} />
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, action: ActionNode, branch: BranchNode };

// Mapea el nodo del modelo (type = tipo de paso) a un nodo de react-flow.
function toFlowNode(n) {
  const rfType = n.type === 'trigger' ? 'trigger' : isBranch(n.type) ? 'branch' : 'action';
  return {
    id: n.id,
    type: rfType,
    position: n.position || { x: 0, y: 0 },
    data: { ...n.data, _type: n.type, _summary: summarize(n) },
  };
}

function summarize(n) {
  const d = n.data || {};
  switch (n.type) {
    case 'send_message': return d.body;
    case 'send_template': return d.templateName;
    case 'wait': return `${d.waitMinutes} min`;
    case 'add_tag': case 'remove_tag': return d.tag;
    case 'move_stage': return d.stage;
    case 'condition': case 'goal': return `${d.field} ${d.op} ${d.value || ''}`;
    default: return '';
  }
}

/**
 * Editor visual de workflows como grafo (estilo GoHighLevel).
 * Props:
 *  - nodes, edges: modelo del workflow (se convierten a/desde react-flow)
 *  - onChange({ nodes, edges })
 *  - triggerLabel: etiqueta del nodo inicial
 *  - templates, agents: para los paneles de configuración
 */
export default function WorkflowGraphEditor({ nodes = [], edges = [], onChange, triggerLabel, templates = [], agents = [] }) {
  const [selectedId, setSelectedId] = useState(null);

  // Asegura que siempre exista el nodo trigger.
  const modelNodes = useMemo(() => {
    if (nodes.some((n) => n.type === 'trigger')) return nodes;
    return [{ id: 'trigger', type: 'trigger', position: { x: 240, y: 0 }, data: { label: triggerLabel } }, ...nodes];
  }, [nodes, triggerLabel]);

  const flowNodes = useMemo(
    () => modelNodes.map((n) => ({ ...toFlowNode(n), data: { ...toFlowNode(n).data, label: n.type === 'trigger' ? triggerLabel : undefined } })),
    [modelNodes, triggerLabel]
  );
  const flowEdges = useMemo(
    () => edges.map((e) => ({ ...e, animated: true, label: e.sourceHandle === 'yes' ? 'Sí' : e.sourceHandle === 'no' ? 'No' : undefined })),
    [edges]
  );

  const emit = useCallback((nextNodes, nextEdges) => {
    // Persistir solo lo esencial del modelo (sin campos internos _type/_summary).
    const cleanNodes = nextNodes.map((n) => {
      const src = modelNodes.find((m) => m.id === n.id);
      const type = src?.type || (n.type === 'trigger' ? 'trigger' : n.type === 'branch' ? 'condition' : 'action');
      return { id: n.id, type, position: n.position, data: src?.data || {} };
    });
    onChange?.({ nodes: cleanNodes, edges: nextEdges });
  }, [modelNodes, onChange]);

  const onNodesChange = useCallback((changes) => {
    const next = applyNodeChanges(changes, flowNodes);
    emit(next, edges);
  }, [flowNodes, edges, emit]);

  const onEdgesChange = useCallback((changes) => {
    const next = applyEdgeChanges(changes, flowEdges).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'default' }));
    emit(flowNodes, next);
  }, [flowNodes, flowEdges, emit]);

  const onConnect = useCallback((params) => {
    const cleanEdges = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'default' }));
    const next = addEdge({ ...params, sourceHandle: params.sourceHandle || 'default' }, cleanEdges)
      .map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'default' }));
    emit(flowNodes, next);
  }, [edges, flowNodes, emit]);

  const addNode = (type) => {
    const id = `n${Date.now()}`;
    const newModelNode = { id, type, position: { x: 360, y: 120 + modelNodes.length * 40 }, data: newNodeData(type) };
    onChange?.({ nodes: [...modelNodes, newModelNode], edges });
    setSelectedId(id);
  };

  const updateNodeData = (id, patch) => {
    const next = modelNodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    onChange?.({ nodes: next, edges });
  };

  const deleteNode = (id) => {
    if (id === 'trigger') return;
    onChange?.({
      nodes: modelNodes.filter((n) => n.id !== id),
      edges: edges.filter((e) => e.source !== id && e.target !== id),
    });
    setSelectedId(null);
  };

  const selected = modelNodes.find((n) => n.id === selectedId && n.id !== 'trigger');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
      <div>
        <div className="flex flex-wrap gap-1 mb-2">
          {Object.entries(STEP_DEFS).map(([type, label]) => (
            <button key={type} type="button" onClick={() => addNode(type)} className="px-2 py-1 border border-slate-200 rounded-lg text-[11px] bg-white cursor-pointer hover:border-emerald-400">
              + {label}
            </button>
          ))}
        </div>
        <div style={{ height: 460 }} className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            deleteKeyCode={null}
          >
            <Background gap={16} />
            <Controls />
          </ReactFlow>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">Arrastra desde el borde inferior de un nodo al superior de otro para conectarlos. En las condiciones, la salida izquierda es “Sí” y la derecha “No”.</p>
      </div>

      {/* Panel de configuración del nodo seleccionado */}
      <div className="border border-slate-200 rounded-xl p-3 bg-white h-max">
        {!selected ? (
          <p className="text-xs text-slate-400">Selecciona un nodo para configurarlo, o añade uno desde la barra superior.</p>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700">{STEP_DEFS[selected.type]}</span>
              <button type="button" onClick={() => deleteNode(selected.id)} className="p-1 text-rose-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
                <HiOutlineTrash className="w-4 h-4" />
              </button>
            </div>
            <NodeConfig node={selected} onChange={(patch) => updateNodeData(selected.id, patch)} templates={templates} agents={agents} />
          </div>
        )}
      </div>
    </div>
  );
}

// Formulario de configuración por tipo de nodo.
function NodeConfig({ node, onChange, templates, agents }) {
  const d = node.data || {};
  const set = (patch) => onChange(patch);
  const t = node.type;

  if (t === 'send_message') return (
    <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={3} placeholder="Mensaje (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
  );
  if (t === 'send_template') return (
    <select value={d.templateName || ''} onChange={(e) => set({ templateName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
      <option value="">Selecciona plantilla…</option>
      {templates.map((tp) => <option key={tp._id} value={tp.name}>{tp.name}</option>)}
    </select>
  );
  if (t === 'send_email') return (
    <div className="grid gap-2">
      <input value={d.emailSubject || ''} onChange={(e) => set({ emailSubject: e.target.value })} placeholder="Asunto" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={3} placeholder="Cuerpo (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
    </div>
  );
  if (t === 'wait') return (
    <div className="flex items-center gap-2 text-sm">
      <span>Esperar</span>
      <input type="number" value={d.waitMinutes || 0} onChange={(e) => set({ waitMinutes: Number(e.target.value) })} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <span>min</span>
    </div>
  );
  if (t === 'wait_until') return (
    <div className="flex items-center gap-2 text-sm flex-wrap">
      <span>Esperar</span>
      <input type="number" value={Math.abs((d.offsetMinutes || 0) / 60)} onChange={(e) => set({ offsetMinutes: (d.offsetMinutes < 0 ? -1 : 1) * Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <span>h</span>
      <select value={(d.offsetMinutes || 0) < 0 ? 'before' : 'after'} onChange={(e) => set({ offsetMinutes: (e.target.value === 'before' ? -1 : 1) * Math.abs(d.offsetMinutes || 0) })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        <option value="before">antes de la cita</option>
        <option value="after">después de la cita</option>
      </select>
    </div>
  );
  if (t === 'wait_reply') return (
    <div className="flex items-center gap-2 text-sm">
      <span>Esperar respuesta</span>
      <input type="number" value={Math.round((d.timeoutMinutes || 720) / 60)} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <span>h</span>
    </div>
  );
  if (t === 'condition' || t === 'goal') return (
    <div className="grid gap-2">
      <select value={d.field || 'tag'} onChange={(e) => set({ field: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <select value={d.op || 'eq'} onChange={(e) => set({ op: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {d.op !== 'exists' && d.field === 'lastReply' && (
        <select value={d.value || ''} onChange={(e) => set({ value: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          {REPLY_VALUES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      )}
      {d.op !== 'exists' && d.field !== 'hasPatient' && d.field !== 'lastReply' && (
        <input value={d.value || ''} onChange={(e) => set({ value: e.target.value })} placeholder="valor" className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      )}
      <p className="text-[10px] text-slate-400">Conecta la salida “Sí” y “No” a los siguientes nodos.</p>
    </div>
  );
  if (t === 'add_tag' || t === 'remove_tag') return (
    <input value={d.tag || ''} onChange={(e) => set({ tag: e.target.value })} placeholder="etiqueta" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
  );
  if (t === 'move_stage') return (
    <select value={d.stage || 'contactado'} onChange={(e) => set({ stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
      {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
  if (t === 'set_appointment_status') return (
    <select value={d.appointmentStatus || 'confirmada'} onChange={(e) => set({ appointmentStatus: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
      <option value="confirmada">Marcar CONFIRMADA</option>
      <option value="cancelada">Marcar CANCELADA</option>
    </select>
  );
  if (t === 'assign_agent') return (
    <div className="grid gap-2">
      <select value={d.assignMode || 'roundrobin'} onChange={(e) => set({ assignMode: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        <option value="roundrobin">Round-robin</option>
        <option value="user">Agente específico</option>
      </select>
      {d.assignMode === 'user' && (
        <select value={d.assignUser || ''} onChange={(e) => set({ assignUser: e.target.value || null })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Selecciona…</option>
          {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
        </select>
      )}
    </div>
  );
  if (t === 'create_task') return (
    <div className="grid gap-2">
      <input value={d.taskTitle || ''} onChange={(e) => set({ taskTitle: e.target.value })} placeholder="Título de la tarea" className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <div className="flex items-center gap-1 text-sm">
        <span>Vence en</span>
        <input type="number" value={Math.round((d.taskDueOffsetMinutes || 0) / 60)} onChange={(e) => set({ taskDueOffsetMinutes: Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        <span>h</span>
      </div>
    </div>
  );
  if (t === 'webhook') return (
    <div className="grid gap-2">
      <input value={d.webhookUrl || ''} onChange={(e) => set({ webhookUrl: e.target.value })} placeholder="https://…" className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <select value={d.webhookMethod || 'POST'} onChange={(e) => set({ webhookMethod: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        <option value="POST">POST</option>
        <option value="GET">GET</option>
      </select>
    </div>
  );
  if (t === 'request_review') return (
    <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={2} placeholder="Mensaje de invitación a calificar" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
  );
  if (t === 'ai_reply') return (
    <p className="text-xs text-slate-500">La IA redacta y envía una respuesta usando el contexto de la conversación.</p>
  );
  return <p className="text-xs text-slate-400">Sin configuración.</p>;
}
