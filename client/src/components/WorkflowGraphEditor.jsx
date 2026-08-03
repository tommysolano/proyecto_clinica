import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../api/axios';
import NumericInput from './NumericInput';
import WhatsappTextArea, { MESSAGE_VARIABLES } from './WhatsappTextArea';
import TemplateWhatsappPreview from './WhatsappPreview';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  ReactFlowProvider,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
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
  HiOutlineEnvelope,
  HiOutlineDocumentText,
  HiOutlineSparkles,
  HiOutlineStar,
  HiOutlineUserPlus,
  HiOutlineClipboardDocumentList,
  HiOutlineGlobeAlt,
  HiOutlineCalendarDays,
  HiOutlineFlag,
  HiOutlineFunnel,
  HiOutlinePhoto,
  HiOutlineMegaphone,
  HiOutlineUserMinus,
  HiOutlineDocumentDuplicate,
  HiOutlineSquare2Stack,
  HiOutlineClipboard,
  HiOutlineShare,
} from 'react-icons/hi2';

// Tipos de paso disponibles en el lienzo (sin 'trigger', que es el nodo inicial).
export const STEP_DEFS = {
  send_message: 'Enviar mensaje',
  send_media: 'Enviar imagen / video / audio',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Esperar (tiempo)',
  wait_until: 'Esperar hasta la cita / hora fija',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición (sí/no)',
  split: 'Dividir (bifurcación)',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  move_stage: 'Etapa de oportunidad',
  set_appointment_status: 'Cambiar estado de cita',
  assign_agent: 'Asignar agente',
  create_task: 'Crear tarea',
  webhook: 'Webhook (integración)',
  ai_reply: 'Responder con IA',
  request_review: 'Pedir reseña',
  goal: 'Objetivo (terminar si)',
  meta_capi: 'API de conversión de Meta',
  fb_audience_add: 'Añadir a público de Facebook',
  fb_audience_remove: 'Quitar de público de Facebook',
};

// Agrupación de pasos para el selector (estilo GoHighLevel).
const STEP_GROUPS = [
  { title: 'Comunicación', icon: HiOutlineChatBubbleLeftRight, types: ['send_message', 'send_media', 'send_template', 'send_email', 'ai_reply', 'request_review'] },
  { title: 'Esperas', icon: HiOutlineClock, types: ['wait', 'wait_until', 'wait_reply'] },
  { title: 'Lógica', icon: HiOutlineArrowsRightLeft, types: ['condition', 'split', 'goal'] },
  { title: 'Contacto / CRM', icon: HiOutlineTag, types: ['add_tag', 'remove_tag', 'move_stage', 'assign_agent', 'set_appointment_status'] },
  { title: 'Marketing (Meta / Facebook)', icon: HiOutlineMegaphone, types: ['meta_capi', 'fb_audience_add', 'fb_audience_remove'] },
  { title: 'Otros', icon: HiOutlineCog6Tooth, types: ['create_task', 'webhook'] },
];

// Icono + color por tipo de paso (tarjetas del lienzo y selector, estilo Daplox).
const STEP_ICONS = {
  send_message: { icon: HiOutlineChatBubbleLeftRight, cls: 'bg-emerald-100 text-emerald-600' },
  send_media: { icon: HiOutlinePhoto, cls: 'bg-emerald-100 text-emerald-600' },
  send_template: { icon: HiOutlineDocumentText, cls: 'bg-emerald-100 text-emerald-600' },
  send_email: { icon: HiOutlineEnvelope, cls: 'bg-sky-100 text-sky-600' },
  ai_reply: { icon: HiOutlineSparkles, cls: 'bg-violet-100 text-violet-600' },
  request_review: { icon: HiOutlineStar, cls: 'bg-amber-100 text-amber-600' },
  wait: { icon: HiOutlineClock, cls: 'bg-indigo-100 text-indigo-600' },
  wait_until: { icon: HiOutlineCalendarDays, cls: 'bg-indigo-100 text-indigo-600' },
  wait_reply: { icon: HiOutlineChatBubbleLeftRight, cls: 'bg-indigo-100 text-indigo-600' },
  condition: { icon: HiOutlineArrowsRightLeft, cls: 'bg-amber-100 text-amber-600' },
  split: { icon: HiOutlineShare, cls: 'bg-fuchsia-100 text-fuchsia-600' },
  goal: { icon: HiOutlineFlag, cls: 'bg-rose-100 text-rose-600' },
  add_tag: { icon: HiOutlineTag, cls: 'bg-teal-100 text-teal-600' },
  remove_tag: { icon: HiOutlineTag, cls: 'bg-slate-100 text-slate-500' },
  move_stage: { icon: HiOutlineFunnel, cls: 'bg-cyan-100 text-cyan-600' },
  set_appointment_status: { icon: HiOutlineCalendarDays, cls: 'bg-emerald-100 text-emerald-600' },
  assign_agent: { icon: HiOutlineUserPlus, cls: 'bg-blue-100 text-blue-600' },
  create_task: { icon: HiOutlineClipboardDocumentList, cls: 'bg-orange-100 text-orange-600' },
  webhook: { icon: HiOutlineGlobeAlt, cls: 'bg-slate-100 text-slate-600' },
  meta_capi: { icon: HiOutlineMegaphone, cls: 'bg-blue-100 text-blue-600' },
  fb_audience_add: { icon: HiOutlineUserPlus, cls: 'bg-blue-100 text-blue-600' },
  fb_audience_remove: { icon: HiOutlineUserMinus, cls: 'bg-blue-100 text-blue-600' },
};

function StepIcon({ type, className = 'w-6 h-6 p-1' }) {
  const def = STEP_ICONS[type] || { icon: HiOutlineCog6Tooth, cls: 'bg-slate-100 text-slate-500' };
  const Icon = def.icon;
  return (
    <span className={`inline-flex items-center justify-center rounded-lg shrink-0 ${def.cls} ${className}`}>
      <Icon className="w-full h-full" />
    </span>
  );
}

export const TRIGGERS = [
  { value: 'appointment_created', label: 'Cita agendada' },
  { value: 'appointment_confirmed', label: 'Cita confirmada' },
  { value: 'appointment_rescheduled', label: 'Cita reagendada' },
  { value: 'appointment_attended', label: 'Cita asistida' },
  { value: 'appointment_no_show', label: 'No asistió (no-show)' },
  { value: 'appointment_cancelled', label: 'Cita cancelada' },
  { value: 'treatment_abandoned', label: 'Tratamiento abandonado' },
  { value: 'patient_birthday', label: 'Cumpleaños del paciente' },
  { value: 'patient_created', label: 'Paciente creado' },
  { value: 'sale_created', label: 'Venta registrada' },
  { value: 'payment_received', label: 'Pago recibido' },
  { value: 'quotation_sent', label: 'Cotización enviada' },
  { value: 'inbound_message', label: 'Mensaje entrante (chat)' },
  { value: 'keyword', label: 'Palabra clave (chat)' },
  { value: 'new_conversation', label: 'Nueva conversación (chat)' },
  { value: 'tag_added', label: 'Etiqueta añadida' },
  { value: 'opportunity_stage', label: 'Entró a una etapa de oportunidad' },
  { value: 'ctwa_ad', label: 'Mensaje desde anuncio (Meta Ads)' },
  { value: 'contact_import', label: 'Contactos importados (Excel)' },
];
export const AUDIENCES = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Solo primera visita' },
  { value: 'existing', label: 'Solo recurrentes' },
];

const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];
const STAGE_LABELS = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  agendado: 'Agendado',
  ganado: 'Ganado',
  perdido: 'Perdido',
};

// Unidades del paso "Esperar (tiempo)". Se guarda `waitMinutes` (lo que lee el
// motor, admite fracciones para los segundos) + `waitUnit`/`waitValue` para que
// el editor reabra con la MISMA unidad que eligió el usuario.
const WAIT_UNITS = [
  { value: 'seconds', label: 'segundos' },
  { value: 'minutes', label: 'minutos' },
  { value: 'hours', label: 'horas' },
  { value: 'days', label: 'días' },
];
const WAIT_UNIT_MIN = { seconds: 1 / 60, minutes: 1, hours: 60, days: 1440 };
// Workflows viejos solo tenían minutos: deriva una unidad "bonita" desde waitMinutes.
function deriveWaitUnit(mins) {
  const m = Number(mins) || 0;
  if (m > 0 && m % 1440 === 0) return 'days';
  if (m > 0 && m % 60 === 0) return 'hours';
  if (m > 0 && m < 1) return 'seconds';
  return 'minutes';
}
// { unit, value } efectivos de un nodo wait (usa lo guardado o lo deriva).
function waitParts(d = {}) {
  const unit = d.waitUnit || deriveWaitUnit(d.waitMinutes);
  const value =
    d.waitValue != null && d.waitValue !== ''
      ? Number(d.waitValue)
      : Math.round((Number(d.waitMinutes) || 0) / (WAIT_UNIT_MIN[unit] || 1));
  return { unit, value };
}
function formatWaitSummary(d = {}) {
  const { unit, value } = waitParts(d);
  const label = WAIT_UNITS.find((u) => u.value === unit)?.label || 'min';
  return `${value} ${label}`;
}
const FIELDS = [
  { value: 'tag', label: 'Etiqueta del paciente' },
  { value: 'stage', label: 'Etapa de oportunidad' },
  { value: 'source', label: 'Fuente del paciente' },
  { value: 'lastReply', label: 'Última respuesta del paciente' },
  { value: 'hasPatient', label: 'Tiene paciente vinculado' },
  { value: 'clinic', label: 'Sucursal de la cita / evento' },
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
  waitMinutes: 60, waitValue: 60, waitUnit: 'minutes', waitEvent: 'appointment_date', offsetMinutes: -1440, timeoutMinutes: 720,
  waitMode: 'clock', daysBefore: 1, atTime: '18:00',
  appointmentStatus: 'confirmada', field: 'tag', op: 'eq', value: '', tag: '', stage: 'contactado',
  assignMode: 'roundrobin', assignUser: null, taskTitle: '', taskDueOffsetMinutes: 1440,
  webhookUrl: '', webhookMethod: 'POST',
  metaEventName: 'Lead', metaValue: 0, metaCurrency: 'USD', audienceId: '', audienceName: '',
  // Dividir (split): dos rutas 50/50 por defecto (A/B). Cada ruta es una salida
  // con su propio handle = route.id; el motor reparte por % (Random Split).
  ...(type === 'split'
    ? { distribution: 'random', routes: [{ id: 'ra', name: 'Ruta A', percent: 50 }, { id: 'rb', name: 'Ruta B', percent: 50 }] }
    : {}),
});

