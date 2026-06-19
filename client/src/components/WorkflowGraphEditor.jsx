import { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  HiOutlineTrash,
  HiOutlinePlus,
  HiOutlineXMark,
  HiOutlineBolt,
  HiOutlineChatBubbleLeftRight,
  HiOutlineClock,
  HiOutlineArrowsRightLeft,
  HiOutlineTag,
  HiOutlineCog6Tooth,
} from 'react-icons/hi2';

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

// Agrupación de pasos para el selector (estilo GoHighLevel).
const STEP_GROUPS = [
  { title: 'Comunicación', icon: HiOutlineChatBubbleLeftRight, types: ['send_message', 'send_template', 'send_email', 'ai_reply', 'request_review'] },
  { title: 'Esperas', icon: HiOutlineClock, types: ['wait', 'wait_until', 'wait_reply'] },
  { title: 'Lógica', icon: HiOutlineArrowsRightLeft, types: ['condition', 'goal'] },
  { title: 'Contacto / CRM', icon: HiOutlineTag, types: ['add_tag', 'remove_tag', 'move_stage', 'assign_agent', 'set_appointment_status'] },
  { title: 'Otros', icon: HiOutlineCog6Tooth, types: ['create_task', 'webhook'] },
];

export const TRIGGERS = [
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
export const AUDIENCES = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Solo primera visita' },
  { value: 'existing', label: 'Solo recurrentes' },
];

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
  const nodes = [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: triggerLabel } }];
  const edges = [];
  let prevId = 'trigger';
  steps.forEach((s, i) => {
    const id = `n${i}`;
    nodes.push({ id, type: s.type, position: { x: 0, y: (i + 1) * 130 }, data: { ...s } });
    edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id, sourceHandle: 'default' });
    prevId = id;
  });
  return { nodes, edges };
}

// ─────────── Auto-layout en árbol vertical (estilo GoHighLevel) ───────────
const GAP_Y = 130;
const GAP_X = 240;

function autoLayout(nodes, edges) {
  const childrenOf = {};
  edges.forEach((e) => { (childrenOf[e.source] ||= []).push(e); });
  const order = { yes: 0, no: 1, default: 2 };
  Object.values(childrenOf).forEach((arr) =>
    arr.sort((a, b) => (order[a.sourceHandle] ?? 2) - (order[b.sourceHandle] ?? 2))
  );

  const pos = {};
  const visited = new Set();
  let nextLeaf = 0;

  const place = (id, depth) => {
    if (visited.has(id)) return pos[id]?.x ?? 0;
    visited.add(id);
    const kids = (childrenOf[id] || []).map((e) => e.target).filter((t) => !visited.has(t));
    let x;
    if (kids.length === 0) {
      x = nextLeaf * GAP_X;
      nextLeaf += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    pos[id] = { x, y: depth * GAP_Y };
    return x;
  };

  place('trigger', 0);
  // Nodos sueltos (sin conexión al trigger): se colocan al final.
  nodes.forEach((n) => {
    if (!pos[n.id]) { pos[n.id] = { x: nextLeaf * GAP_X, y: 0 }; nextLeaf += 1; }
  });

  return nodes.map((n) => ({ ...n, position: pos[n.id] || n.position || { x: 0, y: 0 } }));
}

function summarize(n) {
  const d = n.data || {};
  switch (n.type) {
    case 'send_message': return d.body;
    case 'send_template': return d.templateName;
    case 'send_email': return d.emailSubject || d.body;
    case 'wait': return `${d.waitMinutes} min`;
    case 'wait_until': return `${Math.abs((d.offsetMinutes || 0) / 60)}h ${(d.offsetMinutes || 0) < 0 ? 'antes' : 'después'}`;
    case 'add_tag': case 'remove_tag': return d.tag;
    case 'move_stage': return d.stage;
    case 'condition': case 'goal': return `${d.field} ${d.op} ${d.value || ''}`;
    case 'assign_agent': return d.assignMode === 'user' ? 'Agente fijo' : 'Round-robin';
    default: return '';
  }
}

// ─────────── Botón "+" para añadir nodos ───────────
function AddButton({ onClick, style, className = '' }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={style}
      className={`nodrag nopan flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-emerald-400 text-emerald-600 shadow-sm hover:bg-emerald-500 hover:text-white hover:border-emerald-500 cursor-pointer transition-colors ${className}`}
      title="Añadir paso"
    >
      <HiOutlinePlus className="w-3.5 h-3.5" />
    </button>
  );
}

