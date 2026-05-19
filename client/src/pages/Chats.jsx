import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineChatBubbleLeftRight,
  HiOutlineStar,
  HiStar,
  HiOutlinePaperAirplane,
  HiOutlineMagnifyingGlass,
  HiOutlineArrowPath,
  HiOutlinePlus,
  HiOutlineSparkles,
  HiOutlineTag,
  HiOutlineCalendarDays,
  HiOutlineUserCircle,
  HiOutlineXMark,
  HiOutlineCheckCircle,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';

const STAGES = [
  { value: 'nuevo', label: 'Nuevo', color: 'bg-slate-100 text-slate-700' },
  { value: 'contactado', label: 'Contactado', color: 'bg-blue-100 text-blue-700' },
  { value: 'interesado', label: 'Interesado', color: 'bg-amber-100 text-amber-700' },
  { value: 'agendado', label: 'Agendado', color: 'bg-indigo-100 text-indigo-700' },
  { value: 'ganado', label: 'Ganado', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'perdido', label: 'Perdido', color: 'bg-red-100 text-red-700' },
];

const stageMeta = (s) => STAGES.find((x) => x.value === s) || STAGES[0];

function timeAgo(date) {
  if (!date) return '';
  const d = new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d`;
  return d.toLocaleDateString();
}

function formatTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Chats() {
  const { role, user } = useAuth();
  const [tab, setTab] = useState('all'); // all | mine | featured | opportunities | board
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [newChatModal, setNewChatModal] = useState(false);
  const [simulateModal, setSimulateModal] = useState(false);
  const [opportunityModal, setOpportunityModal] = useState(false);
  const [appointmentModal, setAppointmentModal] = useState(false);
  const messagesEndRef = useRef(null);

  const isSupervisor = role === 'supervisor_call_center';
  const isAdmin = role === 'admin' || user?.isSuperAdmin;

  const loadConversations = async (params = {}) => {
    try {
      setLoading(true);
      const r = await api.get('/chats', { params });
      setConversations(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar chats');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const r = await api.get('/chats/stats');
      setStats(r.data);
    } catch {
      /* noop */
    }
  };

  const loadMessages = async (id) => {
    try {
      const r = await api.get(`/chats/${id}/messages`);
      setMessages(r.data || []);
      setConversations((prev) =>
        prev.map((c) => (c._id === id ? { ...c, unreadCount: 0 } : c))
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar mensajes');
    }
  };

  useEffect(() => {
    api
      .get('/products', { params: { category: 'servicio', active: true } })
      .then((r) => setServices(Array.isArray(r.data) ? r.data : r.data?.items || []))
      .catch(() => {});
    loadStats();
  }, []);

  useEffect(() => {
    const params = {};
    if (tab === 'mine') params.assigned = 'me';
    if (tab === 'featured') params.featured = 'true';
    if (tab === 'opportunities') params.opportunity = 'true';
    if (search) params.q = search;
    loadConversations(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search]);

  useEffect(() => {
    if (activeId) loadMessages(activeId);
    else setMessages([]);
  }, [activeId]);

  // Realtime — recargar al recibir cambios
  useSocketEvent(
    'chat:message',
    (payload) => {
      if (payload?.conversationId && String(payload.conversationId) === String(activeId)) {
        loadMessages(activeId);
      }
      const params = {};
      if (tab === 'mine') params.assigned = 'me';
      if (tab === 'featured') params.featured = 'true';
      if (tab === 'opportunities') params.opportunity = 'true';
      if (search) params.q = search;
      loadConversations(params);
    },
    [activeId, tab, search]
  );
  useSocketEvent(
    'chat:updated',
    () => {
      const params = {};
      if (tab === 'mine') params.assigned = 'me';
      if (tab === 'featured') params.featured = 'true';
      if (tab === 'opportunities') params.opportunity = 'true';
      if (search) params.q = search;
      loadConversations(params);
    },
    [tab, search]
  );

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollTop = messagesEndRef.current.scrollHeight;
    }
  }, [messages]);

  const activeConv = useMemo(
    () => conversations.find((c) => c._id === activeId),
    [conversations, activeId]
  );

  const sendMessage = async () => {
    if (!draft.trim() || !activeId) return;
    const body = draft.trim();
    setDraft('');
    try {
      const r = await api.post(`/chats/${activeId}/messages`, { body });
      setMessages((prev) => [...prev, r.data]);
      setConversations((prev) =>
        prev.map((c) =>
          c._id === activeId
            ? {
                ...c,
                lastMessagePreview: body.slice(0, 140),
                lastMessageAt: r.data.createdAt,
                lastMessageDirection: 'out',
              }
            : c
        )
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar');
      setDraft(body);
    }
  };

  const toggleFeatured = async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/featured`, {
        isFeatured: !conv.isFeatured,
      });
      setConversations((prev) => prev.map((c) => (c._id === conv._id ? r.data : c)));
      toast.success(r.data.isFeatured ? 'Marcado como destacado' : 'Destacado removido');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const takeChat = async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/assign`, {});
      setConversations((prev) => prev.map((c) => (c._id === conv._id ? r.data : c)));
      toast.success('Chat asignado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      {/* Header con tabs */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HiOutlineChatBubbleLeftRight className="text-emerald-600" /> Chats
          </h1>
          <p className="text-xs text-slate-500">
            Bandeja unificada de WhatsApp y oportunidades del call center.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSimulateModal(true)}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white hover:bg-slate-50 flex items-center gap-1"
          >
            <HiOutlineSparkles className="w-4 h-4" /> Simular entrante
          </button>
          <button
            onClick={() => setNewChatModal(true)}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo chat
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-2 border-b border-slate-200">
        {[
          { id: 'all', label: 'Todos' },
          { id: 'mine', label: 'Mis chats' },
          { id: 'featured', label: 'Destacados' },
          { id: 'opportunities', label: 'Oportunidades' },
          ...(isAdmin || isSupervisor ? [{ id: 'board', label: 'Supervisión' }] : []),
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
            {t.id === 'featured' && stats?.featuredCount > 0 && (
              <span className="ml-1.5 bg-amber-100 text-amber-700 text-[10px] px-1.5 rounded-full">
                {stats.featuredCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'board' ? (
        <SupervisorBoard stats={stats} reload={loadStats} />
      ) : (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-3 min-h-0">
          {/* Lista de conversaciones */}
          <div className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden">
            <div className="p-2 border-b border-slate-100 flex gap-1">
              <div className="relative flex-1">
                <HiOutlineMagnifyingGlass className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar nombre, teléfono..."
                  className="w-full pl-8 pr-2 py-1.5 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <button
                onClick={() => loadConversations(tab === 'mine' ? { assigned: 'me' } : tab === 'featured' ? { featured: 'true' } : tab === 'opportunities' ? { opportunity: 'true' } : {})}
                className="p-1.5 text-slate-500 hover:bg-slate-50 rounded-lg"
                title="Recargar"
              >
                <HiOutlineArrowPath className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading && conversations.length === 0 ? (
                <div className="p-4 text-sm text-slate-400 text-center">Cargando...</div>
              ) : conversations.length === 0 ? (
                <div className="p-8 text-sm text-slate-400 text-center">Sin conversaciones</div>
              ) : (
                conversations.map((c) => (
                  <ConversationRow
                    key={c._id}
                    conv={c}
                    active={c._id === activeId}
                    onClick={() => setActiveId(c._id)}
                    onToggleFeatured={() => toggleFeatured(c)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Panel principal de mensajes */}
          <div className="bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden min-h-0">
            {!activeConv ? (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
                Selecciona un chat para empezar
              </div>
            ) : (
              <>
                <ChatHeader
                  conv={activeConv}
                  onToggleFeatured={() => toggleFeatured(activeConv)}
                  onTake={() => takeChat(activeConv)}
                  onOpenOpportunity={() => setOpportunityModal(true)}
                  onCreateAppointment={() => setAppointmentModal(true)}
                  meId={user?._id}
                />
                <div ref={messagesEndRef} className="flex-1 overflow-y-auto bg-slate-50 p-4 space-y-2">
                  {messages.map((m) => (
                    <MessageBubble key={m._id} msg={m} />
                  ))}
                </div>
                <div className="border-t border-slate-100 p-2 flex gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Escribe un mensaje..."
                    rows={2}
                    className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={!draft.trim()}
                    className="px-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
                  >
                    <HiOutlinePaperAirplane className="w-4 h-4" /> Enviar
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Panel lateral derecho - info y oportunidad */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-y-auto p-3 hidden lg:block">
            {activeConv ? (
              <SidePanel
                conv={activeConv}
                onUpdated={(c) => {
                  setConversations((prev) => prev.map((x) => (x._id === c._id ? c : x)));
                }}
                onEditOpportunity={() => setOpportunityModal(true)}
              />
            ) : (
              <div className="text-sm text-slate-400">Sin chat seleccionado</div>
            )}
          </div>
        </div>
      )}

      {newChatModal && (
        <NewChatModal
          onClose={() => setNewChatModal(false)}
          onCreated={(c) => {
            setConversations((prev) => [c, ...prev.filter((p) => p._id !== c._id)]);
            setActiveId(c._id);
            setNewChatModal(false);
          }}
        />
      )}
      {simulateModal && (
        <SimulateModal
          onClose={() => setSimulateModal(false)}
          onSimulated={() => {
            setSimulateModal(false);
            loadConversations(tab === 'mine' ? { assigned: 'me' } : {});
          }}
        />
      )}
      {opportunityModal && activeConv && (
        <OpportunityModal
          conv={activeConv}
          services={services}
          onClose={() => setOpportunityModal(false)}
          onSaved={(c) => {
            setConversations((prev) => prev.map((x) => (x._id === c._id ? c : x)));
            setOpportunityModal(false);
          }}
        />
      )}
      {appointmentModal && activeConv && (
        <AppointmentFromChatModal
          conv={activeConv}
          services={services}
          onClose={() => setAppointmentModal(false)}
          onCreated={(c) => {
            setConversations((prev) => prev.map((x) => (x._id === c._id ? c : x)));
            setAppointmentModal(false);
            toast.success('Cita creada desde el chat');
          }}
        />
      )}
    </div>
  );
}

// ============= Sub-componentes =============

function ConversationRow({ conv, active, onClick, onToggleFeatured }) {
  const meta = conv.opportunity?.isOpportunity ? stageMeta(conv.opportunity.stage) : null;
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`w-full text-left px-3 py-2.5 border-b border-slate-50 hover:bg-slate-50 cursor-pointer ${
        active ? 'bg-emerald-50' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-sm flex-shrink-0">
          {(conv.contactName || conv.phone || '?').slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm text-slate-800 truncate">
              {conv.contactName || conv.phone}
            </span>
            <span className="text-[10px] text-slate-400 flex-shrink-0 ml-1">
              {timeAgo(conv.lastMessageAt)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs text-slate-500 truncate flex-1">
              {conv.lastMessageDirection === 'out' && <span className="text-slate-400">Tú: </span>}
              {conv.lastMessagePreview || <em className="text-slate-300">Sin mensajes</em>}
            </span>
            {conv.unreadCount > 0 && (
              <span className="bg-emerald-600 text-white text-[10px] rounded-full px-1.5 min-w-[18px] text-center">
                {conv.unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-1">
            {meta && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.color}`}>
                {meta.label}
              </span>
            )}
            {conv.assignedToName && (
              <span className="text-[10px] text-slate-400">→ {conv.assignedToName}</span>
            )}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFeatured();
          }}
          className="p-0.5"
          title={conv.isFeatured ? 'Quitar destacado' : 'Marcar destacado'}
        >
          {conv.isFeatured ? (
            <HiStar className="w-4 h-4 text-amber-500" />
          ) : (
            <HiOutlineStar className="w-4 h-4 text-slate-300 hover:text-amber-500" />
          )}
        </button>
      </div>
    </div>
  );
}

function ChatHeader({ conv, onToggleFeatured, onTake, onOpenOpportunity, onCreateAppointment, meId }) {
  const canTake = !conv.assignedTo || String(conv.assignedTo._id || conv.assignedTo) !== String(meId);
  return (
    <div className="border-b border-slate-100 p-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
        {(conv.contactName || conv.phone || '?').slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1">
        <div className="font-semibold text-slate-800">{conv.contactName || conv.phone}</div>
        <div className="text-xs text-slate-500">
          {conv.phone}
          {conv.patient && (
            <span className="ml-2 text-emerald-700">· Paciente vinculado</span>
          )}
          {conv.assignedToName && (
            <span className="ml-2">· Agente: {conv.assignedToName}</span>
          )}
        </div>
      </div>
      <div className="flex gap-1">
        {canTake && (
          <button
            onClick={onTake}
            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            Tomar
          </button>
        )}
        <button
          onClick={onOpenOpportunity}
          className="text-xs px-2 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg flex items-center gap-1"
        >
          <HiOutlineTag className="w-3.5 h-3.5" />
          {conv.opportunity?.isOpportunity ? 'Editar oportunidad' : 'Crear oportunidad'}
        </button>
        {conv.patient && (
          <button
            onClick={onCreateAppointment}
            className="text-xs px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg flex items-center gap-1"
          >
            <HiOutlineCalendarDays className="w-3.5 h-3.5" /> Crear cita
          </button>
        )}
        <button
          onClick={onToggleFeatured}
          className={`p-1.5 rounded-lg ${conv.isFeatured ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
          title={conv.isFeatured ? 'Quitar destacado' : 'Marcar destacado'}
        >
          {conv.isFeatured ? (
            <HiStar className="w-4 h-4 text-amber-500" />
          ) : (
            <HiOutlineStar className="w-4 h-4 text-slate-400" />
          )}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  const isOut = msg.direction === 'out';
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] rounded-lg px-3 py-2 text-sm shadow-sm ${
          isOut ? 'bg-emerald-500 text-white' : 'bg-white border border-slate-200 text-slate-800'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{msg.body}</div>
        <div className={`text-[10px] mt-1 flex items-center gap-1 ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {isOut && msg.sentByName && <span>{msg.sentByName} · </span>}
          {formatTime(msg.createdAt)}
          {isOut && msg.deliveryStatus === 'read' && <HiOutlineCheckCircle className="w-3 h-3" />}
        </div>
      </div>
    </div>
  );
}

function SidePanel({ conv, onUpdated, onEditOpportunity }) {
  const op = conv.opportunity || {};
  const meta = op.isOpportunity ? stageMeta(op.stage) : null;
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold text-slate-500 mb-1">Contacto</div>
        <div className="text-sm text-slate-800 flex items-center gap-2">
          <HiOutlineUserCircle className="w-4 h-4 text-slate-400" />
          {conv.contactName || 'Sin nombre'}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">{conv.phone}</div>
        {conv.patient && (
          <div className="mt-2 text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded">
            Paciente: {conv.patient.firstName} {conv.patient.lastName}
            {conv.patient.cedula && <span className="text-emerald-600/70 ml-1">· {conv.patient.cedula}</span>}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-semibold text-slate-500">Oportunidad</div>
          <button onClick={onEditOpportunity} className="text-[10px] text-emerald-600 hover:underline">
            {op.isOpportunity ? 'Editar' : 'Crear'}
          </button>
        </div>
        {op.isOpportunity ? (
          <div className="space-y-1 text-sm">
            <span className={`inline-block text-[11px] px-2 py-0.5 rounded ${meta.color}`}>
              {meta.label}
            </span>
            {op.expectedValue > 0 && (
              <div className="text-xs text-slate-600">Valor esperado: ${op.expectedValue}</div>
            )}
            {(op.interestedIn || []).length > 0 && (
              <div>
                <div className="text-[10px] text-slate-400 mt-1">Interesado en:</div>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {(op.interestedIn || []).map((s, i) => (
                    <span key={i} className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">
                      {s.name || s.product?.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {op.notes && <div className="text-xs text-slate-500 italic">"{op.notes}"</div>}
          </div>
        ) : (
          <div className="text-xs text-slate-400">No es una oportunidad aún.</div>
        )}
      </div>

      {conv.isFeatured && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
          <div className="text-xs font-semibold text-amber-700 flex items-center gap-1">
            <HiStar className="w-3.5 h-3.5" /> Destacado
          </div>
          {conv.featuredNote && (
            <div className="text-xs text-amber-700/80 mt-1">{conv.featuredNote}</div>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-slate-500 mb-1">Detalles</div>
        <div className="text-xs text-slate-600 space-y-0.5">
          <div>Canal: <span className="text-slate-800">{conv.channel}</span></div>
          <div>Estado: <span className="text-slate-800">{conv.status}</span></div>
          <div>Creado: {new Date(conv.createdAt).toLocaleDateString()}</div>
        </div>
      </div>
    </div>
  );
}

function NewChatModal({ onClose, onCreated }) {
  const [phone, setPhone] = useState('');
  const [contactName, setContactName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!phone.trim()) return toast.error('Teléfono requerido');
    setSaving(true);
    try {
      const r = await api.post('/chats', { phone, contactName });
      onCreated(r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Nuevo chat" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Teléfono</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="593987654321"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Nombre del contacto (opcional)
          </label>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          disabled={saving}
          onClick={submit}
          className="w-full bg-emerald-600 text-white py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
        >
          Crear chat
        </button>
      </div>
    </ModalShell>
  );
}

function SimulateModal({ onClose, onSimulated }) {
  const [phone, setPhone] = useState('');
  const [contactName, setContactName] = useState('');
  const [body, setBody] = useState('Hola, quisiera información');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!phone.trim() || !body.trim()) return toast.error('Teléfono y mensaje requeridos');
    setSaving(true);
    try {
      await api.post('/chats/simulate', { phone, body, contactName });
      toast.success('Mensaje entrante simulado');
      onSimulated();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Simular mensaje entrante" onClose={onClose}>
      <p className="text-xs text-slate-500 mb-3">
        Útil mientras no hay conexión real con WhatsApp Business API. Crea o reutiliza la
        conversación con ese número y agrega un mensaje entrante.
      </p>
      <div className="space-y-2">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Teléfono (ej: 593987654321)"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
        <input
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          placeholder="Nombre (opcional)"
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
        />
        <button
          disabled={saving}
          onClick={submit}
          className="w-full bg-emerald-600 text-white py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
        >
          Simular
        </button>
      </div>
    </ModalShell>
  );
}

function OpportunityModal({ conv, services, onClose, onSaved }) {
  const op = conv.opportunity || {};
  const [stage, setStage] = useState(op.stage || 'nuevo');
  const [expectedValue, setExpectedValue] = useState(op.expectedValue || 0);
  const [notes, setNotes] = useState(op.notes || '');
  const [lostReason, setLostReason] = useState(op.lostReason || '');
  const [interested, setInterested] = useState(
    (op.interestedIn || []).map((s) => s.product?._id || s.product || '')
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const payload = {
        stage,
        expectedValue: Number(expectedValue) || 0,
        notes,
        lostReason: stage === 'perdido' ? lostReason : '',
        interestedIn: interested
          .filter(Boolean)
          .map((id) => {
            const s = services.find((x) => x._id === id);
            return { product: id, name: s?.name };
          }),
      };
      const r = await api.post(`/chats/${conv._id}/opportunity`, payload);
      onSaved(r.data);
      toast.success('Oportunidad guardada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const removeOpportunity = async () => {
    if (!window.confirm('¿Quitar el estado de oportunidad?')) return;
    try {
      const r = await api.delete(`/chats/${conv._id}/opportunity`);
      onSaved(r.data);
      toast.success('Removido');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <ModalShell title="Oportunidad" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Etapa</label>
          <div className="flex flex-wrap gap-1">
            {STAGES.map((s) => (
              <button
                key={s.value}
                onClick={() => setStage(s.value)}
                className={`text-xs px-2 py-1 rounded ${
                  stage === s.value ? s.color + ' ring-2 ring-emerald-400' : 'bg-slate-50 text-slate-500'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Servicios de interés
          </label>
          <select
            multiple
            value={interested}
            onChange={(e) =>
              setInterested(Array.from(e.target.selectedOptions).map((o) => o.value))
            }
            className="w-full border border-slate-200 rounded-lg px-2 py-1 text-sm h-32"
          >
            {services.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="text-[10px] text-slate-400 mt-1">Ctrl+clic para seleccionar varios</div>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Valor esperado (USD)</label>
          <input
            type="number"
            value={expectedValue}
            onChange={(e) => setExpectedValue(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Notas</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
          />
        </div>
        {stage === 'perdido' && (
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Motivo (perdido)</label>
            <input
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        )}
        <div className="flex justify-between gap-2 pt-1">
          {op.isOpportunity && (
            <button
              onClick={removeOpportunity}
              className="text-xs text-red-600 hover:underline"
            >
              Quitar oportunidad
            </button>
          )}
          <button
            disabled={saving}
            onClick={submit}
            className="ml-auto px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm"
          >
            Guardar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function SupervisorBoard({ stats, reload }) {
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    api.get('/call-center/agents').then((r) => setAgents(r.data || [])).catch(() => {});
  }, []);

  const byAgent = stats?.byAgent || [];
  const opps = stats?.opportunities || [];

  return (
    <div className="flex-1 overflow-y-auto space-y-4">
      <div className="grid sm:grid-cols-4 gap-3">
        <KPICard label="Chats abiertos" value={stats?.byStatus?.find((s) => s._id === 'open')?.count || 0} color="emerald" />
        <KPICard label="Destacados" value={stats?.featuredCount || 0} color="amber" />
        <KPICard label="Oportunidades" value={opps.reduce((a, x) => a + x.count, 0)} color="indigo" />
        <KPICard label="Ganadas" value={opps.find((x) => x._id === 'ganado')?.count || 0} color="emerald" />
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-slate-800">Por agente</h2>
          <button onClick={reload} className="text-xs text-slate-500 hover:underline">
            Recargar
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Agente</th>
                <th className="text-right px-3 py-2">Total chats</th>
                <th className="text-right px-3 py-2">Abiertos</th>
                <th className="text-right px-3 py-2">Destacados</th>
                <th className="text-right px-3 py-2">Oportunidades</th>
                <th className="text-right px-3 py-2">Ganadas</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.map((a) => (
                <tr key={a._id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{a.name}</td>
                  <td className="px-3 py-2 text-right">{a.total}</td>
                  <td className="px-3 py-2 text-right">{a.open}</td>
                  <td className="px-3 py-2 text-right">{a.featured}</td>
                  <td className="px-3 py-2 text-right">{a.opportunities}</td>
                  <td className="px-3 py-2 text-right text-emerald-700 font-bold">{a.won}</td>
                </tr>
              ))}
              {byAgent.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-sm">
                    Sin actividad
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <h2 className="font-semibold text-slate-800 mb-2">Embudo de oportunidades</h2>
        <div className="grid sm:grid-cols-6 gap-2">
          {STAGES.map((s) => {
            const item = opps.find((x) => x._id === s.value);
            return (
              <div key={s.value} className={`rounded-lg p-3 ${s.color}`}>
                <div className="text-xs font-semibold">{s.label}</div>
                <div className="text-2xl font-bold">{item?.count || 0}</div>
                <div className="text-[10px] opacity-70">${(item?.value || 0).toFixed(0)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="text-xs text-slate-400">
        Agentes call_center activos: <strong>{agents.length}</strong>
      </div>
    </div>
  );
}

function KPICard({ label, value, color }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    slate: 'bg-slate-50 text-slate-700',
  };
  return (
    <div className={`rounded-xl p-3 ${colors[color] || colors.slate}`}>
      <div className="text-xs">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function ModalShell({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <HiOutlineXMark className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function AppointmentFromChatModal({ conv, services, onClose, onCreated }) {
  const { clinics, activeClinic } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState('09:00');
  const [clinicId, setClinicId] = useState(activeClinic?._id || conv.clinic || '');
  const [reason, setReason] = useState(conv.opportunity?.notes || '');
  const [selectedServices, setSelectedServices] = useState(
    (conv.opportunity?.interestedIn || [])
      .filter((i) => i.product)
      .map((i) => ({ product: i.product, quantity: 1 }))
  );
  const [saving, setSaving] = useState(false);

  const toggleService = (productId) => {
    setSelectedServices((prev) =>
      prev.some((s) => String(s.product) === String(productId))
        ? prev.filter((s) => String(s.product) !== String(productId))
        : [...prev, { product: productId, quantity: 1 }]
    );
  };

  const submit = async () => {
    if (!date || !startTime) return toast.error('Fecha y hora requeridas');
    try {
      setSaving(true);
      const r = await api.post(`/chats/${conv._id}/appointment`, {
        date,
        startTime,
        clinic: clinicId || undefined,
        reason,
        services: selectedServices,
      });
      onCreated(r.data.conversation);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear cita');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Crear cita desde chat" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-2 text-xs text-emerald-800">
          Paciente: <strong>{conv.contactName || conv.phone}</strong>
        </div>
        {clinics?.length > 1 && (
          <div>
            <label className="text-xs font-medium text-slate-600">Clínica</label>
            <select
              value={clinicId}
              onChange={(e) => setClinicId(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-1"
            >
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-slate-600">Fecha</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Hora</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-1"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600">Motivo</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 mt-1"
          />
        </div>
        {services?.length > 0 && (
          <div>
            <label className="text-xs font-medium text-slate-600">Servicios</label>
            <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2 mt-1 space-y-1">
              {services.map((s) => {
                const checked = selectedServices.some((x) => String(x.product) === String(s._id));
                return (
                  <label key={s._id} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleService(s._id)}
                    />
                    <span className="flex-1">{s.name}</span>
                    <span className="text-slate-400">${(s.price || 0).toFixed(2)}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? 'Creando…' : 'Crear cita'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
