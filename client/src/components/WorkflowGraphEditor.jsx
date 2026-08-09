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
  SelectionMode,
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
  HiOutlineSun,
  HiOutlineRectangleGroup,
  HiOutlineSquares2X2,
} from 'react-icons/hi2';
import WorkflowWindowPicker from './WorkflowWindowPicker';
import { describeWindow } from '../utils/windowSchedule';

// Tipos de paso disponibles en el lienzo (sin 'trigger', que es el nodo inicial).
export const STEP_DEFS = {
  send_message: 'Enviar mensaje',
  send_media: 'Enviar imagen / video / audio',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Esperar (tiempo)',
  wait_until: 'Esperar hasta la cita / hora fija',
  wait_reply: 'Esperar respuesta',
  window: 'Ventana horaria',
  condition: 'Condición (sí/no)',
  split: 'Dividir (bifurcación)',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  create_opportunity: 'Crear oportunidad',
  move_stage: 'Etapa de oportunidad (antiguo)',
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

const AGENT_DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function agentScheduleLabel(agent) {
  const schedule = agent?.callCenterSchedule;
  if (!schedule?.enabled) return 'Disponible 24/7';
  const days = (schedule.days || []).filter((day) => day.enabled);
  if (!days.length) return 'Sin días laborables';
  const names = days.map((day) => AGENT_DAY_NAMES[day.day]).filter(Boolean).join(', ');
  const ranges = [...new Set(days.map((day) => `${day.start}–${day.end}`))];
  return `${names} · ${ranges.join(', ')}`;
}

// Agrupación de pasos para el selector (estilo GoHighLevel).
const STEP_GROUPS = [
  { title: 'Comunicación', icon: HiOutlineChatBubbleLeftRight, types: ['send_message', 'send_media', 'send_template', 'send_email', 'ai_reply', 'request_review'] },
  { title: 'Esperas', icon: HiOutlineClock, types: ['wait', 'wait_until', 'wait_reply', 'window'] },
  { title: 'Lógica', icon: HiOutlineArrowsRightLeft, types: ['condition', 'split', 'goal'] },
  // 'move_stage' ya no se ofrece: lo cubre 'create_opportunity' (que además crea
  // la oportunidad con nombre, servicios, valor…). Los flujos que ya lo usan
  // siguen funcionando y se pueden seguir editando desde su nodo.
  { title: 'Contacto / CRM', icon: HiOutlineTag, types: ['add_tag', 'remove_tag', 'create_opportunity', 'assign_agent', 'set_appointment_status'] },
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
  window: { icon: HiOutlineSun, cls: 'bg-indigo-100 text-indigo-600' },
  condition: { icon: HiOutlineArrowsRightLeft, cls: 'bg-amber-100 text-amber-600' },
  split: { icon: HiOutlineShare, cls: 'bg-fuchsia-100 text-fuchsia-600' },
  goal: { icon: HiOutlineFlag, cls: 'bg-rose-100 text-rose-600' },
  add_tag: { icon: HiOutlineTag, cls: 'bg-teal-100 text-teal-600' },
  remove_tag: { icon: HiOutlineTag, cls: 'bg-slate-100 text-slate-500' },
  move_stage: { icon: HiOutlineFunnel, cls: 'bg-cyan-100 text-cyan-600' },
  create_opportunity: { icon: HiOutlineFunnel, cls: 'bg-cyan-100 text-cyan-600' },
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
  { value: 'stage', label: 'Etapa de la oportunidad' },
  { value: 'opportunityName', label: 'Nombre de la oportunidad' },
  { value: 'opportunityTag', label: 'Etiqueta de la oportunidad' },
  { value: 'opportunityValue', label: 'Valor esperado de la oportunidad' },
  { value: 'tag', label: 'Etiqueta del paciente' },
  { value: 'chatTag', label: 'Etiqueta del chat' },
  { value: 'source', label: 'Fuente del paciente' },
  { value: 'lastReply', label: 'Última respuesta del paciente' },
  { value: 'hasPatient', label: 'Tiene paciente vinculado' },
  { value: 'clinic', label: 'Sucursal de la cita / evento' },
];
const FIELD_LABELS = Object.fromEntries(FIELDS.map((f) => [f.value, f.label]));
const OP_LABELS = {
  eq: 'es igual a',
  neq: 'es distinto de',
  contains: 'contiene',
  exists: 'existe',
  in: 'es alguno de',
  nin: 'no es ninguno de',
  gt: 'es mayor que',
  lt: 'es menor que',
};
// Campos que guardan una LISTA (etiquetas) y campos NUMÉRICOS: cambian los
// operadores disponibles y el editor del valor.
const LIST_FIELDS = ['tag', 'chatTag', 'opportunityTag'];
const NUMBER_FIELDS = ['opportunityValue'];

const opsFor = (field) => {
  if (field === 'hasPatient') {
    return [{ value: 'eq', label: 'sí, tiene paciente' }, { value: 'neq', label: 'no tiene paciente' }];
  }
  const keys = NUMBER_FIELDS.includes(field)
    ? ['eq', 'neq', 'gt', 'lt', 'exists']
    : LIST_FIELDS.includes(field)
      ? ['eq', 'neq', 'in', 'nin', 'exists']
      : ['eq', 'neq', 'in', 'nin', 'contains', 'exists'];
  return keys.map((k) => ({ value: k, label: OP_LABELS[k] }));
};
const REPLY_VALUES = [
  { value: 'yes', label: 'Sí (confirmó)' },
  { value: 'no', label: 'No (canceló)' },
  { value: 'other', label: 'Otra' },
];
// Patient.source es un enum cerrado: se elige, no se escribe.
const SOURCES = [
  { value: 'anuncio', label: 'Anuncio' },
  { value: 'referido', label: 'Referido' },
  { value: 'recepcion', label: 'Recepción' },
  { value: 'organico', label: 'Orgánico' },
];
// De qué lista de etiquetas EN USO se alimenta cada campo (GET /workflows/tags).
const TAG_FIELD_SOURCE = { tag: 'patient', chatTag: 'chat', opportunityTag: 'opportunity' };

// ─────────── Condiciones (varias por rama, varias ramas por nodo) ───────────
const newCondId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const newBranchId = () => `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
// Condición nueva: por defecto sobre la ETAPA de la oportunidad (el caso más
// habitual en el embudo); el usuario cambia el campo si necesita otro.
const newCondition = () => ({ id: newCondId(), field: 'stage', op: 'eq', value: '', values: [] });

// Condiciones de un grupo/rama. Acepta el formato legacy (una sola condición
// guardada como field/op/value en el propio nodo).
function conditionsOfData(g = {}) {
  const list = Array.isArray(g.conditions) ? g.conditions.filter((c) => c && c.field) : [];
  if (list.length) {
    return list.map((c, i) => ({
      id: c.id || `c${i}`,
      field: c.field,
      op: c.op || 'eq',
      value: c.value || '',
      values: Array.isArray(c.values) ? c.values : [],
    }));
  }
  return [{ id: 'c0', field: g.field || 'tag', op: g.op || 'eq', value: g.value || '', values: Array.isArray(g.values) ? g.values : [] }];
}

// Ramas de un nodo Condición. La primera conserva el handle 'yes' (y la salida
// "si no" el handle 'no') para no romper las conexiones ya dibujadas.
function branchesOfData(d = {}) {
  const arr = Array.isArray(d.branches) ? d.branches.filter((b) => b && b.id) : [];
  if (arr.length) {
    return arr.map((b, i) => ({
      id: b.id,
      name: b.name || (i === 0 ? 'Sí' : `Rama ${i + 1}`),
      match: b.match || 'all',
      conditions: conditionsOfData(b),
    }));
  }
  return [{ id: 'yes', name: 'Sí', match: d.match || 'all', conditions: conditionsOfData(d) }];
}

// Salidas de un nodo Condición en orden: una por rama + la de "si no".
const conditionHandles = (d = {}) => [...branchesOfData(d).map((b) => b.id), 'no'];

// Texto corto de una condición para la tarjeta del nodo.
function describeCondition(c = {}, { clinics = [] } = {}) {
  const field = FIELD_LABELS[c.field] || c.field || '—';
  if (c.field === 'hasPatient') return c.op === 'neq' ? 'sin paciente vinculado' : 'con paciente vinculado';
  const op = OP_LABELS[c.op] || c.op || '';
  if (c.op === 'exists') return `${field} ${op}`;
  const one = (v) => {
    if (c.field === 'clinic') {
      const cl = clinics.find((x) => String(x._id) === String(v));
      return cl?.nombreComercial || cl?.name || v;
    }
    if (c.field === 'stage') return STAGE_LABELS[v] || v;
    if (c.field === 'lastReply') return REPLY_VALUES.find((r) => r.value === v)?.label || v;
    if (c.field === 'source') return SOURCES.find((s) => s.value === v)?.label || v;
    return v;
  };
  const vals = (c.values?.length ? c.values : String(c.value || '').split(',').map((v) => v.trim()).filter(Boolean)).map(one);
  return `${field} ${op} ${vals.join(' / ') || '—'}`;
}

function describeBranch(b = {}, ctx) {
  const txt = b.conditions.map((c) => describeCondition(c, ctx)).join(b.match === 'any' ? ' O ' : ' Y ');
  return txt || 'sin condiciones';
}

export const newNodeData = (type) => ({
  body: '', templateName: '', templateLanguage: 'es', emailSubject: '',
  waitMinutes: 60, waitValue: 60, waitUnit: 'minutes', waitEvent: 'appointment_date', offsetMinutes: -1440, timeoutMinutes: 720,
  waitMode: 'clock', daysBefore: 1, atTime: '18:00',
  // Ventana horaria: por defecto laborable de lunes a viernes, 09:00–18:00.
  windowDays: [1, 2, 3, 4, 5], windowFrom: '09:00', windowTo: '18:00',
  appointmentStatus: 'confirmada', field: 'tag', op: 'eq', value: '', tag: '', stage: 'contactado',
  // Crear oportunidad: nombre con variables, servicios del inventario, valor
  // automático (suma de esos servicios) o manual, etiquetas y notas.
  opportunityName: '', opportunityProducts: [], opportunityValueMode: 'auto', opportunityValue: 0,
  opportunityTags: [], opportunityNotes: '', ifExists: 'update',
  assignMode: 'roundrobin', assignUser: null, taskTitle: '', taskDueOffsetMinutes: 1440,
  webhookUrl: '', webhookMethod: 'POST',
  metaEventName: 'Lead', metaValue: 0, metaCurrency: 'USD', audienceId: '', audienceName: '',
  // Dividir (split): dos rutas 50/50 por defecto (A/B). Cada ruta es una salida
  // con su propio handle = route.id; el motor reparte por % (Random Split).
  ...(type === 'split'
    ? { distribution: 'random', routes: [{ id: 'ra', name: 'Ruta A', percent: 50 }, { id: 'rb', name: 'Ruta B', percent: 50 }] }
    : {}),
  // Condición: una rama ('yes') con UNA condición. Se pueden añadir más
  // condiciones (Y / O) y más ramas (cada una con su propia salida).
  ...(type === 'condition'
    ? { branches: [{ id: 'yes', name: 'Sí', match: 'all', conditions: [newCondition()] }] }
    : {}),
  // Objetivo: una sola lista de condiciones (no ramifica: si se cumple, termina).
  ...(type === 'goal' ? { match: 'all', conditions: [newCondition()] } : {}),
});

// Genera un id de ruta único y estable dentro de un split (handle de la salida).
const newRouteId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// Id de nodo único. `n${Date.now()}` a secas colisiona al crear VARIOS nodos de
// golpe (pegar o duplicar una rama entera ocurre dentro del mismo milisegundo):
// dos nodos con el mismo id rompen el grafo. El contador lo evita.
let nodeIdSeq = 0;
const newNodeId = () => `n${Date.now().toString(36)}${(nodeIdSeq++).toString(36)}`;

// ─────────── Portapapeles de pasos (varios nodos + sus conexiones) ───────────
// Se guarda también en localStorage para poder copiar una rama —o el flujo
// entero— en UNA automatización y pegarla en OTRA.
const CLIPBOARD_KEY = 'wf.clipboard';

function readStoredClipboard() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    const cb = raw ? JSON.parse(raw) : null;
    return cb && Array.isArray(cb.nodes) && cb.nodes.length ? cb : null;
  } catch {
    return null; // localStorage lleno/bloqueado: sin portapapeles persistente
  }
}

function writeStoredClipboard(cb) {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(cb));
  } catch {
    /* el portapapeles en memoria sigue funcionando */
  }
}

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
  // Orden REAL de las salidas de los nodos con varias ramas (Condición) o rutas
  // (Dividir): así las ramas se dibujan de izquierda a derecha como en la tarjeta.
  const rank = {};
  nodes.forEach((n) => {
    if (n.type === 'split') (n.data?.routes || []).forEach((r, i) => { rank[`${n.id}:${r.id}`] = i; });
    if (n.type === 'condition') conditionHandles(n.data).forEach((h, i) => { rank[`${n.id}:${h}`] = i; });
  });
  const rankOf = (e) => rank[`${e.source}:${e.sourceHandle}`] ?? order[e.sourceHandle] ?? 2;
  Object.values(childrenOf).forEach((arr) => arr.sort((a, b) => rankOf(a) - rankOf(b)));

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

function summarize(n, ctx = {}) {
  const d = n.data || {};
  switch (n.type) {
    case 'send_message': return `${d.mediaUrl ? '📎 ' : ''}${d.body || ''}`;
    case 'send_media': return d.mediaUrl ? `📎 ${d.mediaName || (d.mediaType === 'video' ? 'Video' : d.mediaType === 'audio' ? 'Audio' : 'Imagen')}` : 'Sin archivo';
    case 'send_template': return d.templateName;
    case 'send_email': return d.emailSubject || d.body;
    case 'wait': return formatWaitSummary(d);
    case 'window': return describeWindow({ days: d.windowDays, from: d.windowFrom, to: d.windowTo });
    case 'wait_until': return d.waitMode === 'clock'
      ? `${d.daysBefore === 0 ? 'el día de la cita' : d.daysBefore === 1 ? '1 día antes' : `${d.daysBefore} días antes`} a las ${d.atTime || '—'}`
      : `${Math.abs((d.offsetMinutes || 0) / 60)}h ${(d.offsetMinutes || 0) < 0 ? 'antes' : 'después'}`;
    case 'add_tag': case 'remove_tag': return d.tag;
    case 'move_stage': return STAGE_LABELS[d.stage] || d.stage;
    case 'create_opportunity': {
      const nombre = (d.opportunityName || '').trim();
      const etapa = STAGE_LABELS[d.stage] || d.stage || 'nuevo';
      const valor = d.opportunityValueMode === 'manual'
        ? `$${Number(d.opportunityValue) || 0}`
        : (d.opportunityProducts || []).length ? 'valor por servicios' : '';
      return [nombre || 'Sin nombre', etapa, valor].filter(Boolean).join(' · ');
    }
    case 'goal': return describeBranch(branchesOfData(d)[0], ctx);
    case 'condition': {
      const bs = branchesOfData(d);
      return bs.length > 1
        ? bs.map((b) => `${b.name}: ${describeBranch(b, ctx)}`).join(' · ')
        : describeBranch(bs[0], ctx);
    }
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

// Botón "pegar aquí" (estilo Daplox): aparece junto al "+" cuando hay algo
// copiado. Un clic pega lo copiado (un paso o una rama entera) en ese punto.
function PasteButton({ onClick, count = 1 }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="nodrag nopan relative flex items-center justify-center w-6 h-6 rounded-full bg-white border-2 border-violet-400 text-violet-600 shadow-sm hover:bg-violet-500 hover:text-white hover:border-violet-500 cursor-pointer transition-colors"
      title={count > 1 ? `Pegar aquí los ${count} pasos copiados` : 'Pegar el paso copiado aquí'}
    >
      <HiOutlineClipboard className="w-3.5 h-3.5" />
      {count > 1 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-violet-600 text-white text-[9px] font-bold leading-[14px] text-center">
          {count}
        </span>
      )}
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
      {data._clipboardCount > 0 && <PasteButton count={data._clipboardCount} onClick={() => data.onPasteAppend(handle)} />}
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
      <button type="button" title="Copiar esta rama (este paso y todo lo que sigue)" onClick={(e) => { e.stopPropagation(); data.onCopyBranch(); }} className="p-1 text-slate-400 hover:text-violet-600 bg-transparent border-none cursor-pointer">
        <HiOutlineRectangleGroup className="w-3.5 h-3.5" />
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

// Nodo Condición / Objetivo. La Condición puede tener VARIAS ramas (if /
// else-if): una salida por rama, evaluadas en orden, más la salida "SI NO" para
// cuando ninguna se cumple. El Objetivo mantiene sus dos salidas SÍ / NO.
function BranchNode({ data, selected }) {
  const isCond = data._type === 'condition';
  const outs = isCond
    ? [
      ...(data._branches || []).map((b) => ({ id: b.id, label: (b.name || 'Sí').toUpperCase(), color: '#10b981', cls: 'text-emerald-600' })),
      { id: 'no', label: 'SI NO', color: '#f43f5e', cls: 'text-rose-600' },
    ]
    : [
      { id: 'yes', label: 'SÍ', color: '#10b981', cls: 'text-emerald-600' },
      { id: 'no', label: 'NO', color: '#f43f5e', cls: 'text-rose-600' },
    ];
  const n = outs.length;
  const used = new Set(data._usedHandles || []);
  return (
    <div className="relative group">
      <NodeActions data={data} />
      <div
        style={{ minWidth: Math.max(210, n * 86) }}
        className={`rounded-xl border bg-amber-50 px-3 py-2.5 text-xs shadow-sm ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-300'}`}
      >
        <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
        <div className="flex items-center gap-2">
          <StepIcon type={data._type} />
          <div className="min-w-0">
            <div className="font-semibold text-amber-700">{STEP_DEFS[data._type] || data._type}</div>
            {data._summary && <div className="text-[10px] text-amber-600/80 mt-0.5 truncate max-w-[165px]" title={data._summary}>{data._summary}</div>}
          </div>
        </div>
        <div className="flex mt-1.5">
          {outs.map((o) => (
            <div key={o.id} className={`flex-1 min-w-0 text-center text-[9px] font-bold truncate px-0.5 ${o.cls}`} title={o.label}>{o.label}</div>
          ))}
        </div>
        {outs.map((o, i) => (
          <Handle
            key={o.id}
            id={o.id}
            type="source"
            position={Position.Bottom}
            style={{ left: `${((i + 0.5) / n) * 100}%`, background: o.color }}
          />
        ))}
      </div>
      {outs.map((o, i) => (
        !used.has(o.id) && <AddRow key={o.id} data={data} handle={o.id} left={`${((i + 0.5) / n) * 100}%`} />
      ))}
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
          {label && <span className={`text-[9px] font-bold px-1 rounded max-w-[90px] truncate ${data.labelCls || (label === 'Sí' ? 'text-emerald-600' : 'text-rose-600')}`} title={label}>{label}</span>}
          <AddButton onClick={() => data.onInsert(id)} />
          {data.clipboardCount > 0 && <PasteButton count={data.clipboardCount} onClick={() => data.onPasteInsert(id)} />}
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

function toFlowNode(n, ctx = {}) {
  const rfType = n.type === 'trigger' ? 'trigger' : isSplit(n.type) ? 'split' : isBranch(n.type) ? 'branch' : 'action';
  return {
    id: n.id,
    type: rfType,
    position: n.position || { x: 0, y: 0 },
    data: {
      ...n.data,
      _type: n.type,
      _summary: summarize(n, ctx),
      // Ramas ya normalizadas (nodo Condición): una salida por rama + "si no".
      _branches: n.type === 'condition' ? branchesOfData(n.data).map((b) => ({ id: b.id, name: b.name })) : undefined,
    },
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
  metaAds = [], metaAdsNotice = '',
  // Etiquetas en uso { patient, chat, opportunity } para los desplegables del nodo Condición.
  tagOptions = {},
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTrigger, setSelectedTrigger] = useState(null); // { nodeId, idx }
  const [adding, setAdding] = useState(null); // { mode:'append', sourceId, sourceHandle } | { mode:'insert', edgeId }
  // Portapapeles: uno o VARIOS pasos con las conexiones que haya entre ellos
  // ({ nodes:[{id,type,data,position}], edges:[...] }). Se pega desde cualquier
  // "+" del diagrama o con Ctrl+V. El estado solo sirve para pintar el botón de
  // pegar; el CONTENIDO se lee del ref para que nunca se pegue una copia
  // obsoleta (los memos no dependen del contenido, solo de cuántos pasos hay).
  // Se rellena desde localStorage al montar: así se puede copiar una rama en una
  // automatización y pegarla en otra.
  const [clipboard, setClipboard] = useState(() => readStoredClipboard());
  const clipboardRef = useRef(null);
  if (clipboardRef.current === null && clipboard) clipboardRef.current = clipboard;
  // Selección múltiple del lienzo (Ctrl/⌘+clic, o Shift+arrastre para encuadrar).
  const [selectedIds, setSelectedIds] = useState([]);
  // Nodos a dejar seleccionados en cuanto el modelo vuelva de `onChange` (lo que
  // se acaba de pegar/duplicar), para que el usuario lo vea y pueda moverlo junto.
  const pendingSelectRef = useRef(null);
  // Posición del nodo al empezar a arrastrar, para no reordenar por un roce mínimo.
  const dragStartRef = useRef(null);

  // Asegura que siempre exista al menos un nodo disparador (un flujo).
  const modelNodes = useMemo(() => {
    if (nodes.some((n) => n.type === 'trigger')) return nodes;
    return [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [defaultTrigger()] } }, ...nodes];
  }, [nodes]);

  const triggerNodeCount = useMemo(() => modelNodes.filter((n) => n.type === 'trigger').length, [modelNodes]);
  const clipboardCount = clipboard?.nodes?.length || 0;

  // Conjunto de handles ocupados por nodo, para saber qué salidas están libres.
  const outHandles = useMemo(() => {
    const m = {};
    edges.forEach((e) => { (m[e.source] ||= new Set()).add(e.sourceHandle || 'default'); });
    return m;
  }, [edges]);

  const flowNodes = useMemo(
    () => modelNodes.map((n) => {
      const fn = toFlowNode(n, { clinics });
      const used = outHandles[n.id] || new Set();
      const isTrig = n.type === 'trigger';
      return {
        ...fn,
        data: {
          ...fn.data,
          _triggers: isTrig ? (n.data?.triggers || []).map((t) => ({ label: TRIGGERS.find((x) => x.value === t.type)?.label || 'Disparador' })) : undefined,
          _flowCount: isTrig ? triggerNodeCount : undefined,
          _hasDefaultOut: used.has('default'),
          _usedHandles: [...used], // Dividir / Condición: qué salidas ya están conectadas

          onAppend: (handle) => setAdding({ mode: 'append', sourceId: n.id, sourceHandle: handle }),
          onSelectTrigger: (i) => { setSelectedTrigger({ nodeId: n.id, idx: i }); setSelectedId(null); },
          onAddTrigger: () => addTriggerToNode(n.id),
          onRemoveTrigger: (i) => removeTrigger(n.id, i),
          onDeleteFlow: () => deleteFlow(n.id),
          // Acciones rápidas del paso (barra al pasar el cursor). No en el disparador.
          onCopy: isTrig ? undefined : () => copyNodes([n.id]),
          onCopyBranch: isTrig ? undefined : () => copyBranch(n.id),
          onDuplicate: isTrig ? undefined : () => duplicateNode(n.id),
          onDelete: isTrig ? undefined : () => deleteNode(n.id),
          // Pegar lo copiado directo bajo este nodo (icono junto al "+").
          _clipboardCount: clipboardCount,
          onPasteAppend: (handle) => pasteAt({ mode: 'append', sourceId: n.id, sourceHandle: handle }),
        },
      };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelNodes, outHandles, triggerNodeCount, clipboardCount, clinics]
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
      // Tras pegar/duplicar: deja seleccionado SOLO lo recién creado.
      const pick = pendingSelectRef.current;
      pendingSelectRef.current = null;
      return flowNodes.map((fn) => {
        const old = prevById.get(fn.id);
        const merged = old ? { ...old, type: fn.type, position: fn.position, data: fn.data } : fn;
        return pick ? { ...merged, selected: pick.has(fn.id) } : merged;
      });
    });
  }, [flowNodes, setRfNodes]);

  // Selección del lienzo (Ctrl/⌘+clic o Shift+arrastre). Los disparadores no se
  // copian ni se borran en bloque: se filtran aquí.
  const onSelectionChange = useCallback(({ nodes: sel }) => {
    setSelectedIds((sel || []).filter((n) => n.type !== 'trigger').map((n) => n.id));
  }, []);

  const onNodeDragStart = useCallback((_evt, node) => {
    dragStartRef.current = { id: node.id, ...node.position };
  }, []);

  // Guarda en el modelo las posiciones que react-flow tiene ahora mismo (también
  // las de TODOS los nodos movidos a la vez en una selección múltiple).
  const persistPositions = useCallback(() => {
    const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
    const next = modelNodes.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id) } : n));
    onChange?.({ nodes: next, edges });
  }, [rfNodes, modelNodes, edges, onChange]);

  // Al soltar: si el paso se dejó ENCIMA de una conexión, se REORDENA (se inserta
  // ahí y se re-cablea). Si se soltó en vacío, solo se guarda su nueva posición.
  const onNodeDragStop = useCallback((_evt, node) => {
    // Con varios pasos seleccionados se están MOVIENDO todos: reordenar por la
    // línea más cercana no tiene sentido (movería solo uno y rompería el bloque).
    if (selectedIds.length > 1) { dragStartRef.current = null; persistPositions(); return; }
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
  }, [rfNodes, modelNodes, edges, onChange, selectedIds, persistPositions]);

  const deleteEdge = useCallback((edgeId) => {
    onChange?.({ nodes: modelNodes, edges: edges.filter((e) => e.id !== edgeId) });
  }, [modelNodes, edges, onChange]);

  // Nombre de la salida por (nodo, handle) para etiquetar sus aristas: rutas del
  // nodo Dividir y ramas del nodo Condición (incluida la salida "si no").
  const splitRouteName = useMemo(() => {
    const m = {};
    modelNodes.forEach((n) => {
      if (n.type === 'split') (n.data?.routes || []).forEach((r) => { m[`${n.id}:${r.id}`] = r.name; });
      if (n.type === 'condition') {
        const bs = branchesOfData(n.data);
        bs.forEach((b) => { m[`${n.id}:${b.id}`] = b.name; });
        m[`${n.id}:no`] = bs.length > 1 ? 'Si no' : 'No';
      }
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
        clipboardCount,
        onPasteInsert: (edgeId) => pasteAt({ mode: 'insert', edgeId }),
        // La salida "no" (si no) se pinta en rojo; el resto de ramas en verde.
        labelCls: e.sourceHandle === 'no' ? 'text-rose-600' : 'text-emerald-600',
      },
      label:
        splitRouteName[`${e.source}:${e.sourceHandle}`]
        || (e.sourceHandle === 'yes' ? 'Sí' : e.sourceHandle === 'no' ? 'No' : undefined),
    })),
    // `modelNodes` va en las dependencias aunque no se use aquí directamente:
    // onInsert/onPasteInsert acaban llamando a insertStep, que reconstruye el
    // grafo a partir de los nodos de ESTE render. Sin esta dependencia, insertar
    // un paso sobre una línea después de editar otro nodo revertía esa edición.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, modelNodes, deleteEdge, clipboardCount, splitRouteName]
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

  // Inserta un nodo NUEVO en un contexto dado ({mode:'append'|'insert'}).
  // (Pegar pasos copiados va por `pasteAt`, que sabe de varios nodos a la vez.)
  const insertStep = (type, context) => {
    if (!context) return;
    const id = newNodeId();
    const newModelNode = { id, type, position: { x: 0, y: 0 }, data: newNodeData(type) };

    if (context.mode === 'append') {
      const src = modelNodes.find((n) => n.id === context.sourceId);
      const base = src?.position || { x: 0, y: 0 };
      let dx = context.sourceHandle === 'yes' ? -GAP_X / 2 : context.sourceHandle === 'no' ? GAP_X / 2 : 0;
      // Dividir / Condición: cada salida baja bajo su columna (repartidas a lo ancho).
      const outs = src?.type === 'split'
        ? (src.data?.routes || []).map((r) => r.id)
        : src?.type === 'condition' ? conditionHandles(src.data) : null;
      if (outs) {
        const idx = outs.indexOf(context.sourceHandle);
        if (idx >= 0 && outs.length > 1) dx = (idx - (outs.length - 1) / 2) * GAP_X;
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
  const handlePickStep = (type) => insertStep(type, adding);

  /**
   * Pega lo copiado (UN paso o una rama entera con sus conexiones) en un punto:
   *  - { mode:'append', sourceId, sourceHandle } → cuelga de esa salida
   *  - { mode:'insert', edgeId }  → se mete DENTRO de esa conexión (y lo que
   *    venía después se re-engancha al final de lo pegado)
   *  - { mode:'loose' }  → Ctrl+V: bajo el paso seleccionado si su salida está
   *    libre; si no, suelto a la derecha del diagrama (útil al pegar el flujo de
   *    OTRA automatización, que llega sin dónde engancharse).
   *
   * El contenido se lee del REF, no del estado: los handlers de pegar viven en
   * memos cuyas dependencias no incluyen el contenido del portapapeles (solo
   * CUÁNTOS pasos hay). Al copiar un SEGUNDO paso el memo no se recalculaba y
   * seguía pegando el PRIMERO. El ref siempre tiene lo último copiado.
   */
  const pasteAt = (rawContext) => {
    const cb = clipboardRef.current;
    if (!cb?.nodes?.length || !rawContext) return;

    let context = rawContext;
    if (context.mode === 'loose') {
      const one = selectedIds.length === 1 ? modelNodes.find((n) => n.id === selectedIds[0]) : null;
      const free = one && !isBranch(one.type) && !isSplit(one.type)
        && !edges.some((e) => e.source === one.id && (e.sourceHandle || 'default') === 'default');
      if (free) context = { mode: 'append', sourceId: one.id, sourceHandle: 'default' };
    }

    // Ids nuevos para todo lo pegado (los originales siguen vivos en el flujo).
    const idMap = {};
    cb.nodes.forEach((n) => { idMap[n.id] = newNodeId(); });

    // Raíz de la copia: el paso al que nadie apunta DENTRO de la selección (el
    // más alto si hay varios sueltos). Es el que se engancha al punto de pegado.
    const innerTargets = new Set(cb.edges.map((e) => e.target));
    const candidates = cb.nodes.filter((n) => !innerTargets.has(n.id));
    const root = [...(candidates.length ? candidates : cb.nodes)]
      .sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0))[0];

    // Cola: final de la cadena principal siguiendo las salidas "default". Es por
    // donde se vuelve a enganchar el resto del flujo al pegar SOBRE una línea.
    const defOut = {};
    cb.edges.forEach((e) => { if ((e.sourceHandle || 'default') === 'default') defOut[e.source] = e.target; });
    let tailId = root.id;
    const walked = new Set([tailId]);
    while (defOut[tailId] && !walked.has(defOut[tailId])) { tailId = defOut[tailId]; walked.add(tailId); }
    const tailType = cb.nodes.find((n) => n.id === tailId)?.type;
    const tailChainable = !isBranch(tailType) && !isSplit(tailType);

    const xs = cb.nodes.map((n) => n.position?.x || 0);
    const ys = cb.nodes.map((n) => n.position?.y || 0);
    const copyHeight = Math.max(...ys) - Math.min(...ys) + GAP_Y;
    const rootX = root.position?.x || 0;
    const rootY = root.position?.y || 0;

    // Clona nodos y aristas internas desplazados (dx, dy) respecto al original.
    const build = (dx, dy) => ({
      nodes: cb.nodes.map((n) => ({
        id: idMap[n.id],
        type: n.type,
        position: { x: (n.position?.x || 0) + dx, y: (n.position?.y || 0) + dy },
        data: JSON.parse(JSON.stringify(n.data || {})),
      })),
      edges: cb.edges.map((e) => ({
        id: `e-${idMap[e.source]}-${idMap[e.target]}-${e.sourceHandle || 'default'}`,
        source: idMap[e.source],
        target: idMap[e.target],
        sourceHandle: e.sourceHandle || 'default',
      })),
    });

    const finish = (nextNodes, nextEdges, msg) => {
      pendingSelectRef.current = new Set(Object.values(idMap));
      onChange?.({ nodes: nextNodes, edges: nextEdges });
      // Con un solo paso pegado se abre su configuración (como al añadirlo).
      setSelectedId(cb.nodes.length === 1 ? idMap[root.id] : null);
      setSelectedTrigger(null);
      setAdding(null);
      toast.success(msg || (cb.nodes.length === 1 ? 'Paso pegado' : `${cb.nodes.length} pasos pegados`));
    };

    if (context.mode === 'append') {
      const src = modelNodes.find((n) => n.id === context.sourceId);
      const base = src?.position || { x: 0, y: 0 };
      // Cada salida de un Dividir / Condición baja por su propia columna.
      let dx = 0;
      const outs = src?.type === 'split'
        ? (src.data?.routes || []).map((r) => r.id)
        : src?.type === 'condition' ? conditionHandles(src.data) : null;
      if (outs) {
        const idx = outs.indexOf(context.sourceHandle);
        if (idx >= 0 && outs.length > 1) dx = (idx - (outs.length - 1) / 2) * GAP_X;
      }
      const copy = build(base.x + dx - rootX, base.y + GAP_Y - rootY);
      const nextEdges = setEdge([...edges, ...copy.edges], context.sourceId, idMap[root.id], context.sourceHandle || 'default');
      finish([...modelNodes, ...copy.nodes], nextEdges);
      return;
    }

    if (context.mode === 'insert') {
      const target = edges.find((e) => e.id === context.edgeId);
      if (!target) { setAdding(null); return; }
      const dst = modelNodes.find((n) => n.id === target.target);
      const src = modelNodes.find((n) => n.id === target.source);
      const copy = build(
        (dst?.position?.x ?? src?.position?.x ?? 0) - rootX,
        (dst?.position?.y ?? ((src?.position?.y || 0) + GAP_Y)) - rootY
      );
      let nextEdges = [...edges.filter((e) => e.id !== context.edgeId), ...copy.edges];
      nextEdges = setEdge(nextEdges, target.source, idMap[root.id], target.sourceHandle || 'default');
      if (tailChainable) {
        nextEdges = setEdge(nextEdges, idMap[tailId], target.target, 'default');
      } else {
        // Lo pegado acaba en una Condición/Dividir: no hay una salida "siguiente"
        // evidente, así que el paso que venía después queda suelto a propósito.
        toast('Lo pegado termina en Condición/Dividir: conecta a mano el paso que seguía.', { icon: '⚠️' });
      }
      // Empuja hacia abajo lo que venía después para hacer hueco a lo pegado.
      const shift = descendantIdsInclusive(nextEdges, target.target);
      const shifted = modelNodes.map((n) => (shift.has(n.id) ? { ...n, position: { x: n.position?.x || 0, y: (n.position?.y || 0) + copyHeight } } : n));
      finish([...shifted, ...copy.nodes], nextEdges);
      return;
    }

    // Suelto: a la derecha de todo el diagrama, sin conectar.
    const maxX = Math.max(0, ...modelNodes.map((n) => n.position?.x || 0));
    const copy = build(maxX + GAP_X * 1.4 - Math.min(...xs), -Math.min(...ys));
    finish(
      [...modelNodes, ...copy.nodes],
      [...edges, ...copy.edges],
      `${cb.nodes.length === 1 ? 'Paso pegado' : `${cb.nodes.length} pasos pegados`} a la derecha del diagrama, sin conectar: arrastra una conexión hasta el primero.`
    );
  };

  const updateNodeData = (id, patch) => {
    const next = modelNodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    onChange?.({ nodes: next, edges });
  };

  // Quitar una rama de un nodo Condición: la saca de los datos y borra la arista
  // que salía de esa rama (si no, quedaría una conexión huérfana).
  const removeConditionBranch = (nodeId, branchId) => {
    const node = modelNodes.find((n) => n.id === nodeId);
    const branches = branchesOfData(node?.data).filter((b) => b.id !== branchId);
    if (branches.length < 1) return; // una condición necesita al menos una rama
    const nextNodes = modelNodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, branches } } : n));
    const nextEdges = edges.filter((e) => !(e.source === nodeId && e.sourceHandle === branchId));
    onChange?.({ nodes: nextNodes, edges: nextEdges });
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

  // Copia uno o VARIOS pasos (con las conexiones que haya ENTRE ellos) al
  // portapapeles. No modifica el flujo. Los disparadores nunca se copian.
  // Ids de pasos REALES (existen y no son disparadores) de una selección.
  const stepIds = (ids) => {
    const byId = new Map(modelNodes.map((n) => [n.id, n]));
    return new Set(ids.filter((id) => byId.get(id) && byId.get(id).type !== 'trigger'));
  };

  const copyNodes = (ids, label) => {
    const set = stepIds(ids);
    if (!set.size) return;
    // Copia PROFUNDA del estado actual: si luego se edita el original (o la copia
    // pegada), lo copiado no cambia… y lo que se pega es siempre esto.
    const payload = {
      nodes: modelNodes
        .filter((n) => set.has(n.id))
        .map((n) => ({ id: n.id, type: n.type, position: { ...(n.position || { x: 0, y: 0 }) }, data: JSON.parse(JSON.stringify(n.data || {})) })),
      // Solo las aristas INTERNAS a la selección: la copia conserva su estructura
      // (ramas, rutas del split…) sin arrastrar conexiones a pasos que no se copian.
      edges: edges
        .filter((e) => set.has(e.source) && set.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle || 'default' })),
    };
    clipboardRef.current = payload;
    setClipboard(payload);
    writeStoredClipboard(payload);
    const n = payload.nodes.length;
    toast.success(
      `${label || (n === 1 ? 'Paso copiado' : `${n} pasos copiados`)}. Pega con el icono 📋 junto a cualquier “+” (o Ctrl+V).`
    );
  };

  // Copia un paso Y TODO lo que cuelga de él (la rama entera, con sus ramas
  // internas). Es lo que permite duplicar medio flujo sin ir nodo por nodo.
  const copyBranch = (id) => {
    const ids = [...descendantIdsInclusive(edges, id)];
    copyNodes(ids, ids.length === 1 ? 'Paso copiado' : `Rama copiada (${ids.length} pasos)`);
  };

  const selectAllNodes = () => {
    setRfNodes((ns) => ns.map((n) => ({ ...n, selected: n.type !== 'trigger' })));
  };
  const clearSelection = () => setRfNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));

  // Duplica un paso: crea una copia con su misma configuración. Para pasos lineales
  // se inserta JUSTO DESPUÉS del original (listo para usar); las ramas (Sí/No) se
  // duplican al lado, sin conectar (conéctalas donde quieras).
  const duplicateNode = (id) => {
    const src = modelNodes.find((n) => n.id === id);
    if (!src || src.type === 'trigger') return;
    const newId = newNodeId();
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

  /**
   * Duplica VARIOS pasos a la vez conservando las conexiones entre ellos. La
   * copia queda suelta al lado (dónde engancharla es decisión del usuario: con
   * ramas de por medio no hay un único sitio "obvio").
   */
  const duplicateNodes = (ids) => {
    const set = stepIds(ids);
    if (!set.size) return;
    if (set.size === 1) return duplicateNode([...set][0]);
    const idMap = {};
    [...set].forEach((id) => { idMap[id] = newNodeId(); });
    const clones = modelNodes.filter((n) => set.has(n.id)).map((n) => ({
      id: idMap[n.id],
      type: n.type,
      position: { x: (n.position?.x || 0) + GAP_X * 0.45, y: (n.position?.y || 0) + GAP_Y * 0.45 },
      data: JSON.parse(JSON.stringify(n.data || {})),
    }));
    const cloneEdges = edges
      .filter((e) => set.has(e.source) && set.has(e.target))
      .map((e) => ({
        id: `e-${idMap[e.source]}-${idMap[e.target]}-${e.sourceHandle || 'default'}`,
        source: idMap[e.source],
        target: idMap[e.target],
        sourceHandle: e.sourceHandle || 'default',
      }));
    pendingSelectRef.current = new Set(Object.values(idMap));
    onChange?.({ nodes: [...modelNodes, ...clones], edges: [...edges, ...cloneEdges] });
    setSelectedId(null);
    toast.success(`${clones.length} pasos duplicados (sin conectar: arrástralos a su sitio)`);
  };

  // Elimina varios pasos a la vez. Las conexiones que quedaban colgando se van
  // con ellos (a diferencia del borrado de UN paso, aquí no hay una cadena
  // única que reconstruir).
  const deleteNodes = (ids) => {
    const set = stepIds(ids);
    if (!set.size) return;
    if (set.size === 1) return deleteNode([...set][0]);
    onChange?.({
      nodes: modelNodes.filter((n) => !set.has(n.id)),
      edges: edges.filter((e) => !set.has(e.source) && !set.has(e.target)),
    });
    setSelectedId(null);
    toast.success(`${set.size} pasos eliminados`);
  };

  // ── Atajos de teclado (Ctrl/⌘ + C / V / D / A) ──
  // Se guardan en un ref para que el listener (registrado una sola vez) llame
  // siempre a la versión ACTUAL de cada acción y no a una copia con el grafo viejo.
  const shortcutsRef = useRef({});
  shortcutsRef.current = { selectedIds, copyNodes, pasteAt, duplicateNodes, selectAllNodes };
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target;
      const tag = (el?.tagName || '').toLowerCase();
      // Dentro de un campo del panel de configuración manda el navegador.
      if (el?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const s = shortcutsRef.current;
      const key = e.key.toLowerCase();
      if (key === 'c' && s.selectedIds.length) { e.preventDefault(); s.copyNodes(s.selectedIds); }
      else if (key === 'v') { e.preventDefault(); s.pasteAt({ mode: 'loose' }); }
      else if (key === 'd' && s.selectedIds.length) { e.preventDefault(); s.duplicateNodes(s.selectedIds); }
      else if (key === 'a') { e.preventDefault(); s.selectAllNodes(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          onSelectionDragStop={persistPositions}
          onSelectionChange={onSelectionChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          connectionRadius={38}
          nodeDragThreshold={6}
          onNodeClick={(evt, n) => {
            // Ctrl/⌘/Shift + clic = seleccionar varios: no abrir la configuración.
            if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;
            if (n.type === 'trigger') { setSelectedTrigger({ nodeId: n.id, idx: 0 }); setSelectedId(null); }
            else { setSelectedId(n.id); setSelectedTrigger(null); }
          }}
          onPaneClick={() => { setSelectedId(null); setSelectedTrigger(null); }}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          // Selección múltiple: Ctrl/⌘ + clic paso a paso, o Shift + arrastre para
          // encuadrar un bloque entero (basta con rozar el nodo: modo parcial).
          multiSelectionKeyCode={['Meta', 'Control']}
          selectionKeyCode={['Shift']}
          selectionMode={SelectionMode.Partial}
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
          <button
            type="button"
            onClick={selectAllNodes}
            className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-600 shadow-sm hover:border-emerald-400 cursor-pointer flex items-center gap-1"
            title="Selecciona todos los pasos (Ctrl+A) para copiar el flujo entero"
          >
            <HiOutlineSquares2X2 className="w-3.5 h-3.5" /> Seleccionar todo
          </button>
          <span className="hidden xl:inline-flex items-center px-3 py-1.5 bg-white/80 border border-slate-200 rounded-lg text-[11px] text-slate-400 shadow-sm select-none">
            Shift + arrastrar (o Ctrl + clic) selecciona varios pasos · Ctrl+C copia, Ctrl+V pega, Ctrl+D duplica · el icono 🗂️ del paso copia la rama entera
          </span>
        </div>

        {/* Barra de la selección múltiple: copiar / duplicar / eliminar en bloque */}
        {selectedIds.length > 1 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-white border border-emerald-300 rounded-xl shadow-lg px-2.5 py-1.5">
            <span className="text-xs font-semibold text-emerald-700 px-1">{selectedIds.length} pasos</span>
            <span className="w-px h-4 bg-slate-200" />
            <button type="button" onClick={() => copyNodes(selectedIds)} className="px-2 py-1 text-xs text-slate-600 hover:text-emerald-700 bg-transparent border-none cursor-pointer flex items-center gap-1">
              <HiOutlineSquare2Stack className="w-4 h-4" /> Copiar
            </button>
            <button type="button" onClick={() => duplicateNodes(selectedIds)} className="px-2 py-1 text-xs text-slate-600 hover:text-emerald-700 bg-transparent border-none cursor-pointer flex items-center gap-1">
              <HiOutlineDocumentDuplicate className="w-4 h-4" /> Duplicar
            </button>
            <button type="button" onClick={() => deleteNodes(selectedIds)} className="px-2 py-1 text-xs text-slate-600 hover:text-rose-600 bg-transparent border-none cursor-pointer flex items-center gap-1">
              <HiOutlineTrash className="w-4 h-4" /> Eliminar
            </button>
            <button type="button" onClick={clearSelection} title="Quitar la selección" className="p-1 text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer">
              <HiOutlineXMark className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Drawer de configuración del disparador */}
        {selTrig && (
          <Drawer
            title="Configurar disparador"
            onClose={() => setSelectedTrigger(null)}
            onDelete={selTrigCount > 1 ? () => removeTrigger(selectedTrigger.nodeId, selectedTrigger.idx) : null}
          >
            <TriggerConfig
              trigger={selTrig}
              products={products}
              clinics={clinics}
              metaAds={metaAds}
              metaAdsNotice={metaAdsNotice}
              onChange={(full) => setTriggerAt(selectedTrigger.nodeId, selectedTrigger.idx, full)}
            />
          </Drawer>
        )}

        {/* Drawer de configuración del paso */}
        {selectedNode && (
          <Drawer
            title={STEP_DEFS[selectedNode.type]}
            onClose={() => setSelectedId(null)}
            onDelete={() => deleteNode(selectedNode.id)}
          >
            <NodeConfig
              // key por nodo: al saltar de un paso a otro el formulario se
              // reconstruye (si no, los estados internos de los campos —p.ej.
              // "escribir otra etiqueta"— se arrastran del paso anterior).
              key={selectedNode.id}
              node={selectedNode}
              onChange={(patch) => updateNodeData(selectedNode.id, patch)}
              onRemoveRoute={(routeId) => removeSplitRoute(selectedNode.id, routeId)}
              onRemoveBranch={(branchId) => removeConditionBranch(selectedNode.id, branchId)}
              templates={templates}
              agents={agents}
              clinics={clinics}
              products={products}
              audiences={audiences}
              audiencesNotice={audiencesNotice}
              tagOptions={tagOptions}
            />
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
function AdIdsInput({ value = '', onChange, options = [] }) {
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
      {options.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) commit([...ids, e.target.value]);
          }}
          className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm mb-2 bg-white"
        >
          <option value="">Seleccionar desde mi cuenta de Meta…</option>
          {options.map((ad) => (
            <option key={ad.id} value={ad.id}>
              {ad.name} · {ad.id}{ad.campaignName ? ` · ${ad.campaignName}` : ''}
            </option>
          ))}
        </select>
      )}
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
function TriggerConfig({ trigger = {}, onChange, products = [], clinics = [], metaAds = [], metaAdsNotice = '' }) {
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
          <span className="text-slate-600 block mb-1">Respaldo: el título contiene (opcional)</span>
          <input
            value={trigger.adTextFilter || ''}
            onChange={(e) => set({ adTextFilter: e.target.value })}
            placeholder="ej. Profilaxis  (varios separados por coma)"
            className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm"
          />
          <span className="text-[11px] text-slate-400 block mt-1 mb-3">
            Coincidencia adicional por <b>título</b>, útil si varias versiones del anuncio conservan
            el mismo nombre. Puedes escribir varios textos separados por coma.
          </span>
          <span className="text-slate-600 block mb-1">Anuncio de Meta (opcional, vacío = cualquiera)</span>
          <AdIdsInput
            value={trigger.adFilter || ''}
            onChange={(v) => set({ adFilter: v })}
            options={metaAds}
          />
          {metaAdsNotice && (
            <span className="text-[11px] text-amber-600 block mt-1">{metaAdsNotice}</span>
          )}
          <span className="text-[11px] text-slate-500 block mt-1">
            Guarda el <b>ID del Administrador de Anuncios una sola vez</b>. Con Marketing API el sistema
            reconoce automáticamente el ID del anuncio y el de su publicación/creativo aunque Meta entregue
            una variante distinta en WhatsApp. También puedes pegar el ID manualmente. Si ambos filtros quedan
            vacíos, dispara con cualquier anuncio.
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
// ─────────── Editor de condiciones ───────────
const CONDITION_INPUT_CLS = 'w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm';
const OTHER_OPTION = '__other__';

// Valor ÚNICO elegido de una lista. Las etiquetas admiten además una que aún no
// esté en uso ("Otra…"): el desplegable evita erratas, pero no encierra al usuario.
function ChoiceValue({ value = '', options = [], allowCustom = false, onChange, placeholder = 'Selecciona…' }) {
  const inList = options.some((o) => o.value === value);
  const [free, setFree] = useState(allowCustom && !!value && !inList);
  if (allowCustom && (free || options.length === 0)) {
    return (
      <div className="flex items-center gap-1">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="etiqueta" className={CONDITION_INPUT_CLS} />
        {options.length > 0 && (
          <button
            type="button"
            title="Elegir de la lista"
            onClick={() => { setFree(false); onChange(''); }}
            className="shrink-0 px-2 py-1.5 text-[11px] text-slate-500 bg-white border border-slate-200 rounded-lg cursor-pointer hover:border-emerald-400"
          >
            Lista
          </button>
        )}
      </div>
    );
  }
  return (
    <select
      value={inList ? value : ''}
      onChange={(e) => { if (e.target.value === OTHER_OPTION) { setFree(true); onChange(''); } else onChange(e.target.value); }}
      className={CONDITION_INPUT_CLS}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {allowCustom && <option value={OTHER_OPTION}>Otra (escribir)…</option>}
    </select>
  );
}

// Valor MÚLTIPLE ("es alguno de"): chips que se marcan con un clic. Con etiquetas
// se puede añadir una que no esté en la lista.
function MultiValue({ picked = [], options = [], allowCustom = false, onToggle }) {
  const [draft, setDraft] = useState('');
  const all = [...options, ...picked.filter((p) => !options.some((o) => o.value === p)).map((p) => ({ value: p, label: p }))];
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!picked.includes(v)) onToggle(v);
    setDraft('');
  };
  return (
    <div className="grid gap-1">
      {all.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {all.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onToggle(o.value)}
              className={`px-2 py-1 rounded-lg text-[11px] border cursor-pointer ${picked.includes(o.value) ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-emerald-400'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {allowCustom && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder="otra etiqueta + Enter"
          className={`${CONDITION_INPUT_CLS} text-xs`}
        />
      )}
    </div>
  );
}

// Una fila = una condición (campo · operador · valor). El valor SIEMPRE se elige
// de un desplegable cuando el campo tiene valores conocidos (etapas, etiquetas en
// uso, sucursales, fuentes): escribirlo a mano se presta a erratas que hacen que
// la condición no se cumpla nunca.
function ConditionRow({ cond, onChange, onRemove, canRemove, clinics = [], tagOptions = {} }) {
  const ops = opsFor(cond.field);
  const multi = cond.op === 'in' || cond.op === 'nin';
  const tagList = TAG_FIELD_SOURCE[cond.field] ? (tagOptions[TAG_FIELD_SOURCE[cond.field]] || []) : null;
  const options = cond.field === 'stage'
    ? STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] || s }))
    : cond.field === 'lastReply'
      ? REPLY_VALUES
      : cond.field === 'source'
        ? SOURCES
        : cond.field === 'clinic'
          ? clinics.map((c) => ({ value: String(c._id), label: c.nombreComercial || c.name }))
          : tagList
            ? tagList.map((t) => ({ value: t, label: t }))
            : null;
  // Solo las etiquetas admiten un valor fuera de la lista (una etiqueta nueva que
  // todavía no usa nadie); etapas/sucursales/fuentes son cerradas.
  const allowCustom = !!tagList;
  // Al cambiar de campo se limpia el valor y se ajusta el operador si el actual
  // no aplica (p.ej. "es mayor que" solo existe en campos numéricos).
  const changeField = (field) => {
    const allowed = opsFor(field).map((o) => o.value);
    onChange({ field, op: allowed.includes(cond.op) ? cond.op : allowed[0], value: '', values: [] });
  };
  const picked = cond.values?.length ? cond.values : (cond.value ? [cond.value] : []);
  const toggle = (v) => {
    const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v];
    onChange({ values: next, value: '' });
  };
  const inputCls = CONDITION_INPUT_CLS;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2 grid gap-1.5">
      <div className="flex items-start gap-1.5">
        <select value={cond.field || 'tag'} onChange={(e) => changeField(e.target.value)} className={`${inputCls} flex-1 min-w-0`}>
          {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {canRemove && (
          <button type="button" title="Quitar esta condición" onClick={onRemove} className="p-1.5 text-slate-300 hover:text-rose-600 bg-transparent border-none cursor-pointer">
            <HiOutlineTrash className="w-4 h-4" />
          </button>
        )}
      </div>
      <select
        value={cond.op || 'eq'}
        onChange={(e) => onChange(e.target.value === 'exists' ? { op: 'exists', value: '', values: [] } : { op: e.target.value })}
        className={inputCls}
      >
        {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {cond.op !== 'exists' && cond.field !== 'hasPatient' && (
        options
          ? (multi
            // key por campo: al cambiar de campo el editor del valor se reinicia
            // (si no, arrastra el modo "escribir otra" o el texto a medias).
            ? <MultiValue key={cond.field} picked={picked} options={options} allowCustom={allowCustom} onToggle={toggle} />
            : (
              <ChoiceValue
                key={cond.field}
                value={cond.value || ''}
                options={options}
                allowCustom={allowCustom}
                onChange={(v) => onChange({ value: v, values: [] })}
                placeholder={allowCustom ? 'Selecciona etiqueta…' : 'Selecciona…'}
              />
            ))
          : NUMBER_FIELDS.includes(cond.field)
            ? <NumericInput value={Number(cond.value) || 0} onChange={(e) => onChange({ value: String(e.target.value), values: [] })} className={inputCls} />
            : (
              <input
                value={cond.value || ''}
                onChange={(e) => onChange({ value: e.target.value, values: [] })}
                placeholder={multi ? 'valor1, valor2 (separa con comas)' : 'valor'}
                className={inputCls}
              />
            )
      )}
      {allowCustom && options.length === 0 && (
        <p className="text-[11px] text-slate-400">Todavía no hay etiquetas de este tipo en el sistema: escribe la que vas a usar.</p>
      )}
    </div>
  );
}

// Grupo de condiciones de una rama. El conector entre filas (Y / O) decide si
// deben cumplirse TODAS (condiciones conectadas) o basta CUALQUIERA (independientes).
function ConditionGroup({ group, onChange, clinics = [], tagOptions = {} }) {
  const conditions = group.conditions || [];
  const any = group.match === 'any';
  const patch = (id, p) => onChange({ conditions: conditions.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  return (
    <div className="grid gap-1.5">
      {conditions.map((c, i) => (
        <div key={c.id} className="grid gap-1.5">
          {i > 0 && (
            <button
              type="button"
              onClick={() => onChange({ match: any ? 'all' : 'any' })}
              title={any ? 'Basta con que se cumpla UNA (clic para exigir todas)' : 'Deben cumplirse TODAS (clic para exigir solo una)'}
              className={`justify-self-center px-2 py-0.5 rounded-full text-[10px] font-bold border cursor-pointer ${any ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-emerald-100 border-emerald-300 text-emerald-700'}`}
            >
              {any ? 'O' : 'Y'}
            </button>
          )}
          <ConditionRow
            cond={c}
            clinics={clinics}
            tagOptions={tagOptions}
            canRemove={conditions.length > 1}
            onChange={(p) => patch(c.id, p)}
            onRemove={() => onChange({ conditions: conditions.filter((x) => x.id !== c.id) })}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ conditions: [...conditions, newCondition()] })}
        className="justify-self-start text-[11px] font-semibold text-emerald-600 bg-transparent border-none cursor-pointer flex items-center gap-1 hover:text-emerald-700"
      >
        <HiOutlinePlus className="w-3.5 h-3.5" /> Añadir condición
      </button>
      {conditions.length > 1 && (
        <p className="text-[11px] text-slate-400">
          {any
            ? 'Basta con que se cumpla UNA de las condiciones (independientes).'
            : 'Deben cumplirse TODAS las condiciones (conectadas).'} Pulsa el conector para cambiarlo.
        </p>
      )}
    </div>
  );
}

function NodeConfig({ node, onChange, onRemoveRoute, onRemoveBranch, templates, agents = [], clinics = [], products = [], audiences = [], audiencesNotice = '', tagOptions = {} }) {
  const d = node.data || {};
  const set = (patch) => onChange(patch);
  const t = node.type;
  const selectedAgent = agents.find((agent) => String(agent._id) === String(d.assignUser || ''));

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
  // Ventana horaria: retiene el flujo en este punto hasta que la franja abre.
  if (t === 'window') return (
    <div className="grid gap-3">
      <WorkflowWindowPicker
        value={{ days: d.windowDays || [], from: d.windowFrom, to: d.windowTo }}
        onChange={(patch) => set({
          ...(patch.days !== undefined ? { windowDays: patch.days } : {}),
          ...(patch.from !== undefined ? { windowFrom: patch.from } : {}),
          ...(patch.to !== undefined ? { windowTo: patch.to } : {}),
        })}
      />
      <p className="text-[11px] text-slate-400">
        La franja de arriba es la de <b>silencio</b>: mientras dure, todo lo que venga <b>después</b> de este
        paso se queda esperando aquí. El contacto <b>no se pierde</b>: continúa en cuanto el silencio termina
        (p. ej. con 23:00–06:20, quien entra a las 02:00 sigue a las 06:20). Fuera de esa franja el flujo pasa
        de largo. Hora de Ecuador.
      </p>
      <p className="text-[11px] text-slate-500 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
        La franja sigue vigente para <b>todos los envíos posteriores</b> de esta rama, también los que caen
        después de un paso <b>“Esperar”</b>: una espera de 5 h que aterrice de madrugada no envía, aguarda al
        final del silencio. Solo afecta a <b>esta rama</b>: para callar la automatización entera usa
        <b> “Horario de silencio”</b> en la barra de arriba.
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
  // Objetivo: una sola lista de condiciones (no ramifica; si se cumple, termina).
  if (t === 'goal') {
    const g = branchesOfData(d)[0];
    return (
      <div className="grid gap-2">
        <ConditionGroup group={g} clinics={clinics} tagOptions={tagOptions} onChange={(p) => set(p)} />
        <p className="text-[11px] text-slate-400">
          El flujo <b>termina</b> para ese contacto en cuanto se cumple lo de arriba. Si no se cumple, continúa por
          la salida de abajo.
        </p>
      </div>
    );
  }
  // Condición: varias ramas (si / si no) y varias condiciones por rama.
  if (t === 'condition') {
    const branches = branchesOfData(d);
    const patchBranch = (id, p) => set({ branches: branches.map((b) => (b.id === id ? { ...b, ...p } : b)) });
    const addBranch = () => set({
      branches: [...branches, { id: newBranchId(), name: `Rama ${branches.length + 1}`, match: 'all', conditions: [newCondition()] }],
    });
    return (
      <div className="grid gap-3">
        {branches.map((b, i) => (
          <div key={b.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-2.5 grid gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wide shrink-0">
                {i === 0 ? 'Si' : 'Si no, si'}
              </span>
              <input
                value={b.name}
                onChange={(e) => patchBranch(b.id, { name: e.target.value })}
                placeholder={`Rama ${i + 1}`}
                title="Nombre de esta salida (se ve en el diagrama)"
                className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-1 text-xs"
              />
              {branches.length > 1 && (
                <button
                  type="button"
                  title="Quitar esta rama (y su conexión)"
                  onClick={() => onRemoveBranch?.(b.id)}
                  className="p-1.5 text-slate-300 hover:text-rose-600 bg-transparent border-none cursor-pointer"
                >
                  <HiOutlineTrash className="w-4 h-4" />
                </button>
              )}
            </div>
            <ConditionGroup group={b} clinics={clinics} tagOptions={tagOptions} onChange={(p) => patchBranch(b.id, p)} />
          </div>
        ))}
        <button
          type="button"
          onClick={addBranch}
          className="justify-self-start px-2.5 py-1.5 rounded-lg border border-dashed border-amber-300 bg-white text-[11px] font-semibold text-amber-700 hover:border-amber-500 cursor-pointer flex items-center gap-1"
        >
          <HiOutlinePlus className="w-3.5 h-3.5" /> Añadir rama
        </button>
        <p className="text-[11px] text-slate-400">
          Las ramas se evalúan <b>en orden</b>: gana la primera que se cumple y el contacto sigue por su salida
          (punto verde). Si no se cumple ninguna, sale por <b className="text-rose-600">{branches.length > 1 ? 'Si no' : 'No'}</b> (punto rojo,
          a la derecha). Usa los botones “+” bajo cada salida, o arrastra desde el punto hasta un nodo existente.
        </p>
      </div>
    );
  }
  // Añadir/Quitar etiqueta: campo libre (aquí es donde nacen las etiquetas nuevas)
  // PERO con la lista de las que ya existen, para no crear "vip" y "VIP".
  if (t === 'add_tag' || t === 'remove_tag') {
    const known = [...new Set([...(tagOptions.patient || []), ...(tagOptions.chat || [])])];
    return (
      <div className="grid gap-1">
        <input
          value={d.tag || ''}
          onChange={(e) => set({ tag: e.target.value })}
          list={known.length ? 'wf-known-tags' : undefined}
          placeholder="etiqueta"
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
        />
        {known.length > 0 && (
          <datalist id="wf-known-tags">
            {known.map((tg) => <option key={tg} value={tg} />)}
          </datalist>
        )}
        <p className="text-[11px] text-slate-400">
          {t === 'remove_tag'
            ? 'Debe coincidir EXACTA con la etiqueta puesta antes; elige una de la lista si ya existe.'
            : 'Se aplica al paciente y al chat. Escribe una nueva o elige una de las que ya usas.'}
        </p>
      </div>
    );
  }
  if (t === 'move_stage') return (
    <div className="grid gap-2">
      <select value={d.stage || 'contactado'} onChange={(e) => set({ stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
      </select>
      <p className="text-[11px] text-slate-400">
        Paso <b>antiguo</b>: solo mueve la oportunidad del chat a esta etapa (si no hay ninguna, la crea vacía).
        Para crear la oportunidad con nombre, servicios y valor usa el paso <b>Crear oportunidad</b>.
      </p>
    </div>
  );
  // Crear oportunidad: la oportunidad COMPLETA (lo que antes había que rellenar a
  // mano en el chat). El contacto es el del chat que disparó el flujo.
  if (t === 'create_opportunity') {
    const catalog = products.filter((p) => ['servicio', 'programa', 'insumo'].includes(p.category));
    const picked = d.opportunityProducts || [];
    const manual = d.opportunityValueMode === 'manual';
    const autoValue = picked.reduce((s, id) => {
      const p = catalog.find((x) => String(x._id) === String(id));
      return s + Number(p?.salePrice || 0);
    }, 0);
    const togglePr = (id) => set({
      opportunityProducts: picked.some((x) => String(x) === String(id))
        ? picked.filter((x) => String(x) !== String(id))
        : [...picked, id],
    });
    const oppTags = d.opportunityTags || [];
    return (
      <div className="grid gap-3">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Nombre de la oportunidad</label>
          <WhatsappTextArea
            value={d.opportunityName || ''}
            onChange={(opportunityName) => set({ opportunityName })}
            rows={2}
            placeholder="Ej. Botox — {{nombre}}"
            variables={MESSAGE_VARIABLES}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Es lo que identifica la oportunidad en el embudo. Admite variables. Si lo dejas vacío se nombra sola
            con los servicios y el contacto.
          </p>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Etapa</label>
          <select value={d.stage || 'nuevo'} onChange={(e) => set({ stage: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s] || s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Servicios de interés (inventario)</label>
          {catalog.length === 0 ? (
            <p className="text-[11px] text-slate-400">No hay servicios en el inventario.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-1.5 flex flex-wrap gap-1">
              {catalog.map((p) => (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => togglePr(p._id)}
                  className={`px-2 py-1 rounded-lg text-[11px] border cursor-pointer ${picked.some((x) => String(x) === String(p._id)) ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-emerald-400'}`}
                >
                  {p.name} {Number(p.salePrice) > 0 ? `· $${Number(p.salePrice).toFixed(2)}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Valor esperado</label>
          <select
            value={manual ? 'manual' : 'auto'}
            onChange={(e) => set({ opportunityValueMode: e.target.value })}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          >
            <option value="auto">Automático (suma de los servicios elegidos)</option>
            <option value="manual">Manual (importe fijo)</option>
          </select>
          {manual ? (
            <div className="flex items-center gap-1 mt-1">
              <span className="text-sm text-slate-500">$</span>
              <NumericInput
                value={Number(d.opportunityValue) || 0}
                onChange={(e) => set({ opportunityValue: Number(e.target.value) })}
                className="w-32 border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
              />
            </div>
          ) : (
            <p className="text-[11px] text-emerald-700 mt-1">Valor con los servicios elegidos: <b>${autoValue.toFixed(2)}</b></p>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Etiquetas de la oportunidad</label>
          <MultiValue
            picked={oppTags}
            options={(tagOptions.opportunity || []).map((tg) => ({ value: tg, label: tg }))}
            allowCustom
            onToggle={(v) => set({ opportunityTags: oppTags.includes(v) ? oppTags.filter((x) => x !== v) : [...oppTags, v] })}
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Notas</label>
          <WhatsappTextArea
            value={d.opportunityNotes || ''}
            onChange={(opportunityNotes) => set({ opportunityNotes })}
            rows={2}
            placeholder="Notas internas (admite variables)"
            variables={MESSAGE_VARIABLES}
          />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Si el chat ya tiene una oportunidad</label>
          <select value={d.ifExists || 'update'} onChange={(e) => set({ ifExists: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="update">Actualizar la existente (recomendado)</option>
            <option value="new">Crear otra oportunidad más</option>
          </select>
        </div>
        <p className="text-[11px] text-slate-400">
          La oportunidad se crea sobre el <b>chat del contacto</b> que disparó el flujo (sus datos —nombre,
          teléfono, paciente vinculado— salen de ahí) y aparece en el chat y en Oportunidades.
        </p>
      </div>
    );
  }
  if (t === 'set_appointment_status') return (
    <select value={d.appointmentStatus || 'confirmada'} onChange={(e) => set({ appointmentStatus: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
      <option value="confirmada">Marcar CONFIRMADA</option>
      <option value="cancelada">Marcar CANCELADA</option>
    </select>
  );
  if (t === 'assign_agent') return (
    <div className="grid gap-3">
      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Tipo de asignación</label>
        <select value={d.assignMode || 'roundrobin'} onChange={(e) => set({ assignMode: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
          <option value="roundrobin">Automática: asesor en turno con menos chats</option>
          <option value="user">Asesor específico</option>
        </select>
      </div>
      {(d.assignMode || 'roundrobin') === 'user' && (
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Asesor responsable</label>
          <select value={d.assignUser || ''} onChange={(e) => set({ assignUser: e.target.value || null })} className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="">Selecciona…</option>
            {agents.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name} · {!a.callCenterSchedule?.enabled ? '24/7' : (a.inShift ? 'EN TURNO' : 'FUERA DE TURNO')}
              </option>
            ))}
          </select>
          {selectedAgent && (
            <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${selectedAgent.inShift ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
              <div className="font-semibold">{selectedAgent.inShift ? 'En turno ahora' : 'Fuera de turno ahora'}</div>
              <div className="mt-0.5">{agentScheduleLabel(selectedAgent)}</div>
            </div>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-500 leading-relaxed">
        Al asignarse, el chat queda visible solo para ese asesor, marketing y administradores.
        {(d.assignMode || 'roundrobin') === 'roundrobin'
          ? ' El reparto automático considera únicamente asesores que estén en su horario de trabajo.'
          : ' Si está fuera de turno, el chat permanece privado en su cola para el siguiente horario.'}
      </p>
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