// ─────────── Nodos personalizados ───────────
function TriggerNode({ data }) {
  return (
    <div className="relative">
      <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-700 shadow-sm min-w-[180px] text-center">
        <div className="flex items-center justify-center gap-1.5"><HiOutlineBolt className="w-4 h-4" /> {data.label || 'Disparador'}</div>
        <div className="text-[10px] font-normal text-emerald-600/70 mt-0.5">Disparador · clic para configurar</div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#10b981' }} />
      {!data._hasDefaultOut && (
        <AddButton onClick={() => data.onAppend('default')} style={{ position: 'absolute', left: '50%', bottom: -30, transform: 'translateX(-50%)' }} />
      )}
    </div>
  );
}

function ActionNode({ data, selected }) {
  return (
    <div className="relative">
      <div className={`rounded-xl border bg-white px-4 py-2.5 text-xs shadow-sm min-w-[190px] ${selected ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-300'}`}>
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="font-semibold text-slate-700">{STEP_DEFS[data._type] || data._type}</div>
        {data._summary && <div className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[170px]">{data._summary}</div>}
        <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8' }} />
      </div>
      {!data._hasDefaultOut && (
        <AddButton onClick={() => data.onAppend('default')} style={{ position: 'absolute', left: '50%', bottom: -30, transform: 'translateX(-50%)' }} />
      )}
    </div>
  );
}

function BranchNode({ data, selected }) {
  return (
    <div className="relative">
      <div className={`rounded-xl border bg-amber-50 px-4 py-2.5 text-xs shadow-sm min-w-[200px] ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-300'}`}>
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="font-semibold text-amber-700">◆ {STEP_DEFS[data._type] || data._type}</div>
        {data._summary && <div className="text-[10px] text-amber-600/80 mt-0.5 truncate max-w-[190px]">{data._summary}</div>}
        <div className="flex justify-between text-[9px] font-bold mt-1.5">
          <span className="text-emerald-600">SÍ</span>
          <span className="text-rose-600">NO</span>
        </div>
        <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '25%', background: '#10b981' }} />
        <Handle id="no" type="source" position={Position.Bottom} style={{ left: '75%', background: '#f43f5e' }} />
      </div>
      {!data._hasYesOut && (
        <AddButton onClick={() => data.onAppend('yes')} style={{ position: 'absolute', left: '25%', bottom: -30, transform: 'translateX(-50%)' }} />
      )}
      {!data._hasNoOut && (
        <AddButton onClick={() => data.onAppend('no')} style={{ position: 'absolute', left: '75%', bottom: -30, transform: 'translateX(-50%)' }} />
      )}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, action: ActionNode, branch: BranchNode };

// ─────────── Arista con botón "+" para insertar en medio ───────────
function PlusEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: '#cbd5e1', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
          className="nodrag nopan flex flex-col items-center gap-0.5"
        >
          {label && <span className={`text-[9px] font-bold px-1 rounded ${label === 'Sí' ? 'text-emerald-600' : 'text-rose-600'}`}>{label}</span>}
          <AddButton onClick={() => data.onInsert(id)} />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { plus: PlusEdge };

function toFlowNode(n) {
  const rfType = n.type === 'trigger' ? 'trigger' : isBranch(n.type) ? 'branch' : 'action';
  return {
    id: n.id,
    type: rfType,
    position: n.position || { x: 0, y: 0 },
    draggable: false,
    data: { ...n.data, _type: n.type, _summary: summarize(n) },
  };
}

/**
 * Editor visual de workflows como grafo a pantalla completa (estilo GoHighLevel).
 * Toda la estructura se construye con los botones "+" del propio diagrama:
 *  - "+" bajo un nodo: añade un paso a continuación.
 *  - "+" sobre una línea: inserta un paso entre dos nodos.
 *  - clic en un nodo: abre el panel de configuración (drawer) sobre el lienzo.
 *  - clic en el disparador: abre la configuración del disparador.
 */