// Genera un id de ruta único y estable dentro de un split (handle de la salida).
const newRouteId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

const isBranch = (t) => t === 'condition' || t === 'goal';
const isSplit = (t) => t === 'split';

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

  // Cada nodo disparador es la raíz de un flujo independiente: se colocan en
  // columnas contiguas (cada flujo a la derecha del anterior).
  nodes.filter((n) => n.type === 'trigger').forEach((t) => place(t.id, 0));
  // Nodos sueltos (sin conexión a ningún flujo): al final.
  nodes.forEach((n) => {
    if (!pos[n.id]) { pos[n.id] = { x: nextLeaf * GAP_X, y: 0 }; nextLeaf += 1; }
  });

  return nodes.map((n) => ({ ...n, position: pos[n.id] || n.position || { x: 0, y: 0 } }));
}

function summarize(n) {
  const d = n.data || {};
  switch (n.type) {
    case 'send_message': return `${d.mediaUrl ? '📎 ' : ''}${d.body || ''}`;
    case 'send_media': return d.mediaUrl ? `📎 ${d.mediaName || (d.mediaType === 'video' ? 'Video' : d.mediaType === 'audio' ? 'Audio' : 'Imagen')}` : 'Sin archivo';
    case 'send_template': return d.templateName;
    case 'send_email': return d.emailSubject || d.body;
    case 'wait': return formatWaitSummary(d);
    case 'wait_until': return d.waitMode === 'clock'
      ? `${d.daysBefore === 0 ? 'el día de la cita' : d.daysBefore === 1 ? '1 día antes' : `${d.daysBefore} días antes`} a las ${d.atTime || '—'}`
      : `${Math.abs((d.offsetMinutes || 0) / 60)}h ${(d.offsetMinutes || 0) < 0 ? 'antes' : 'después'}`;
    case 'add_tag': case 'remove_tag': return d.tag;
    case 'move_stage': return STAGE_LABELS[d.stage] || d.stage;
    case 'condition': case 'goal': return `${d.field} ${d.op} ${d.value || ''}`;
    case 'split': return d.distribution === 'clinic'
      ? `Por sucursal · ${(d.routes || []).map((r) => (r.isFallback ? 'Otras' : r.name || '—')).join(' / ')}`
      : `Aleatorio · ${(d.routes || []).map((r) => `${r.name} ${Number(r.percent) || 0}%`).join(' / ')}`;
    case 'assign_agent': return d.assignMode === 'user' ? 'Agente fijo' : 'Round-robin';
    case 'meta_capi': return `Evento ${d.metaEventName || 'Lead'}${Number(d.metaValue) > 0 ? ` · ${d.metaValue} ${d.metaCurrency || 'USD'}` : ''}`;
    case 'fb_audience_add': case 'fb_audience_remove': return d.audienceName || d.audienceId || 'Sin público';
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

// Botón "pegar aquí" (estilo Daplox): aparece junto al "+" cuando hay un paso
// copiado. Un clic pega el paso copiado en ese punto, sin abrir el selector.
function PasteButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="nodrag nopan flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-violet-400 text-violet-600 shadow-sm hover:bg-violet-500 hover:text-white hover:border-violet-500 cursor-pointer transition-colors"
      title="Pegar el paso copiado aquí"
    >
      <HiOutlineClipboard className="w-3.5 h-3.5" />
    </button>
  );
}

// Fila de controles bajo un nodo: el "+" para añadir y, si hay algo copiado, el
// botón de pegar al lado. Posición absoluta respecto al nodo.
function AddRow({ data, handle, left = '50%' }) {
  return (
    <div
      style={{ position: 'absolute', left, bottom: -30, transform: 'translateX(-50%)' }}
      className="nodrag nopan flex items-center gap-1"
    >
      <AddButton onClick={() => data.onAppend(handle)} />
      {data._hasClipboard && <PasteButton onClick={() => data.onPasteAppend(handle)} />}
    </div>
  );
}

// Barra flotante de acciones del paso (copiar / duplicar / eliminar), visible al
// pasar el cursor sobre el nodo. No aparece en el disparador (sin estas acciones).
function NodeActions({ data }) {
  if (!data.onDelete) return null;
  return (
    <div className="nodrag nopan absolute -top-3 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-white border border-slate-200 rounded-lg shadow-sm px-0.5 py-0.5 z-10">
      <button type="button" title="Copiar paso" onClick={(e) => { e.stopPropagation(); data.onCopy(); }} className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer">
        <HiOutlineSquare2Stack className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Duplicar paso" onClick={(e) => { e.stopPropagation(); data.onDuplicate(); }} className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer">
        <HiOutlineDocumentDuplicate className="w-3.5 h-3.5" />
      </button>
      <button type="button" title="Eliminar paso" onClick={(e) => { e.stopPropagation(); data.onDelete(); }} className="p-1 text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
        <HiOutlineTrash className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─────────── Nodos personalizados ───────────
// Cada disparador se muestra como su PROPIA tarjeta (estilo Daplox/GoHighLevel),
// más una tarjeta "Añadir nuevo activador". Todas comparten el mismo flujo de
// acciones (lógica OR: cualquiera lo inicia) y una única salida hacia abajo.
function TriggerNode({ data }) {
  const triggers = data._triggers || [];
  return (
    <div className="relative flex flex-col items-stretch gap-2 min-w-[240px]">
      {data._flowCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] font-bold text-emerald-700/70 uppercase tracking-wide flex items-center gap-1">
            <HiOutlineBolt className="w-3 h-3" /> {data._flowLabel || 'Flujo'}
          </span>
          <button type="button" title="Eliminar este flujo" onClick={(e) => { e.stopPropagation(); data.onDeleteFlow(); }} className="nodrag p-0.5 text-slate-300 hover:text-rose-600 bg-transparent border-none cursor-pointer">
            <HiOutlineTrash className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {triggers.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 px-3 py-3 text-[11px] text-emerald-700/70 text-center">Sin disparadores — añade uno.</div>
      )}
      {triggers.map((t, i) => (
        <div
          key={i}
          onClick={(e) => { e.stopPropagation(); data.onSelectTrigger(i); }}
          className="group relative rounded-xl border-2 border-emerald-500 bg-white shadow-sm px-3 py-2.5 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow"
        >
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 text-emerald-600 shrink-0">
              <HiOutlineBolt className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide">
                Activador{triggers.length > 1 ? ` ${i + 1}` : ''}
              </div>
              <div className="text-xs font-semibold text-slate-700 truncate max-w-[160px]">{t.label}</div>
            </div>
          </div>
          {triggers.length > 1 && (
            <button
              type="button"
              title="Quitar este activador"
              onClick={(e) => { e.stopPropagation(); data.onRemoveTrigger(i); }}
              className="nodrag absolute -top-2 -right-2 w-5 h-5 rounded-full bg-white border border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-300 shadow-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            >
              <HiOutlineXMark className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); data.onAddTrigger(); }}
        className="nodrag rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 px-3 py-2.5 text-xs font-medium text-emerald-600 hover:bg-emerald-50 hover:border-emerald-400 cursor-pointer flex items-center justify-center gap-1.5"
      >
        <HiOutlinePlus className="w-4 h-4" /> Añadir nuevo activador
      </button>
      <Handle type="source" position={Position.Bottom} style={{ background: '#10b981' }} />
      {!data._hasDefaultOut && <AddRow data={data} handle="default" />}
    </div>
  );
}

function ActionNode({ data, selected }) {
  return (
    <div className="relative group">
      <NodeActions data={data} />
      <div className={`rounded-xl border bg-white px-3 py-2.5 text-xs shadow-sm min-w-[200px] ${selected ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-300'}`}>
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="flex items-center gap-2">
          <StepIcon type={data._type} />
          <div className="min-w-0">
            <div className="font-semibold text-slate-700">{STEP_DEFS[data._type] || data._type}</div>
            {data._summary && <div className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[160px]">{data._summary}</div>}
          </div>
        </div>
        <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8' }} />
      </div>
      {!data._hasDefaultOut && <AddRow data={data} handle="default" />}
    </div>
  );
}

function BranchNode({ data, selected }) {
  return (
    <div className="relative group">
      <NodeActions data={data} />
      <div className={`rounded-xl border bg-amber-50 px-3 py-2.5 text-xs shadow-sm min-w-[210px] ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-300'}`}>
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="flex items-center gap-2">
          <StepIcon type={data._type} />
          <div className="min-w-0">
            <div className="font-semibold text-amber-700">{STEP_DEFS[data._type] || data._type}</div>
            {data._summary && <div className="text-[10px] text-amber-600/80 mt-0.5 truncate max-w-[165px]">{data._summary}</div>}
          </div>
        </div>
        <div className="flex justify-between text-[9px] font-bold mt-1.5">
          <span className="text-emerald-600">SÍ</span>
          <span className="text-rose-600">NO</span>
        </div>
        <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '25%', background: '#10b981' }} />
        <Handle id="no" type="source" position={Position.Bottom} style={{ left: '75%', background: '#f43f5e' }} />
      </div>
      {!data._hasYesOut && <AddRow data={data} handle="yes" left="25%" />}
      {!data._hasNoOut && <AddRow data={data} handle="no" left="75%" />}
    </div>
  );
}

// Nodo Dividir (bifurcación): una salida por RUTA, repartidas a lo ancho del
// nodo. Cada handle usa el id de la ruta; el "+" bajo cada ruta libre permite
// encadenar su rama. Estilo Daplox/GoHighLevel (Random Split).
function SplitNode({ data, selected }) {
  const routes = data.routes || [];
  const byClinic = data.distribution === 'clinic';
  const used = new Set(data._usedHandles || []);
  const n = Math.max(routes.length, 1);
  return (
    <div className="relative group">
      <NodeActions data={data} />
      <div className={`rounded-xl border bg-fuchsia-50 px-3 py-2.5 text-xs shadow-sm min-w-[230px] ${selected ? 'border-fuchsia-500 ring-2 ring-fuchsia-200' : 'border-fuchsia-300'}`}>
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="flex items-center gap-2">
          <StepIcon type="split" />
          <div className="min-w-0">
            <div className="font-semibold text-fuchsia-700">{STEP_DEFS.split}</div>
            <div className="text-[10px] text-fuchsia-600/80 mt-0.5">{byClinic ? 'Por sucursal' : 'Aleatorio'} · {routes.length} rutas</div>
          </div>
        </div>
        <div className="flex mt-2 border-t border-fuchsia-200/70 pt-1.5">
          {routes.map((r) => (
            <div key={r.id} className="flex-1 min-w-0 text-center px-0.5">
              <div className="text-[10px] font-semibold text-fuchsia-700 truncate" title={r.name}>{r.isFallback ? 'Otras' : r.name || '—'}</div>
              <div className="text-[9px] font-bold text-fuchsia-500">{byClinic ? (r.isFallback ? 'sin match' : 'sede') : `${Number(r.percent) || 0}%`}</div>
            </div>
          ))}
        </div>
        {routes.map((r, i) => (
          <Handle
            key={r.id}
            id={r.id}
            type="source"
            position={Position.Bottom}
            style={{ left: `${((i + 0.5) / n) * 100}%`, background: '#d946ef' }}
          />
        ))}
      </div>
      {routes.map((r, i) => (
        !used.has(r.id) && <AddRow key={r.id} data={data} handle={r.id} left={`${((i + 0.5) / n) * 100}%`} />
      ))}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, action: ActionNode, branch: BranchNode, split: SplitNode };

// ─────────── Arista con "+" para insertar y "×" para desconectar ───────────
function PlusEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label, selected }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: selected ? '#10b981' : '#cbd5e1', strokeWidth: 2 }} interactionWidth={24} />
      <EdgeLabelRenderer>
        <div
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
          className="nodrag nopan flex items-center gap-1"
        >
          {label && <span className={`text-[9px] font-bold px-1 rounded ${label === 'Sí' ? 'text-emerald-600' : 'text-rose-600'}`}>{label}</span>}
          <AddButton onClick={() => data.onInsert(id)} />
          {data.hasClipboard && <PasteButton onClick={() => data.onPasteInsert(id)} />}
          {selected && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); data.onDeleteEdge(id); }}
              title="Eliminar esta conexión"
              className="nodrag nopan flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-rose-400 text-rose-500 shadow-sm hover:bg-rose-500 hover:text-white cursor-pointer"
            >
              <HiOutlineXMark className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { plus: PlusEdge };