export default function WorkflowGraphEditor({
  nodes = [], edges = [], onChange,
  trigger, onTriggerChange,
  templates = [], agents = [],
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(null); // { mode:'append', sourceId, sourceHandle } | { mode:'insert', edgeId }

  const triggerLabel = TRIGGERS.find((t) => t.value === trigger?.type)?.label || 'Disparador';

  // Asegura que siempre exista el nodo trigger.
  const modelNodes = useMemo(() => {
    if (nodes.some((n) => n.type === 'trigger')) return nodes;
    return [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }, ...nodes];
  }, [nodes]);

  // Conjunto de handles ocupados por nodo, para saber qué salidas están libres.
  const outHandles = useMemo(() => {
    const m = {};
    edges.forEach((e) => { (m[e.source] ||= new Set()).add(e.sourceHandle || 'default'); });
    return m;
  }, [edges]);

  const emitGraph = useCallback((nextNodes, nextEdges) => {
    onChange?.({ nodes: autoLayout(nextNodes, nextEdges), edges: nextEdges });
  }, [onChange]);

  const flowNodes = useMemo(
    () => modelNodes.map((n) => {
      const fn = toFlowNode(n);
      const used = outHandles[n.id] || new Set();
      return {
        ...fn,
        data: {
          ...fn.data,
          label: n.type === 'trigger' ? triggerLabel : undefined,
          _hasDefaultOut: used.has('default'),
          _hasYesOut: used.has('yes'),
          _hasNoOut: used.has('no'),
          onAppend: (handle) => setAdding({ mode: 'append', sourceId: n.id, sourceHandle: handle }),
        },
      };
    }),
    [modelNodes, triggerLabel, outHandles]
  );

  const flowEdges = useMemo(
    () => edges.map((e) => ({
      ...e,
      type: 'plus',
      data: { onInsert: (edgeId) => setAdding({ mode: 'insert', edgeId }) },
      label: e.sourceHandle === 'yes' ? 'Sí' : e.sourceHandle === 'no' ? 'No' : undefined,
    })),
    [edges]
  );

  // Inserta/añade un nodo del tipo elegido según el contexto `adding`.
  const handlePickStep = (type) => {
    const id = `n${Date.now()}`;
    const newModelNode = { id, type, position: { x: 0, y: 0 }, data: newNodeData(type) };

    if (adding?.mode === 'append') {
      const newEdge = { id: `e-${adding.sourceId}-${id}`, source: adding.sourceId, target: id, sourceHandle: adding.sourceHandle || 'default' };
      emitGraph([...modelNodes, newModelNode], [...edges, newEdge]);
    } else if (adding?.mode === 'insert') {
      const target = edges.find((e) => e.id === adding.edgeId);
      if (!target) { setAdding(null); return; }
      const rest = edges.filter((e) => e.id !== adding.edgeId);
      const e1 = { id: `e-${target.source}-${id}`, source: target.source, target: id, sourceHandle: target.sourceHandle || 'default' };
      const e2 = { id: `e-${id}-${target.target}`, source: id, target: target.target, sourceHandle: 'default' };
      emitGraph([...modelNodes, newModelNode], [...rest, e1, e2]);
    }
    setAdding(null);
    setSelectedId(id); // abre el panel de configuración del paso recién creado
  };

  const updateNodeData = (id, patch) => {
    const next = modelNodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    onChange?.({ nodes: next, edges });
  };

  const deleteNode = (id) => {
    if (id === 'trigger') return;
    // Reconecta: las entradas del nodo se enlazan a su primer hijo (mantiene la cadena).
    const incoming = edges.filter((e) => e.target === id);
    const outgoing = edges.filter((e) => e.source === id);
    const firstChild = outgoing.find((e) => (e.sourceHandle || 'default') === 'default')?.target;
    let nextEdges = edges.filter((e) => e.source !== id && e.target !== id);
    if (firstChild) {
      incoming.forEach((e) => {
        nextEdges.push({ id: `e-${e.source}-${firstChild}`, source: e.source, target: firstChild, sourceHandle: e.sourceHandle || 'default' });
      });
    }
    emitGraph(modelNodes.filter((n) => n.id !== id), nextEdges);
    setSelectedId(null);
  };

  const selectedNode = modelNodes.find((n) => n.id === selectedId);
  const isTriggerSelected = selectedNode?.type === 'trigger';

  return (
    <ReactFlowProvider>
      <div className="relative w-full h-full">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#e2e8f0" />
          <Controls showInteractive={false} />
        </ReactFlow>

        {/* Drawer de configuración (sobre el lienzo, lado derecho) */}
        {selectedNode && (
          <div className="absolute top-0 right-0 h-full w-[360px] bg-white border-l border-slate-200 shadow-xl flex flex-col z-10">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="text-sm font-bold text-slate-700">
                {isTriggerSelected ? 'Configurar disparador' : STEP_DEFS[selectedNode.type]}
              </span>
              <div className="flex items-center gap-1">
                {!isTriggerSelected && (
                  <button type="button" onClick={() => deleteNode(selectedNode.id)} title="Eliminar paso" className="p-1.5 text-rose-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                )}
                <button type="button" onClick={() => setSelectedId(null)} className="p-1.5 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer">
                  <HiOutlineXMark className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {isTriggerSelected ? (
                <TriggerConfig trigger={trigger} onChange={onTriggerChange} />
              ) : (
                <NodeConfig node={selectedNode} onChange={(patch) => updateNodeData(selectedNode.id, patch)} templates={templates} agents={agents} />
              )}
            </div>
          </div>
        )}

        {/* Selector de paso (al pulsar "+") */}
        {adding && (
          <StepPicker onPick={handlePickStep} onClose={() => setAdding(null)} />
        )}
      </div>
    </ReactFlowProvider>
  );
}

// ─────────── Selector de pasos ───────────
function StepPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80%] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-bold text-slate-700">Añadir un paso</span>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer"><HiOutlineXMark className="w-5 h-5" /></button>
        </div>
        <div className="p-3 border-b border-slate-100">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar paso…" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div className="overflow-y-auto p-3">
          {STEP_GROUPS.map((g) => {
            const items = g.types.filter((t) => !ql || STEP_DEFS[t].toLowerCase().includes(ql));
            if (items.length === 0) return null;
            const Icon = g.icon;
            return (
              <div key={g.title} className="mb-3">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5"><Icon className="w-3.5 h-3.5" /> {g.title}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {items.map((t) => (
                    <button key={t} type="button" onClick={() => onPick(t)} className="text-left px-3 py-2 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer hover:border-emerald-400 hover:bg-emerald-50">
                      {STEP_DEFS[t]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────── Configuración del disparador ───────────
function TriggerConfig({ trigger = {}, onChange }) {
  const set = (patch) => onChange?.({ ...trigger, ...patch });
  const isApptTrigger = trigger.type?.startsWith('appointment');
  const isChatTrigger = ['inbound_message', 'keyword', 'new_conversation'].includes(trigger.type);
  return (
    <div className="grid gap-3">
      <label className="text-sm">
        <span className="text-slate-600 block mb-1">Evento que inicia la automatización</span>
        <select value={trigger.type || 'appointment_created'} onChange={(e) => set({ type: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
          {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      {(isApptTrigger || isChatTrigger) && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Audiencia</span>
          <select value={trigger.audience || 'all'} onChange={(e) => set({ audience: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
            {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      )}
      {trigger.type === 'keyword' && (
        <>
          <label className="text-sm">
            <span className="text-slate-600 block mb-1">Palabras clave (separadas por coma)</span>
            <input
              value={(trigger.keywords || []).join(', ')}
              onChange={(e) => set({ keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
              placeholder="precio, info, agendar"
              className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600 block mb-1">Tipo de coincidencia</span>
            <select value={trigger.matchType || 'contains'} onChange={(e) => set({ matchType: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
              <option value="contains">El mensaje contiene la palabra</option>
              <option value="exact">El mensaje es exactamente la palabra</option>
              <option value="starts">El mensaje empieza con la palabra</option>
            </select>
          </label>
        </>
      )}
      {trigger.type === 'tag_added' && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Etiqueta (vacío = cualquier etiqueta)</span>
          <input value={trigger.tagFilter || ''} onChange={(e) => set({ tagFilter: e.target.value })} placeholder="vip" className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" />
        </label>
      )}
    </div>
  );
}

// ─────────── Formulario de configuración por tipo de nodo ───────────
function NodeConfig({ node, onChange, templates, agents }) {
  const d = node.data || {};
  const set = (patch) => onChange(patch);
  const t = node.type;

  if (t === 'send_message') return (
    <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={4} placeholder="Mensaje (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
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
      <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={4} placeholder="Cuerpo (usa {{nombre}})" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <p className="text-[11px] text-slate-400">Se envía al email del paciente. Incluye enlace de baja automático.</p>
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
      <p className="text-[11px] text-slate-400">Conecta las salidas “Sí” y “No” con los botones + del diagrama.</p>
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
      <select value={d.assignUser || ''} onChange={(e) => set({ assignUser: e.target.value || null })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        <option value="">Auto (round-robin)</option>
        {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
      </select>
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
    <div className="grid gap-2">
      <textarea value={d.body || ''} onChange={(e) => set({ body: e.target.value })} rows={3} placeholder="Mensaje de invitación a calificar" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <p className="text-[11px] text-slate-400">Se adjunta un enlace de calificación 1-5.</p>
    </div>
  );
  if (t === 'ai_reply') return (
    <p className="text-xs text-slate-500">La IA redacta y envía una respuesta usando el contexto de la conversación.</p>
  );
  return <p className="text-xs text-slate-400">Sin configuración.</p>;
}