function toFlowNode(n) {
  const rfType = n.type === 'trigger' ? 'trigger' : isSplit(n.type) ? 'split' : isBranch(n.type) ? 'branch' : 'action';
  return {
    id: n.id,
    type: rfType,
    position: n.position || { x: 0, y: 0 },
    data: { ...n.data, _type: n.type, _summary: summarize(n) },
  };
}

// IDs de un nodo y todos sus descendientes (para empujar el sub-árbol al insertar).
function descendantIdsInclusive(edges, startId) {
  const childrenOf = {};
  edges.forEach((e) => { (childrenOf[e.source] ||= []).push(e.target); });
  const out = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    (childrenOf[id] || []).forEach((c) => { if (!out.has(c)) { out.add(c); stack.push(c); } });
  }
  return out;
}

// ─────────── Reordenar arrastrando (soltar un paso sobre una conexión) ───────────
const REORDER_DIST = 90; // px: cercanía al centro de una línea para insertar ahí

function nodeCenter(n) {
  const w = n.width || n.__rf?.width || 200;
  const h = n.height || n.__rf?.height || 64;
  return { x: (n.position?.x || 0) + w / 2, y: (n.position?.y || 0) + h / 2 };
}

// Arista más cercana al centro del nodo soltado (excluyendo las suyas propias).
// Devuelve la arista si está dentro del radio, o null si se soltó en vacío.
function findDropEdge(dragged, rfNodes, edges) {
  const dc = nodeCenter(dragged);
  let best = null;
  let bestD = Infinity;
  for (const e of edges) {
    if (e.source === dragged.id || e.target === dragged.id) continue;
    const A = rfNodes.find((n) => n.id === e.source);
    const B = rfNodes.find((n) => n.id === e.target);
    if (!A || !B) continue;
    const a = nodeCenter(A);
    const b = nodeCenter(B);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(dc.x - mid.x, dc.y - mid.y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return bestD <= REORDER_DIST ? best : null;
}

// Fija la conexión (source, handle) → target, reemplazando la que hubiera en ese
// mismo handle (cada salida apunta a un solo paso). IDs únicos por handle.
function setEdge(list, source, target, handle = 'default') {
  const kept = list.filter((e) => !(e.source === source && (e.sourceHandle || 'default') === handle));
  kept.push({ id: `e-${source}-${target}-${handle}`, source, target, sourceHandle: handle });
  return kept;
}

function graphHasCycle(edges) {
  const adj = {};
  edges.forEach((e) => { (adj[e.source] ||= []).push(e.target); });
  const state = {}; // 1 = en la pila, 2 = terminado
  const dfs = (u) => {
    state[u] = 1;
    for (const v of adj[u] || []) {
      if (state[v] === 1) return true;
      if (!state[v] && dfs(v)) return true;
    }
    state[u] = 2;
    return false;
  };
  return Object.keys(adj).some((u) => !state[u] && dfs(u));
}

/**
 * Reordena el paso `dId` insertándolo dentro de la conexión `targetEdge` (A→B):
 * lo saca de su sitio actual (conecta su padre directo con su hijo) y lo mete
 * entre A y B. Solo pasos lineales (una salida por defecto, sin ramas Sí/No).
 * Devuelve las nuevas aristas o null si no aplica / crearía un bucle.
 */
function spliceNodeIntoEdge(dId, targetEdge, modelNodes, edges) {
  const dNode = modelNodes.find((n) => n.id === dId);
  if (!dNode || dNode.type === 'trigger') return null; // el disparador es la raíz
  if (isBranch(dNode.type)) return null; // ramas: reordenar por arrastre es ambiguo
  const A = targetEdge.source;
  const B = targetEdge.target;
  if (A === dId || B === dId) return null; // soltó sobre su propia conexión: nada

  const incoming = edges.filter((e) => e.target === dId);
  const outgoing = edges.filter((e) => e.source === dId);
  const defOut = outgoing.filter((e) => (e.sourceHandle || 'default') === 'default');
  if (outgoing.length > defOut.length || defOut.length > 1) return null; // tiene ramas
  const dChild = defOut[0]?.target || null;

  const handle = targetEdge.sourceHandle || 'default';
  // Fuera todas las aristas de D y la conexión objetivo.
  let next = edges.filter((e) => e.source !== dId && e.target !== dId && e.id !== targetEdge.id);
  // Puentea: los padres de D pasan a apuntar directo a su hijo (si tenía).
  if (dChild) {
    incoming.forEach((pi) => { next = setEdge(next, pi.source, dChild, pi.sourceHandle || 'default'); });
  }
  // Inserta D entre A y B.
  next = setEdge(next, A, dId, handle);
  next = setEdge(next, dId, B, 'default');

  if (graphHasCycle(next)) return null;
  return next;
}

/**
 * Editor visual de workflows como grafo a pantalla completa (estilo GoHighLevel).
 * Toda la estructura se construye con los botones "+" del propio diagrama:
 *  - "+" bajo un nodo: añade un paso a continuación.
 *  - "+" sobre una línea: inserta un paso entre dos nodos.
 *  - clic en un nodo: abre el panel de configuración (drawer) sobre el lienzo.
 *  - clic en el disparador: abre la configuración del disparador.
 */
const defaultTrigger = () => ({ type: 'appointment_created', audience: 'all', serviceFilter: null, keywords: [], matchType: 'contains', tagFilter: '', adFilter: '', adTextFilter: '' });

export default function WorkflowGraphEditor({
  nodes = [], edges = [], onChange,
  templates = [], agents = [], products = [], clinics = [], audiences = [], audiencesNotice = '',
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTrigger, setSelectedTrigger] = useState(null); // { nodeId, idx }
  const [adding, setAdding] = useState(null); // { mode:'append', sourceId, sourceHandle } | { mode:'insert', edgeId }
  // Portapapeles de un paso copiado ({ type, data }); se pega desde el selector "+".
  const [clipboard, setClipboard] = useState(null);
  // Posición del nodo al empezar a arrastrar, para no reordenar por un roce mínimo.
  const dragStartRef = useRef(null);

  // Asegura que siempre exista al menos un nodo disparador (un flujo).
  const modelNodes = useMemo(() => {
    if (nodes.some((n) => n.type === 'trigger')) return nodes;
    return [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [defaultTrigger()] } }, ...nodes];
  }, [nodes]);

  const triggerNodeCount = useMemo(() => modelNodes.filter((n) => n.type === 'trigger').length, [modelNodes]);
  const hasClipboard = !!clipboard;

  // Conjunto de handles ocupados por nodo, para saber qué salidas están libres.
  const outHandles = useMemo(() => {
    const m = {};
    edges.forEach((e) => { (m[e.source] ||= new Set()).add(e.sourceHandle || 'default'); });
    return m;
  }, [edges]);

  const flowNodes = useMemo(
    () => modelNodes.map((n) => {
      const fn = toFlowNode(n);
      const used = outHandles[n.id] || new Set();
      const isTrig = n.type === 'trigger';
      return {
        ...fn,
        data: {
          ...fn.data,
          _triggers: isTrig ? (n.data?.triggers || []).map((t) => ({ label: TRIGGERS.find((x) => x.value === t.type)?.label || 'Disparador' })) : undefined,
          _flowCount: isTrig ? triggerNodeCount : undefined,
          _hasDefaultOut: used.has('default'),
          _hasYesOut: used.has('yes'),
          _hasNoOut: used.has('no'),
          _usedHandles: [...used], // para el nodo Dividir: qué rutas ya están conectadas

          onAppend: (handle) => setAdding({ mode: 'append', sourceId: n.id, sourceHandle: handle }),
          onSelectTrigger: (i) => { setSelectedTrigger({ nodeId: n.id, idx: i }); setSelectedId(null); },
          onAddTrigger: () => addTriggerToNode(n.id),
          onRemoveTrigger: (i) => removeTrigger(n.id, i),
          onDeleteFlow: () => deleteFlow(n.id),
          // Acciones rápidas del paso (barra al pasar el cursor). No en el disparador.
          onCopy: isTrig ? undefined : () => copyNode(n.id),
          onDuplicate: isTrig ? undefined : () => duplicateNode(n.id),
          onDelete: isTrig ? undefined : () => deleteNode(n.id),
          // Pegar el paso copiado directo bajo este nodo (icono junto al "+").
          _hasClipboard: hasClipboard,
          onPasteAppend: (handle) => pasteAt({ mode: 'append', sourceId: n.id, sourceHandle: handle }),
        },
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelNodes, outHandles, triggerNodeCount, hasClipboard]
  );

  // Estado interno de react-flow para que arrastrar sea FLUIDO (sin parpadeo):
  // el drag actualiza este estado local; al soltar, persistimos en el modelo.
  // Se inicializa con los nodos ya calculados para que `fitView` funcione al montar.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(flowNodes);
  // Al re-sincronizar el modelo → react-flow se MEZCLA en vez de reemplazar: se
  // conservan las dimensiones ya MEDIDAS (width/height) y el estado interno de
  // cada nodo, actualizando solo tipo/posición/datos. Reemplazar el array entero
  // hacía que react-flow volviera a medir todos los nodos y el diagrama
  // "desaparecía" un instante en cada movimiento.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return flowNodes.map((fn) => {
        const old = prevById.get(fn.id);
        return old ? { ...old, type: fn.type, position: fn.position, data: fn.data } : fn;
      });
    });
  }, [flowNodes, setRfNodes]);

  const onNodeDragStart = useCallback((_evt, node) => {
    dragStartRef.current = { id: node.id, ...node.position };
  }, []);

  // Al soltar: si el paso se dejó ENCIMA de una conexión, se REORDENA (se inserta
  // ahí y se re-cablea). Si se soltó en vacío, solo se guarda su nueva posición.
  const onNodeDragStop = useCallback((_evt, node) => {
    const persistPositions = () => {
      const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
      const next = modelNodes.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id) } : n));
      onChange?.({ nodes: next, edges });
    };

    const start = dragStartRef.current;
    dragStartRef.current = null;
    const moved = start && start.id === node.id
      ? Math.hypot((node.position?.x || 0) - start.x, (node.position?.y || 0) - start.y)
      : 0;
    const draggedModel = modelNodes.find((n) => n.id === node.id);
    // Reordenar solo si se movió de verdad (evita reordenar por un clic-arrastre mínimo).
    if (draggedModel && draggedModel.type !== 'trigger' && moved > 30) {
      const target = findDropEdge(node, rfNodes, edges);
      if (target) {
        const newEdges = spliceNodeIntoEdge(node.id, target, modelNodes, edges);
        if (newEdges) {
          onChange?.({ nodes: autoLayout(modelNodes, newEdges), edges: newEdges });
          toast.success('Paso reordenado');
          return;
        }
      }
    }
    persistPositions();
  }, [rfNodes, modelNodes, edges, onChange]);

  const deleteEdge = useCallback((edgeId) => {
    onChange?.({ nodes: modelNodes, edges: edges.filter((e) => e.id !== edgeId) });
  }, [modelNodes, edges, onChange]);

  // Nombre de ruta por (nodo split, handle) para etiquetar sus aristas.
  const splitRouteName = useMemo(() => {
    const m = {};
    modelNodes.forEach((n) => {
      if (n.type === 'split') (n.data?.routes || []).forEach((r) => { m[`${n.id}:${r.id}`] = r.name; });
    });
    return m;
  }, [modelNodes]);

  const flowEdges = useMemo(
    () => edges.map((e) => ({
      ...e,
      type: 'plus',
      data: {
        onInsert: (edgeId) => setAdding({ mode: 'insert', edgeId }),
        onDeleteEdge: deleteEdge,
        hasClipboard,
        onPasteInsert: (edgeId) => pasteAt({ mode: 'insert', edgeId }),
      },
      label:
        e.sourceHandle === 'yes' ? 'Sí'
          : e.sourceHandle === 'no' ? 'No'
            : splitRouteName[`${e.source}:${e.sourceHandle}`] || undefined,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, deleteEdge, hasClipboard, splitRouteName]
  );

  // ── Conexión manual con el mouse (arrastrar desde un punto a otro nodo) ──
  // Valida que la conexión tenga sentido y REEMPLAZA la salida existente del
  // mismo handle (cada salida — default/Sí/No — apunta a un solo paso).
  const isValidConnection = useCallback((conn) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    const targetNode = modelNodes.find((n) => n.id === conn.target);
    if (!targetNode || targetNode.type === 'trigger') return false; // nada entra a un disparador
    // Sin ciclos: el destino no puede ser un ancestro (evita bucles de mensajes).
    const reachableFromTarget = descendantIdsInclusive(edges, conn.target);
    if (reachableFromTarget.has(conn.source)) return false;
    return true;
  }, [modelNodes, edges]);

  const onConnect = useCallback((conn) => {
    if (!isValidConnection(conn)) {
      const targetNode = modelNodes.find((n) => n.id === conn.target);
      if (targetNode?.type === 'trigger') toast.error('No puedes conectar hacia un disparador');
      else if (conn.source && conn.target && conn.source !== conn.target) toast.error('Esa conexión crearía un bucle en el flujo');
      return;
    }
    const handle = conn.sourceHandle || 'default';
    // Una salida por handle: si ya había conexión desde ese punto, se reemplaza.
    const rest = edges.filter((e) => !(e.source === conn.source && (e.sourceHandle || 'default') === handle));
    const newEdge = { id: `e-${conn.source}-${conn.target}-${handle}`, source: conn.source, target: conn.target, sourceHandle: handle };
    if (rest.some((e) => e.id === newEdge.id)) return; // ya existe exactamente esta conexión
    onChange?.({ nodes: modelNodes, edges: [...rest, newEdge] });
  }, [isValidConnection, modelNodes, edges, onChange]);

  // ── Disparadores por flujo (cada nodo trigger guarda su propia lista, lógica OR) ──
  const setNodeTriggers = (nodeId, arr) =>
    onChange?.({ nodes: modelNodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, triggers: arr } } : n)), edges });
  const addTriggerToNode = (nodeId) => {
    const node = modelNodes.find((n) => n.id === nodeId);
    const arr = [...(node?.data?.triggers || []), defaultTrigger()];
    setNodeTriggers(nodeId, arr);
    setSelectedTrigger({ nodeId, idx: arr.length - 1 });
    setSelectedId(null);
  };
  const setTriggerAt = (nodeId, idx, full) => {
    const node = modelNodes.find((n) => n.id === nodeId);
    setNodeTriggers(nodeId, (node?.data?.triggers || []).map((t, i) => (i === idx ? full : t)));
  };
  const removeTrigger = (nodeId, idx) => {
    const node = modelNodes.find((n) => n.id === nodeId);
    setNodeTriggers(nodeId, (node?.data?.triggers || []).filter((_, i) => i !== idx));
    setSelectedTrigger(null);
  };

  // ── Flujos (varios disparadores independientes en el mismo diagrama) ──
  const addFlow = () => {
    const id = `trigger-${Date.now()}`;
    const maxX = Math.max(0, ...modelNodes.map((n) => n.position?.x || 0));
    const newNode = { id, type: 'trigger', position: { x: maxX + GAP_X * 1.4, y: 0 }, data: { triggers: [defaultTrigger()] } };
    onChange?.({ nodes: [...modelNodes, newNode], edges });
    setSelectedTrigger({ nodeId: id, idx: 0 });
    setSelectedId(null);
  };
  const deleteFlow = (nodeId) => {
    if (triggerNodeCount <= 1) return; // siempre debe quedar al menos un flujo
    // Conserva los nodos que sigan alcanzables desde OTROS flujos (por si comparten pasos).
    const keep = new Set();
    modelNodes.filter((n) => n.type === 'trigger' && n.id !== nodeId).forEach((t) => {
      descendantIdsInclusive(edges, t.id).forEach((x) => keep.add(x));
    });
    const remove = new Set([...descendantIdsInclusive(edges, nodeId)].filter((x) => x === nodeId || !keep.has(x)));
    onChange?.({
      nodes: modelNodes.filter((n) => !remove.has(n.id)),
      edges: edges.filter((e) => !remove.has(e.source) && !remove.has(e.target)),
    });
    setSelectedTrigger(null);
  };

  // Inserta un nodo (nuevo o PEGADO) en un contexto dado ({mode:'append'|'insert'}).
  // `presetData` = configuración a copiar (pegar); si no, valores por defecto.
  const insertStep = (type, presetData, context) => {
    if (!context) return;
    const id = `n${Date.now()}`;
    const data = presetData ? JSON.parse(JSON.stringify(presetData)) : newNodeData(type);
    const newModelNode = { id, type, position: { x: 0, y: 0 }, data };

    if (context.mode === 'append') {
      const src = modelNodes.find((n) => n.id === context.sourceId);
      const base = src?.position || { x: 0, y: 0 };
      let dx = context.sourceHandle === 'yes' ? -GAP_X / 2 : context.sourceHandle === 'no' ? GAP_X / 2 : 0;
      // Dividir: cada ruta baja bajo su columna (repartidas a la izquierda/derecha).
      if (src?.type === 'split') {
        const routes = src.data?.routes || [];
        const idx = routes.findIndex((r) => r.id === context.sourceHandle);
        if (idx >= 0 && routes.length > 1) dx = (idx - (routes.length - 1) / 2) * GAP_X;
      }
      newModelNode.position = { x: base.x + dx, y: base.y + GAP_Y };
      const newEdge = { id: `e-${context.sourceId}-${id}`, source: context.sourceId, target: id, sourceHandle: context.sourceHandle || 'default' };
      onChange?.({ nodes: [...modelNodes, newModelNode], edges: [...edges, newEdge] });
    } else if (context.mode === 'insert') {
      const target = edges.find((e) => e.id === context.edgeId);
      if (!target) { setAdding(null); return; }
      const dst = modelNodes.find((n) => n.id === target.target);
      const src = modelNodes.find((n) => n.id === target.source);
      newModelNode.position = dst?.position
        ? { x: dst.position.x, y: dst.position.y }
        : { x: src?.position?.x || 0, y: (src?.position?.y || 0) + GAP_Y };
      const rest = edges.filter((e) => e.id !== context.edgeId);
      const e1 = { id: `e-${target.source}-${id}`, source: target.source, target: id, sourceHandle: target.sourceHandle || 'default' };
      const e2 = { id: `e-${id}-${target.target}`, source: id, target: target.target, sourceHandle: 'default' };
      const newEdges = [...rest, e1, e2];
      // Empuja el sub-árbol del destino hacia abajo para hacer hueco al nodo nuevo.
      const shift = descendantIdsInclusive(newEdges, target.target);
      const shifted = modelNodes.map((n) => (shift.has(n.id) ? { ...n, position: { x: n.position?.x || 0, y: (n.position?.y || 0) + GAP_Y } } : n));
      onChange?.({ nodes: [...shifted, newModelNode], edges: newEdges });
    }
    setAdding(null);
    setSelectedId(id); // abre el panel de configuración del paso recién creado
    setSelectedTrigger(null);
  };

  // Al elegir un tipo en el selector "+": inserta en el contexto guardado en `adding`.
  const handlePickStep = (type) => insertStep(type, null, adding);
  // Pegar el paso copiado DIRECTAMENTE (sin abrir el selector), estilo Daplox:
  // el icono de pegar aparece junto a cada "+" cuando hay algo copiado.
  const pasteAt = (context) => { if (clipboard) insertStep(clipboard.type, clipboard.data, context); };

  const updateNodeData = (id, patch) => {
    const next = modelNodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    onChange?.({ nodes: next, edges });
  };

  // Quitar una ruta de un nodo Dividir: además de sacarla de los datos, elimina la
  // arista que salía de esa ruta (si no, quedaría una conexión huérfana).
  const removeSplitRoute = (nodeId, routeId) => {
    const node = modelNodes.find((n) => n.id === nodeId);
    const routes = (node?.data?.routes || []).filter((r) => r.id !== routeId);
    if (routes.length < 1) return; // un split necesita al menos una ruta
    const nextNodes = modelNodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, routes } } : n));
    const nextEdges = edges.filter((e) => !(e.source === nodeId && e.sourceHandle === routeId));
    onChange?.({ nodes: nextNodes, edges: nextEdges });
  };

  const deleteNode = (id) => {
    if (modelNodes.find((n) => n.id === id)?.type === 'trigger') return;
    // Reconecta: las entradas del nodo se enlazan a su primer hijo (mantiene la cadena).
    const incoming = edges.filter((e) => e.target === id);
    const outgoing = edges.filter((e) => e.source === id);
    const firstChild = outgoing.find((e) => (e.sourceHandle || 'default') === 'default')?.target;
    const nextEdges = edges.filter((e) => e.source !== id && e.target !== id);
    if (firstChild) {
      incoming.forEach((e) => {
        nextEdges.push({ id: `e-${e.source}-${firstChild}`, source: e.source, target: firstChild, sourceHandle: e.sourceHandle || 'default' });
      });
    }
    onChange?.({ nodes: modelNodes.filter((n) => n.id !== id), edges: nextEdges });
    setSelectedId(null);
  };

  // Copia la configuración de un paso al portapapeles interno (para "Pegar" desde
  // cualquier "+" del diagrama). No modifica el flujo.
  const copyNode = (id) => {
    const src = modelNodes.find((n) => n.id === id);
    if (!src || src.type === 'trigger') return;
    setClipboard({ type: src.type, data: JSON.parse(JSON.stringify(src.data || {})) });
    toast.success('Paso copiado. Pega con el icono 📋 que aparece junto a cualquier "+".');
  };

  // Duplica un paso: crea una copia con su misma configuración. Para pasos lineales
  // se inserta JUSTO DESPUÉS del original (listo para usar); las ramas (Sí/No) se
  // duplican al lado, sin conectar (conéctalas donde quieras).
  const duplicateNode = (id) => {
    const src = modelNodes.find((n) => n.id === id);
    if (!src || src.type === 'trigger') return;
    const newId = `n${Date.now()}`;
    const clone = {
      id: newId,
      type: src.type,
      position: { x: (src.position?.x || 0) + GAP_X * 0.5, y: (src.position?.y || 0) + GAP_Y * 0.6 },
      data: JSON.parse(JSON.stringify(src.data || {})),
    };
    // Las ramas (condición/objetivo) y el Dividir tienen varias salidas: se
    // duplican SUELTAS (el usuario decide dónde conectar cada rama).
    const branchLike = isBranch(src.type) || isSplit(src.type);
    const defEdge = branchLike
      ? null
      : edges.find((e) => e.source === id && (e.sourceHandle || 'default') === 'default');
    if (defEdge) {
      // original → copia → (antiguo hijo del original)
      let nextEdges = edges.filter((e) => e.id !== defEdge.id);
      nextEdges = setEdge(nextEdges, id, newId, 'default');
      nextEdges = setEdge(nextEdges, newId, defEdge.target, 'default');
      const shift = descendantIdsInclusive(nextEdges, defEdge.target);
      const shifted = modelNodes.map((n) => (shift.has(n.id) ? { ...n, position: { x: n.position?.x || 0, y: (n.position?.y || 0) + GAP_Y } } : n));
      onChange?.({ nodes: [...shifted, clone], edges: nextEdges });
    } else if (!branchLike) {
      // El original no tenía continuación: la copia queda enganchada tras él.
      onChange?.({ nodes: [...modelNodes, clone], edges: setEdge(edges, id, newId, 'default') });
    } else {
      // Rama: copia suelta (el usuario decide dónde conectarla).
      onChange?.({ nodes: [...modelNodes, clone], edges });
    }
    setSelectedId(newId);
    toast.success('Paso duplicado');
  };

  const tidy = () => onChange?.({ nodes: autoLayout(modelNodes, edges), edges });

  const selectedNode = modelNodes.find((n) => n.id === selectedId && n.type !== 'trigger');
  const selTrigNode = selectedTrigger ? modelNodes.find((n) => n.id === selectedTrigger.nodeId) : null;
  const selTrig = selTrigNode?.data?.triggers?.[selectedTrigger?.idx] ?? null;
  const selTrigCount = selTrigNode?.data?.triggers?.length || 0;

  return (
    <ReactFlowProvider>
      <div className="relative w-full h-full">
        <ReactFlow
          nodes={rfNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          connectionRadius={38}
          nodeDragThreshold={6}
          onNodeClick={(_, n) => { if (n.type === 'trigger') { setSelectedTrigger({ nodeId: n.id, idx: 0 }); setSelectedId(null); } else { setSelectedId(n.id); setSelectedTrigger(null); } }}
          onPaneClick={() => { setSelectedId(null); setSelectedTrigger(null); }}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} color="#e2e8f0" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            className="!bg-white/90 border border-slate-200 rounded-lg"
            nodeColor={(n) => (n.type === 'trigger' ? '#10b981' : n.type === 'branch' ? '#f59e0b' : '#cbd5e1')}
          />
        </ReactFlow>

        {/* Acciones del lienzo */}
        <div className="absolute top-3 left-3 z-10 flex gap-2">
          <button
            type="button"
            onClick={addFlow}
            className="px-3 py-1.5 bg-emerald-600 text-white border-none rounded-lg text-xs shadow-sm hover:bg-emerald-700 cursor-pointer flex items-center gap-1"
            title="Añade un disparador con su propio flujo independiente"
          >
            <HiOutlinePlus className="w-3.5 h-3.5" /> Añadir flujo
          </button>
          <button
            type="button"
            onClick={tidy}
            className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-600 shadow-sm hover:border-emerald-400 cursor-pointer"
            title="Reorganiza los nodos en un árbol ordenado"
          >
            Auto-organizar
          </button>
          <span className="hidden md:inline-flex items-center px-3 py-1.5 bg-white/80 border border-slate-200 rounded-lg text-[11px] text-slate-400 shadow-sm select-none">
            Arrastra un paso sobre una línea para reordenarlo · pasa el cursor sobre un paso para copiar/duplicar/eliminar · tras copiar, pega con el icono junto a un “+”
          </span>
        </div>

        {/* Drawer de configuración del disparador */}
        {selTrig && (
          <Drawer
            title="Configurar disparador"
            onClose={() => setSelectedTrigger(null)}
            onDelete={selTrigCount > 1 ? () => removeTrigger(selectedTrigger.nodeId, selectedTrigger.idx) : null}
          >
            <TriggerConfig trigger={selTrig} products={products} clinics={clinics} onChange={(full) => setTriggerAt(selectedTrigger.nodeId, selectedTrigger.idx, full)} />
          </Drawer>
        )}

        {/* Drawer de configuración del paso */}
        {selectedNode && (
          <Drawer
            title={STEP_DEFS[selectedNode.type]}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteNode(selectedNode.id)}
          >
            <NodeConfig node={selectedNode} onChange={(patch) => updateNodeData(selectedNode.id, patch)} onRemoveRoute={(routeId) => removeSplitRoute(selectedNode.id, routeId)} templates={templates} agents={agents} clinics={clinics} audiences={audiences} audiencesNotice={audiencesNotice} />
          </Drawer>
        )}

        {/* Selector de paso (al pulsar "+") */}
        {adding && (
          <StepPicker onPick={handlePickStep} onClose={() => setAdding(null)} />
        )}
      </div>
    </ReactFlowProvider>
  );
}

// Panel lateral derecho sobre el lienzo.
function Drawer({ title, onClose, onDelete, children }) {
  return (
    <div className="absolute top-0 right-0 h-full w-[360px] bg-white border-l border-slate-200 shadow-xl flex flex-col z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <span className="text-sm font-bold text-slate-700">{title}</span>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button type="button" onClick={onDelete} title="Eliminar" className="p-1.5 text-rose-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
              <HiOutlineTrash className="w-4 h-4" />
            </button>
          )}
          <button type="button" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer">
            <HiOutlineXMark className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
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
                    <button key={t} type="button" onClick={() => onPick(t)} className="text-left px-2.5 py-2 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer hover:border-emerald-400 hover:bg-emerald-50 flex items-center gap-2">
                      <StepIcon type={t} className="w-6 h-6 p-1" /> {STEP_DEFS[t]}
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

// Entrada de VARIOS IDs de anuncio (chips). Internamente se guarda como un único
// string separado por comas en `trigger.adFilter` (el backend lo divide por coma),
// para no romper compatibilidad con los flujos ya guardados.
function AdIdsInput({ value = '', onChange }) {
  const [draft, setDraft] = useState('');
  const ids = String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const commit = (next) => {
    // De-duplica conservando el orden de inserción.
    const seen = new Set();
    const clean = next.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    onChange(clean.join(', '));
  };

  const addDraft = () => {
    // Permite pegar varios de golpe (separados por coma o espacios).
    const parts = draft.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) { setDraft(''); return; }
    commit([...ids, ...parts]);
    setDraft('');
  };

  return (
    <div>
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {ids.map((id, i) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full pl-2.5 pr-1 py-1 text-xs font-mono"
            >
              {id}
              <button
                type="button"
                onClick={() => commit(ids.filter((_, idx) => idx !== i))}
                className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-emerald-200 text-emerald-600 cursor-pointer border-none bg-transparent p-0"
                title="Quitar este anuncio"
              >
                <HiOutlineXMark className="w-3.5 h-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addDraft(); }
          }}
          onBlur={addDraft}
          placeholder="120211234567890123"
          className="flex-1 border border-slate-200 rounded-lg px-2 py-2 text-sm font-mono"
        />
        <button
          type="button"
          onClick={addDraft}
          className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm cursor-pointer border-none hover:bg-emerald-700 flex items-center gap-1 shrink-0"
        >
          <HiOutlinePlus className="w-4 h-4" /> Añadir
        </button>
      </div>
    </div>
  );
}

// ─────────── Configuración del disparador ───────────
function TriggerConfig({ trigger = {}, onChange, products = [], clinics = [] }) {
  const set = (patch) => onChange?.({ ...trigger, ...patch });
  const isApptTrigger = trigger.type?.startsWith('appointment');
  const isChatTrigger = ['inbound_message', 'keyword', 'new_conversation', 'ctwa_ad'].includes(trigger.type);
  const isOppTrigger = trigger.type === 'opportunity_stage';
  const bookable = products.filter((p) => ['servicio', 'programa'].includes(p.category));
  return (
    <div className="grid gap-3">
      <label className="text-sm">
        <span className="text-slate-600 block mb-1">Evento que inicia la automatización</span>
        <select value={trigger.type || 'appointment_created'} onChange={(e) => set({ type: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
          {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      {(isApptTrigger || isChatTrigger || isOppTrigger) && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Audiencia</span>
          <select value={trigger.audience || 'all'} onChange={(e) => set({ audience: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
            {AUDIENCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
      )}
      {isOppTrigger && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Etapa a la que entra</span>
          <select value={trigger.stageFilter || ''} onChange={(e) => set({ stageFilter: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm">
            <option value="">Cualquier etapa</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
          </select>
          <span className="text-[11px] text-slate-400 block mt-1">
            Se dispara cuando un agente mueve la oportunidad del chat a esta etapa (o a cualquiera si
            lo dejas vacío), desde el chat o al agendar. No se dispara con el paso "Etapa de
            oportunidad" de otra automatización (para evitar cascadas).
          </span>
        </label>
      )}
      {!isChatTrigger && !isOppTrigger && clinics.length > 1 && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Solo si ocurre en esta sucursal</span>
          <select
            value={trigger.clinicFilter || ''}
            onChange={(e) => set({ clinicFilter: e.target.value || null })}
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
          >
            <option value="">Cualquier sucursal</option>
            {clinics.map((c) => <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>)}
          </select>
          <span className="text-[11px] text-slate-400 block mt-1">
            Permite un flujo distinto por sede: p.ej. al agendar en una sucursal se envía
            un video y al agendar en otra, un video diferente (un flujo por sucursal).
          </span>
        </label>
      )}
      {isApptTrigger && bookable.length > 0 && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Solo si la cita incluye este servicio/programa</span>
          <select
            value={trigger.serviceFilter || ''}
            onChange={(e) => set({ serviceFilter: e.target.value || null })}
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
          >
            <option value="">Cualquier servicio</option>
            {bookable.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          <span className="text-[11px] text-slate-400 block mt-1">
            Útil para flujos por tratamiento (p.ej. solo citas de "Control hepático").
          </span>
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
      {trigger.type === 'ctwa_ad' && (
        <div className="text-sm">
          <span className="text-slate-600 block mb-1">Título del anuncio contiene (recomendado)</span>
          <input
            value={trigger.adTextFilter || ''}
            onChange={(e) => set({ adTextFilter: e.target.value })}
            placeholder="ej. Profilaxis  (varios separados por coma)"
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
          />
          <span className="text-[11px] text-slate-400 block mt-1 mb-3">
            Dispara si el <b>título del anuncio</b> contiene este texto. Es lo más estable: a
            diferencia del ID, el título no cambia aunque edites o recrees el anuncio. Varios
            separados por coma (dispara con cualquiera).
          </span>
          <span className="text-slate-600 block mb-1">IDs de anuncios (opcional, vacío = cualquiera)</span>
          <AdIdsInput value={trigger.adFilter || ''} onChange={(v) => set({ adFilter: v })} />
          <span className="text-[11px] text-amber-600 block mt-1">
            ⚠️ Ojo: Meta <b>cambia el ID</b> del anuncio cada vez que lo editas, así que filtrar por
            ID se rompe seguido. Copia el ID desde la tarjeta "📣 desde anuncio" del chat (no del
            Administrador de Anuncios: no coinciden). Si dejas ambos filtros vacíos, dispara con
            cualquier anuncio. Requiere número Cloud API (los QR no reciben el dato del anuncio).
          </span>
        </div>
      )}
      {trigger.type === 'contact_import' && (
        <label className="text-sm">
          <span className="text-slate-600 block mb-1">Hora de envío por defecto (envíos masivos)</span>
          <input
            type="time"
            value={/^\d{1,2}:\d{2}$/.test(trigger.sendHour || '') ? trigger.sendHour : ''}
            onChange={(e) => set({ sendHour: e.target.value })}
            className="w-40 border border-slate-200 rounded-lg px-2 py-2 text-sm"
          />
          <span className="text-[11px] text-slate-400 block mt-1">
            Al importar contactos a este flujo, el 1er mensaje se enviará a esta hora (hoy si aún no
            pasa, mañana si ya pasó). Déjalo vacío para enviar de inmediato. Al hacer el envío masivo
            el sistema avisará y podrás usar esta hora o indicar otra en ese momento.
          </span>
        </label>
      )}
    </div>
  );
}

// ─────────── Previsualización estilo WhatsApp ───────────
// Valores de ejemplo para ver el mensaje "como se envía" (las variables reales
// las resuelve el backend con los datos del paciente/cita al ejecutar el flujo).
const SAMPLE_VARS = {
  nombre: 'María',
  apellido: 'Pérez',
  nombre_completo: 'María Pérez',
  fecha_cita: 'miércoles 22 de julio',
  hora_cita: '10:00',
  servicio: 'Limpieza facial',
  doctor: 'Dra. Salazar',
  sede: 'Sucursal Norte',
};

// Datos de ejemplo con el mismo nombrado que usan las plantillas de Meta
// (ver VARIABLE_CATALOG en pages/MessageTemplates.jsx: nombre/apellido/servicio/
// fecha/hora/doctor/sede), para previsualizar el paso "Enviar plantilla".
const TEMPLATE_SAMPLE_VARS = {
  nombre: 'María',
  apellido: 'Pérez',
  servicio: 'Limpieza facial',
  fecha: 'lunes 20 de julio',
  hora: '14:30',
  doctor: 'Dra. Salazar',
  sede: 'Sede Norte',
};

// Convierte el texto al HTML que "pinta" WhatsApp: *negrita*, _cursiva_,
// ~tachado~, saltos de línea, y las variables con su valor de ejemplo resaltado.
function waPreviewHtml(text) {
  let s = String(text || '');
  s = s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  s = s.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => {
    const v = SAMPLE_VARS[String(k).toLowerCase()];
    return `<span class="bg-amber-100 text-amber-800 rounded px-0.5" title="{{${k}}}">${v || `{{${k}}}`}</span>`;
  });
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>');
  s = s.replace(/~([^~\n]+)~/g, '<s>$1</s>');
  return s.replace(/\n/g, '<br/>');
}

/** Burbuja verde estilo WhatsApp con el adjunto (si hay) y el texto renderizado. */
function MessageBubblePreview({ body = '', mediaUrl = '', mediaType = '' }) {
  if (!String(body).trim() && !mediaUrl) return null;
  return (
    <div className="rounded-xl p-3" style={{ background: '#e5ddd5' }}>
      <p className="text-[10px] font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">Previsualización</p>
      <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none shadow-sm overflow-hidden" style={{ background: '#d9fdd3' }}>
        {mediaUrl && (
          mediaType === 'video' ? (
            <div className="h-28 bg-slate-800 flex items-center justify-center text-3xl">🎬</div>
          ) : mediaType === 'audio' ? (
            <div className="px-2.5 pt-2">
              <audio controls src={mediaUrl} className="w-full h-9" />
            </div>
          ) : (
            <img src={mediaUrl} alt="" className="w-full max-h-40 object-cover" />
          )
        )}
        {String(body).trim() && (
          <p
            className="text-[13px] text-slate-800 px-2.5 py-1.5 whitespace-pre-wrap break-words"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: waPreviewHtml(body) }}
          />
        )}
        <p className="text-[10px] text-slate-500 text-right px-2 pb-1">10:30 ✓✓</p>
      </div>
      <p className="text-[10px] text-slate-500 mt-1.5">
        Las variables se muestran con datos de ejemplo; al enviarse llevan los del paciente y su cita.
      </p>
    </div>
  );
}

// ─────────── Adjunto del nodo "Enviar mensaje" (imagen o video) ───────────
function NodeAttachment({ d, set }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const upload = (file) => {
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    if (!isImage && !isVideo && !isAudio) return toast.error('Solo imágenes, videos o audios');
    if (isImage && file.size > 6 * 1024 * 1024) return toast.error('Imagen: máximo 6MB');
    if (isVideo && file.size > 32 * 1024 * 1024) return toast.error('Video: máximo 32MB');
    if (isAudio && file.size > 15 * 1024 * 1024) return toast.error('Audio: máximo 15MB');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        setUploading(true);
        // Mismo storage autoalojado que los mensajes guardados: la URL pública
        // resultante la entienden ambos gateways (Cloud por link, QR por bytes).
        const r = await api.post('/chats/saved-replies/upload', { name: file.name, dataUrl: ev.target.result });
        set({ mediaUrl: r.data.url, mediaType: r.data.type, mediaName: file.name });
        toast.success('Adjunto subido');
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al subir adjunto');
      } finally {
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  if (d.mediaUrl) return (
    <div className="flex items-center gap-2 border border-slate-200 rounded-lg p-2 bg-slate-50">
      {d.mediaType === 'image' ? (
        <img src={d.mediaUrl} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
      ) : d.mediaType === 'audio' ? (
        <span className="w-12 h-12 rounded-lg bg-slate-200 flex items-center justify-center text-xl shrink-0">🎤</span>
      ) : (
        <span className="w-12 h-12 rounded-lg bg-slate-200 flex items-center justify-center text-xl shrink-0">🎬</span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-700 truncate">{d.mediaName || 'Adjunto'}</p>
        {d.mediaType === 'audio' ? (
          <audio controls src={d.mediaUrl} className="w-full h-8 mt-1" />
        ) : (
          <p className="text-[10px] text-slate-400">{d.mediaType === 'image' ? 'Imagen' : 'Video'} — se envía junto al mensaje</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => set({ mediaUrl: '', mediaType: '', mediaName: '' })}
        className="text-rose-500 hover:text-rose-700 bg-transparent border-none cursor-pointer p-1"
        title="Quitar adjunto"
      >
        <HiOutlineTrash className="w-4 h-4" />
      </button>
    </div>
  );
  return (
    <div>
      <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        className="w-full border border-dashed border-slate-300 rounded-lg px-2 py-2 text-xs text-slate-500 bg-white hover:border-emerald-400 hover:text-emerald-700 cursor-pointer disabled:opacity-60"
      >
        {uploading ? 'Subiendo…' : '📎 Adjuntar imagen, video o audio (opcional)'}
      </button>
    </div>
  );
}

// ─────────── Formulario de configuración por tipo de nodo ───────────
function NodeConfig({ node, onChange, onRemoveRoute, templates, agents, clinics = [], audiences = [], audiencesNotice = '' }) {
  const d = node.data || {};
  const set = (patch) => onChange(patch);
  const t = node.type;

  if (t === 'split') {
    const routes = d.routes || [];
    const byClinic = d.distribution === 'clinic';
    const total = routes.reduce((a, r) => a + (Number(r.percent) || 0), 0);
    const patchRoute = (id, patch) => set({ routes: routes.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
    const addRoute = () => {
      if (byClinic) {
        set({ routes: [...routes, { id: newRouteId(), name: 'Sucursal', clinicId: '' }] });
      } else {
        const n = routes.length + 1;
        set({ routes: [...routes, { id: newRouteId(), name: `Ruta ${String.fromCharCode(64 + n)}`, percent: 0 }] });
      }
    };
    // Al cambiar de modo NO se tocan los ids de ruta (las conexiones se conservan):
    // solo se reinterpretan (% en aleatorio, sucursal en "por sucursal").
    const changeDistribution = (dist) => {
      if (dist === 'clinic') {
        const converted = routes.map((r, i) => ({ id: r.id, name: r.name, clinicId: r.clinicId || '', isFallback: !!r.isFallback || (routes.length > 1 && i === routes.length - 1) }));
        set({ distribution: 'clinic', routes: converted });
      } else {
        set({ distribution: 'random', routes: routes.map((r) => ({ id: r.id, name: r.name, percent: Number(r.percent) || 0 })) });
      }
    };
    const hasFallback = routes.some((r) => r.isFallback);
    return (
      <div className="grid gap-3 text-sm">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Tipo de distribución</label>
          <select value={d.distribution || 'random'} onChange={(e) => changeDistribution(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="random">Reparto aleatorio (Random Split)</option>
            <option value="clinic">Por sucursal del contacto</option>
          </select>
          <p className="text-[11px] text-slate-400 mt-1">
            {byClinic
              ? 'Cada contacto sigue la ruta de SU sucursal (la que traía el Excel importado, o la sede del evento). Añade una ruta por sucursal y una ruta “Otras” para los que no coincidan.'
              : 'Reparte los contactos al azar (como tirar un dado) entre las rutas, según el % de cada una. Sirve para A/B testing.'}
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Rutas</label>
            {!byClinic && <span className={`text-[11px] font-bold ${total === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>Suma: {total}%</span>}
          </div>
          <div className="grid gap-1.5">
            {routes.map((r) => (
              <div key={r.id} className="flex items-center gap-1.5">
                {byClinic ? (
                  <select
                    value={r.isFallback ? '__fallback__' : (r.clinicId || '')}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__fallback__') patchRoute(r.id, { isFallback: true, clinicId: '', name: 'Otras sucursales' });
                      else {
                        const cl = clinics.find((c) => String(c._id) === v);
                        patchRoute(r.id, { isFallback: false, clinicId: v, name: cl?.nombreComercial || cl?.name || 'Sucursal' });
                      }
                    }}
                    className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">Elige sucursal…</option>
                    {clinics.map((c) => <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>)}
                    <option value="__fallback__">Otras sucursales / sin coincidencia</option>
                  </select>
                ) : (
                  <>
                    <input
                      value={r.name}
                      onChange={(e) => patchRoute(r.id, { name: e.target.value })}
                      placeholder="Nombre de la ruta"
                      className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
                    />
                    <NumericInput value={Number(r.percent) || 0} onChange={(e) => patchRoute(r.id, { percent: Number(e.target.value) })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                    <span className="text-slate-400 text-xs">%</span>
                  </>
                )}
                <button
                  type="button"
                  title="Quitar ruta"
                  disabled={routes.length <= 1}
                  onClick={() => onRemoveRoute?.(r.id)}
                  className="p-1 text-slate-300 hover:text-rose-600 disabled:opacity-30 disabled:hover:text-slate-300 bg-transparent border-none cursor-pointer disabled:cursor-not-allowed"
                >
                  <HiOutlineTrash className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addRoute} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-fuchsia-600 hover:text-fuchsia-700 bg-transparent border-none cursor-pointer">
            <HiOutlinePlus className="w-4 h-4" /> Añadir ruta
          </button>
          {byClinic && !hasFallback && (
            <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2">
              Sin una ruta “Otras sucursales”, los contactos cuya sucursal no coincida con ninguna ruta
              terminan el flujo sin seguir ninguna rama.
            </p>
          )}
          {!byClinic && total !== 100 && (
            <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-2">
              Lo ideal es que los porcentajes sumen 100. Si no, el reparto respeta las proporciones
              que pongas (peso relativo de cada ruta).
            </p>
          )}
          <p className="text-[11px] text-slate-400 mt-1">Conecta cada ruta a su rama con el “+” que aparece debajo del nodo.</p>
        </div>
      </div>
    );
  }

  if (t === 'send_message') return (
    <div className="grid gap-2">
      <WhatsappTextArea value={d.body || ''} onChange={(body) => set({ body })} rows={6} placeholder="Mensaje (usa el menú de variables)" variables={MESSAGE_VARIABLES} />
      <NodeAttachment d={d} set={set} />
      <MessageBubblePreview body={d.body} mediaUrl={d.mediaUrl} mediaType={d.mediaType} />
      <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
        WhatsApp solo permite texto libre (y adjuntos) si el paciente te escribió en las últimas 24h.
        Fuera de esa ventana usa el paso <b>Enviar plantilla</b> (plantilla aprobada por Meta).
      </p>
    </div>
  );
  if (t === 'send_media') return (
    <div className="grid gap-2">
      <p className="text-xs text-slate-500">Envía SOLO una imagen, video o audio, sin texto.</p>
      <NodeAttachment d={d} set={set} />
      <MessageBubblePreview mediaUrl={d.mediaUrl} mediaType={d.mediaType} />
      <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
        Igual que el texto libre, WhatsApp solo lo entrega si el paciente te escribió en las
        últimas 24h; fuera de esa ventana usa <b>Enviar plantilla</b> con cabecera multimedia.
      </p>
    </div>
  );
  if (t === 'send_template') {
    const selectedTemplate = templates.find((tp) => tp.name === d.templateName);
    return (
      <div className="grid gap-2">
        <select value={d.templateName || ''} onChange={(e) => set({ templateName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Selecciona plantilla…</option>
          {templates.map((tp) => <option key={tp._id} value={tp.name}>{tp.name}</option>)}
        </select>
        {selectedTemplate ? (
          <>
            <TemplateWhatsappPreview template={selectedTemplate} sampleVars={TEMPLATE_SAMPLE_VARS} />
            <p className="text-[11px] text-slate-400">
              Así se ve aproximadamente en WhatsApp, con datos de ejemplo en las variables (al
              enviarse se usan los datos reales del paciente/cita).
            </p>
          </>
        ) : (
          <p className="text-[11px] text-slate-400">Elige una plantilla para ver cómo se verá.</p>
        )}
      </div>
    );
  }
  if (t === 'send_email') return (
    <div className="grid gap-2">
      <input value={d.emailSubject || ''} onChange={(e) => set({ emailSubject: e.target.value })} placeholder="Asunto" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      <WhatsappTextArea value={d.body || ''} onChange={(body) => set({ body })} rows={5} placeholder="Cuerpo (usa el menú de variables)" variables={MESSAGE_VARIABLES} />
      <p className="text-[11px] text-slate-400">Se envía al email del paciente. Incluye enlace de baja automático.</p>
    </div>
  );
  if (t === 'wait') {
    const { unit, value } = waitParts(d);
    // Guarda waitMinutes (lo que ejecuta el motor, fraccionario para segundos) y
    // recuerda unit/value para reabrir con la misma unidad.
    const apply = (v, u) => set({ waitValue: v, waitUnit: u, waitMinutes: Number(v || 0) * (WAIT_UNIT_MIN[u] || 1) });
    return (
      <div className="grid gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span>Esperar</span>
          <NumericInput value={value} onChange={(e) => apply(Number(e.target.value), unit)} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          <select value={unit} onChange={(e) => apply(value, e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            {WAIT_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </select>
        </div>
        <p className="text-[11px] text-slate-400">
          El flujo se pausa este tiempo y sigue con el paso siguiente. Las esperas de menos de un
          minuto (segundos) son aproximadas: se retoman en la siguiente pasada del motor (~20 s).
        </p>
      </div>
    );
  }
  if (t === 'wait_until') return (
    <div className="grid gap-2 text-sm">
      <select
        value={d.waitMode === 'clock' ? 'clock' : 'offset'}
        onChange={(e) => set({ waitMode: e.target.value })}
        className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
      >
        <option value="clock">A una hora fija del día (ej. 18:00 del día anterior)</option>
        <option value="offset">Horas antes/después de la hora de la cita</option>
      </select>
      {d.waitMode === 'clock' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={String(d.daysBefore ?? 1)}
            onChange={(e) => set({ daysBefore: Number(e.target.value) })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="0">El mismo día de la cita</option>
            <option value="1">1 día antes</option>
            <option value="2">2 días antes</option>
            <option value="3">3 días antes</option>
            <option value="7">7 días antes</option>
          </select>
          <span>a las</span>
          <input
            type="time"
            value={d.atTime || '18:00'}
            onChange={(e) => set({ atTime: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span>Esperar</span>
          <NumericInput value={Math.abs((d.offsetMinutes || 0) / 60)} onChange={(e) => set({ offsetMinutes: (d.offsetMinutes < 0 ? -1 : 1) * Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          <span>h</span>
          <select value={(d.offsetMinutes || 0) < 0 ? 'before' : 'after'} onChange={(e) => set({ offsetMinutes: (e.target.value === 'before' ? -1 : 1) * Math.abs(d.offsetMinutes || 0) })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="before">antes de la cita</option>
            <option value="after">después de la cita</option>
          </select>
        </div>
      )}
      <p className="text-[11px] text-slate-400">
        {d.waitMode === 'clock'
          ? 'Ej.: cita para mañana + "1 día antes a las 18:00" → el mensaje sale HOY a las 18:00, sin importar la hora de la cita. Si al agendar esa hora ya pasó, el paso continúa de inmediato.'
          : 'Relativo a la hora exacta de la cita (p. ej. 24 h antes).'}
      </p>
    </div>
  );
  if (t === 'wait_reply') return (
    <div className="flex items-center gap-2 text-sm">
      <span>Esperar respuesta</span>
      <NumericInput value={Math.round((d.timeoutMinutes || 720) / 60)} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
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
      {d.op !== 'exists' && d.field === 'clinic' && (
        <select value={d.value || ''} onChange={(e) => set({ value: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Selecciona sucursal…</option>
          {clinics.map((c) => <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>)}
        </select>
      )}
      {d.op !== 'exists' && d.field === 'stage' && (
        <select value={d.value || ''} onChange={(e) => set({ value: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="">Selecciona etapa…</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
        </select>
      )}
      {d.op !== 'exists' && !['hasPatient', 'lastReply', 'clinic', 'stage'].includes(d.field) && (
        <input value={d.value || ''} onChange={(e) => set({ value: e.target.value })} placeholder="valor" className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
      )}
      <p className="text-[11px] text-slate-400">
        La salida <b className="text-emerald-600">Sí</b> (punto verde, izquierda) se sigue cuando la condición se
        cumple; la salida <b className="text-rose-600">No</b> (punto rojo, derecha) cuando no. Usa los botones “+”
        bajo cada salida, o arrastra desde el punto hasta un nodo existente para conectarlo.
      </p>
    </div>
  );
  if (t === 'add_tag' || t === 'remove_tag') return (
    <input value={d.tag || ''} onChange={(e) => set({ tag: e.target.value })} placeholder="etiqueta" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
  );
  if (t === 'move_stage') return (
    <div className="grid gap-2">
      <select value={d.stage || 'contactado'} onChange={(e) => set({ stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
      </select>
      <p className="text-[11px] text-slate-400">
        Mueve la oportunidad del chat a esta etapa del embudo. Si el chat <b>aún no tiene
        oportunidad</b>, se crea una en esta etapa (visible en el chat y en el Kanban de Oportunidades).
      </p>
    </div>
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
        <NumericInput value={Math.round((d.taskDueOffsetMinutes || 0) / 60)} onChange={(e) => set({ taskDueOffsetMinutes: Number(e.target.value) * 60 })} className="w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
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
      <WhatsappTextArea value={d.body || ''} onChange={(body) => set({ body })} rows={4} placeholder="Mensaje de invitación a calificar" variables={MESSAGE_VARIABLES} />
      <p className="text-[11px] text-slate-400">Se adjunta un enlace de calificación 1-5.</p>
    </div>
  );
  if (t === 'ai_reply') return (
    <p className="text-xs text-slate-500">La IA redacta y envía una respuesta usando el contexto de la conversación.</p>
  );
  if (t === 'meta_capi') {
    const META_EVENTS = ['Lead', 'Schedule', 'Contact', 'CompleteRegistration', 'SubmitApplication', 'Purchase'];
    return (
      <div className="grid gap-2 text-sm">
        <label className="grid gap-1">
          <span className="text-slate-600">Evento de conversión</span>
          <select value={d.metaEventName || 'Lead'} onChange={(e) => set({ metaEventName: e.target.value })} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            {META_EVENTS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-slate-600">Valor (opcional — para Purchase / ROAS)</span>
          <div className="flex items-center gap-2">
            <NumericInput value={d.metaValue || 0} onChange={(e) => set({ metaValue: Number(e.target.value) })} className="w-28 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
            <input value={d.metaCurrency || 'USD'} onChange={(e) => set({ metaCurrency: e.target.value.toUpperCase().slice(0, 3) })} className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          </div>
        </label>
        <p className="text-[11px] text-slate-400">
          Reporta el evento a Meta con el teléfono/email del paciente (hasheado en SHA-256) para que
          el algoritmo optimice tus anuncios por resultados reales. Requiere la <b>Conversions API</b>
          activada en Ajustes → WhatsApp (Meta).
        </p>
      </div>
    );
  }
  if (t === 'fb_audience_add' || t === 'fb_audience_remove') {
    const hasList = audiences.length > 0;
    // Conserva el público guardado aunque no venga en la lista (otra cuenta, etc.).
    const options = hasList && d.audienceId && !audiences.some((a) => a.id === d.audienceId)
      ? [{ id: d.audienceId, name: d.audienceName || d.audienceId, count: null }, ...audiences]
      : audiences;
    return (
      <div className="grid gap-2 text-sm">
        {hasList ? (
          <label className="grid gap-1">
            <span className="text-slate-600">Público personalizado</span>
            <select
              value={d.audienceId || ''}
              onChange={(e) => {
                const a = options.find((x) => x.id === e.target.value);
                set({ audienceId: e.target.value, audienceName: a?.name || '' });
              }}
              className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">Selecciona un público…</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{typeof a.count === 'number' ? ` (${a.count.toLocaleString()})` : ''}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-400">Se leen directamente de tu cuenta de Meta (Marketing API).</span>
          </label>
        ) : (
          <>
            {audiencesNotice && (
              <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{audiencesNotice}</p>
            )}
            <label className="grid gap-1">
              <span className="text-slate-600">ID del público personalizado (manual)</span>
              <input value={d.audienceId || ''} onChange={(e) => set({ audienceId: e.target.value.trim() })} placeholder="23848XXXXXXXXXXX" className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm font-mono" />
            </label>
          </>
        )}
        <p className="text-[11px] text-slate-400">
          {t === 'fb_audience_add'
            ? 'Añade al contacto a este Público Personalizado de Facebook (para retargeting).'
            : 'Quita al contacto de este Público Personalizado (p. ej. cuando ya compró, para dejar de gastar en anuncios con él).'}
        </p>
      </div>
    );
  }
  return <p className="text-xs text-slate-400">Sin configuración.</p>;
}
