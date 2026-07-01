import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import NumericInput from '../components/NumericInput';
import useDebounce from '../hooks/useDebounce';
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
  HiOutlineDocumentDuplicate,
  HiOutlineTrash,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import SameSlotPanel from '../components/SameSlotPanel';
import TagEditor from '../components/TagEditor';
import { fmtDate } from '../utils/date';

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
  return fmtDate(d);
}

function formatTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getWindow24hExpiresAt(conv) {
  if (!conv || conv.channel !== 'whatsapp') return null;
  if (conv.window24hExpiresAt) return new Date(conv.window24hExpiresAt);
  if (conv.lastMessageDirection === 'in' && conv.lastMessageAt) {
    return new Date(new Date(conv.lastMessageAt).getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

function isWhatsappWindowClosed(conv) {
  if (!conv || conv.channel !== 'whatsapp') return false;
  // Los números QR (WhatsApp Web) no tienen ventana de 24h: se puede escribir siempre.
  if (conv.whatsappAccount?.connectionType === 'qr') return false;
  const expiresAt = getWindow24hExpiresAt(conv);
  return !expiresAt || expiresAt.getTime() <= Date.now();
}

function isOptedOut(conv) {
  const marketing = conv?.patient?.marketing;
  return Boolean(marketing?.optOutAt || marketing?.whatsappOptIn === false);
}

export default function Chats() {
  const { role, user } = useAuth();
  const [tab, setTab] = useState('all'); // all | mine | featured | opportunities | board
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [stats, setStats] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [templateDraft, setTemplateDraft] = useState({ name: '', language: 'es', vars: '' });
  const [templates, setTemplates] = useState([]); // plantillas WhatsApp aprobadas
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // Mensajes guardados y galería
  const [savedReplies, setSavedReplies] = useState([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [gallery, setGallery] = useState([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [savedRepliesModal, setSavedRepliesModal] = useState(false);
  const [newChatModal, setNewChatModal] = useState(false);
  const [simulateModal, setSimulateModal] = useState(false);
  const [opportunityModal, setOpportunityModal] = useState(false);
  const [appointmentModal, setAppointmentModal] = useState(false);
  const [quotationModal, setQuotationModal] = useState(false);
  const messagesEndRef = useRef(null);
  const [agents, setAgents] = useState([]);

  const isSupervisor = role === 'marketing';
  const isAdmin = role === 'admin' || user?.isSuperAdmin;
  const canAutoAssign = isSupervisor || isAdmin;

  // Solo la respuesta de la última búsqueda actualiza la lista: descarta
  // respuestas fuera de orden que sobrescribirían con datos obsoletos.
  const convReqRef = useRef(0);
  const loadConversations = async (params = {}) => {
    const reqId = ++convReqRef.current;
    try {
      setLoading(true);
      const r = await api.get('/chats', { params });
      if (reqId !== convReqRef.current) return; // respuesta obsoleta: descartar
      setConversations(r.data || []);
    } catch (err) {
      if (reqId === convReqRef.current) toast.error(err.response?.data?.message || 'Error al cargar chats');
    } finally {
      if (reqId === convReqRef.current) setLoading(false);
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
    // Cargar servicios + programas para que estén disponibles en agendamiento y cotizaciones
    api
      .get('/products', { params: { limit: 500 } })
      .then((r) => {
        const arr = Array.isArray(r.data) ? r.data : r.data?.items || [];
        setServices(
          arr.filter(
            (p) => p.active !== false && (p.category === 'servicio' || p.category === 'programa' || p.unlimited === true)
          )
        );
      })
      .catch(() => {});
    api.get('/chats/saved-replies').then((r) => setSavedReplies(r.data || [])).catch(() => {});
    api.get('/chats/gallery').then((r) => setGallery(r.data || [])).catch(() => {});
    api.get('/call-center/agents').then((r) => setAgents(r.data || [])).catch(() => {});
    // Plantillas WhatsApp aprobadas por Meta (para enviar desde el chat).
    api
      .get('/message-templates', { params: { channel: 'whatsapp', status: 'approved' } })
      .then((r) => setTemplates(r.data || []))
      .catch(() => {});
    loadStats();
  }, []);

  useEffect(() => {
    const params = {};
    if (tab === 'mine') params.assigned = 'me';
    if (tab === 'featured') params.featured = 'true';
    if (tab === 'opportunities') params.opportunity = 'true';
    if (tab === 'unread') params.unread = 'true';
    if (debouncedSearch) params.q = debouncedSearch;
    loadConversations(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, debouncedSearch]);

  useEffect(() => {
    if (activeId) loadMessages(activeId);
    else setMessages([]);
    setTemplateDraft({ name: '', language: 'es', vars: '' });
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
      if (debouncedSearch) params.q = debouncedSearch;
      loadConversations(params);
    },
    [activeId, tab, debouncedSearch]
  );
  useSocketEvent(
    'chat:message:status',
    (payload) => {
      if (payload?.conversationId && String(payload.conversationId) === String(activeId)) {
        setMessages((prev) =>
          prev.map((m) =>
            String(m._id) === String(payload.messageId)
              ? {
                  ...m,
                  deliveryStatus: payload.deliveryStatus,
                  statusTimestamps: payload.statusTimestamps,
                  errorCode: payload.errorCode,
                  errorMessage: payload.errorMessage,
                }
              : m
          )
        );
      }
    },
    [activeId]
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
  const activeWindowClosed = isWhatsappWindowClosed(activeConv);
  const activeOptedOut = isOptedOut(activeConv);

  const suggestReply = async () => {
    if (!activeId) return;
    setSuggesting(true);
    try {
      const { data } = await api.post(`/chats/${activeId}/suggest-reply`);
      if (data.suggestion) setDraft(data.suggestion);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo sugerir respuesta');
    } finally {
      setSuggesting(false);
    }
  };

  const sendMessage = async () => {
    if (!activeId || !activeConv) return;
    const windowClosed = isWhatsappWindowClosed(activeConv);
    const optedOut = isOptedOut(activeConv);
    if (optedOut) {
      toast.error('Contacto en opt-out');
      return;
    }
    const body = draft.trim();
    const templateName = templateDraft.name.trim();
    // Si hay una plantilla seleccionada se envía como plantilla (sirve tanto dentro
    // como fuera de la ventana de 24h). Si no, se envía texto libre (solo dentro).
    const useTemplate = !!templateName;
    if (!useTemplate && windowClosed) {
      toast.error('Ventana de 24h cerrada: selecciona una plantilla aprobada');
      return;
    }
    if (!useTemplate && !body) return;
    if (!useTemplate) setDraft('');
    try {
      const payload = useTemplate
        ? {
            templateName,
            templateLanguage: templateDraft.language || 'es',
            templateVars: templateDraft.vars
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          }
        : { body };
      const r = await api.post(`/chats/${activeId}/messages`, payload);
      setMessages((prev) => [...prev, r.data]);
      const preview = useTemplate ? `[Plantilla: ${templateName}]` : body;
      setConversations((prev) =>
        prev.map((c) =>
          c._id === activeId
            ? {
                ...c,
                lastMessagePreview: preview.slice(0, 140),
                lastMessageAt: r.data.createdAt,
                lastMessageDirection: 'out',
              }
            : c
        )
      );
      if (r.data.deliveryStatus === 'failed') {
        toast.error(r.data.errorMessage || 'No se pudo enviar');
      } else if (useTemplate) {
        setTemplateDraft({ name: '', language: 'es', vars: '' });
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar');
      if (!windowClosed) setDraft(body);
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

  // Reparte la conversación al agente con menos chats abiertos (round-robin).
  const autoAssignChat = async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/auto-assign`, {});
      setConversations((prev) => prev.map((c) => (c._id === conv._id ? r.data : c)));
      toast.success(`Asignado a ${r.data.assignedToName || 'un agente'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo auto-asignar');
    }
  };

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      {/* Header con tabs */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
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
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nuevo chat
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-2 border-b border-slate-200">
        {[
          { id: 'all', label: 'Todos' },
          { id: 'unread', label: 'No leídos' },
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
        <SupervisorBoard stats={stats} reload={loadStats} agents={agents} />
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
                onClick={() => loadConversations(
                  tab === 'mine' ? { assigned: 'me' }
                    : tab === 'featured' ? { featured: 'true' }
                    : tab === 'opportunities' ? { opportunity: 'true' }
                    : tab === 'unread' ? { unread: 'true' }
                    : {}
                )}
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
                  onAutoAssign={canAutoAssign ? () => autoAssignChat(activeConv) : null}
                  onOpenOpportunity={() => setOpportunityModal(true)}
                  onCreateAppointment={() => setAppointmentModal(true)}
                  onCreateQuotation={() => setQuotationModal(true)}
                  meId={user?._id}
                />
                <div ref={messagesEndRef} className="flex-1 overflow-y-auto bg-slate-50 p-4 space-y-2">
                  {messages.map((m) => (
                    <MessageBubble key={m._id} msg={m} />
                  ))}
                </div>
                <div className="border-t border-slate-100 p-2">
                  {activeConv?.blocked && (
                    <div className="mb-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                      Contacto bloqueado. Desbloquéalo desde el panel lateral para enviar mensajes.
                    </div>
                  )}
                  {activeOptedOut && (
                    <div className="mb-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 flex items-center gap-1">
                      <HiOutlineExclamationTriangle className="w-4 h-4" />
                      Contacto en opt-out. No se enviaran mensajes de marketing.
                    </div>
                  )}
                  {activeWindowClosed && !activeOptedOut && !templateDraft.name && (
                    <div className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      Ventana de 24h cerrada. Solo puedes enviar una <b>plantilla aprobada</b> — pulsa “Plantilla”.
                    </div>
                  )}
                  {/* Plantilla seleccionada: preview + variables */}
                  {templateDraft.name && (
                    <div className="mb-2 border border-emerald-200 bg-emerald-50/60 rounded-lg p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-emerald-700 flex items-center gap-1">
                          <HiOutlineDocumentDuplicate className="w-3.5 h-3.5" />
                          Plantilla: {templateDraft.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => setTemplateDraft({ name: '', language: 'es', vars: '' })}
                          className="text-xs text-slate-500 hover:text-rose-600 bg-transparent border-none cursor-pointer flex items-center gap-0.5"
                        >
                          <HiOutlineXMark className="w-3.5 h-3.5" /> Quitar
                        </button>
                      </div>
                      {(() => {
                        const tpl = templates.find((t) => t.name === templateDraft.name);
                        return tpl ? (
                          <p className="text-xs text-slate-600 mt-1 whitespace-pre-wrap break-words bg-white border border-emerald-100 rounded p-2">
                            {tpl.body}
                          </p>
                        ) : null;
                      })()}
                      <input
                        value={templateDraft.vars}
                        onChange={(e) => setTemplateDraft({ ...templateDraft, vars: e.target.value })}
                        placeholder="Variables (separadas por coma) — ej. Juan, 12/06"
                        className="w-full mt-2 border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
                      />
                    </div>
                  )}
                  <div className="relative flex gap-2 items-end">
                    {slashOpen && (
                      <div className="absolute bottom-full left-0 mb-1 w-72 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30">
                        {savedReplies
                          .filter((r) => !slashQuery || r.shortcut.includes(slashQuery) || (r.title || '').toLowerCase().includes(slashQuery))
                          .slice(0, 20)
                          .map((r) => (
                            <button
                              key={r._id}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setDraft(r.body);
                                setSlashOpen(false);
                                setSlashQuery('');
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-slate-50 text-sm bg-white cursor-pointer"
                            >
                              <div className="font-semibold text-emerald-700 text-xs">/{r.shortcut}</div>
                              <div className="text-slate-600 text-xs truncate">{r.body}</div>
                            </button>
                          ))}
                        {savedReplies.length === 0 && (
                          <div className="px-3 py-2 text-xs text-slate-400">
                            Sin mensajes guardados. Configúralos en{' '}
                            <button
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); setSavedRepliesModal(true); setSlashOpen(false); }}
                              className="underline text-emerald-700 bg-transparent border-none cursor-pointer p-0"
                            >ajustes</button>.
                          </div>
                        )}
                      </div>
                    )}
                    {templatePickerOpen && (
                      <div className="absolute bottom-full left-0 mb-1 w-80 max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30">
                        <div className="px-3 py-2 border-b border-slate-100 text-xs font-semibold text-slate-500 sticky top-0 bg-white">
                          Plantillas aprobadas por Meta
                        </div>
                        {templates.length === 0 && (
                          <div className="px-3 py-3 text-xs text-slate-400">
                            No hay plantillas aprobadas. Créalas y apruébalas en Plantillas / Sincroniza con Meta.
                          </div>
                        )}
                        {templates.map((t) => (
                          <button
                            key={t._id}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setTemplateDraft({ name: t.name, language: t.language || 'es', vars: '' });
                              setTemplatePickerOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-slate-50 text-sm bg-white cursor-pointer"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-700 text-xs truncate">{t.name}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">Aprobada</span>
                            </div>
                            <div className="text-slate-500 text-xs truncate">{t.body}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setGalleryOpen(true)}
                      className="px-2 py-2 bg-white border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 cursor-pointer"
                      title="Galería de imágenes"
                    >
                      🖼
                    </button>
                    <button
                      type="button"
                      onClick={() => setTemplatePickerOpen((v) => !v)}
                      disabled={!!activeConv?.blocked || activeOptedOut}
                      className={`px-2 py-2 border rounded-lg cursor-pointer disabled:opacity-50 flex items-center ${templateDraft.name ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      title="Enviar plantilla aprobada"
                    >
                      <HiOutlineDocumentDuplicate className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setSavedRepliesModal(true)}
                      className="px-2 py-2 bg-white border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 cursor-pointer text-xs"
                      title="Mensajes guardados"
                    >
                      /
                    </button>
                    <textarea
                      value={draft}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft(v);
                        // Detectar comando "/" al inicio del último token
                        const lastSlashAt = v.lastIndexOf('/');
                        if (lastSlashAt >= 0 && (lastSlashAt === 0 || /\s/.test(v[lastSlashAt - 1]))) {
                          const q = v.slice(lastSlashAt + 1).toLowerCase();
                          if (!q.includes(' ')) {
                            setSlashQuery(q);
                            setSlashOpen(true);
                            return;
                          }
                        }
                        setSlashOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setSlashOpen(false);
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendMessage();
                        }
                      }}
                      placeholder={templateDraft.name ? 'Se enviará la plantilla seleccionada…' : 'Escribe un mensaje... (usa / para mensajes guardados)'}
                      rows={2}
                      disabled={!!activeConv?.blocked || activeWindowClosed || activeOptedOut || !!templateDraft.name}
                      className="flex-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-none disabled:bg-slate-100"
                    />
                    <button
                      onClick={suggestReply}
                      disabled={suggesting || !!activeConv?.blocked || activeOptedOut || activeWindowClosed}
                      title="Sugerir respuesta con IA"
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:border-emerald-400 disabled:opacity-50 flex items-center gap-1"
                    >
                      <HiOutlineSparkles className="w-4 h-4" /> {suggesting ? '...' : 'IA'}
                    </button>
                    <button
                      onClick={sendMessage}
                      disabled={
                        !!activeConv?.blocked ||
                        activeOptedOut ||
                        (templateDraft.name.trim()
                          ? false
                          : activeWindowClosed
                            ? true
                            : !draft.trim())
                      }
                      className="px-3 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
                    >
                      <HiOutlinePaperAirplane className="w-4 h-4" /> Enviar
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Panel lateral derecho - info y oportunidad */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-y-auto p-3 hidden lg:block">
            {activeConv ? (
              <SidePanel
                conv={activeConv}
                agents={agents}
                meId={user?._id}
                onUpdated={(c) => {
                  setConversations((prev) => prev.map((x) => (x._id === c._id ? c : x)));
                }}
                onEditOpportunity={() => setOpportunityModal(true)}
                onScheduleAppointment={() => setAppointmentModal(true)}
                onCreateQuotation={() => setQuotationModal(true)}
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
          onCreated={(c, count) => {
            setConversations((prev) => prev.map((x) => (x._id === c._id ? c : x)));
            setAppointmentModal(false);
            toast.success(count > 1 ? `${count} citas creadas desde el chat` : 'Cita creada desde el chat');
          }}
        />
      )}
      {quotationModal && activeConv && (
        <QuotationFromChatModal
          conv={activeConv}
          services={services}
          onClose={() => setQuotationModal(false)}
          onCreated={() => {
            setQuotationModal(false);
            toast.success('Cotización creada y enviada al chat');
          }}
        />
      )}
      {savedRepliesModal && (
        <SavedRepliesModal
          replies={savedReplies}
          onClose={() => setSavedRepliesModal(false)}
          onChange={(list) => setSavedReplies(list)}
        />
      )}
      {galleryOpen && (
        <GalleryModal
          images={gallery}
          onClose={() => setGalleryOpen(false)}
          onChange={(list) => setGallery(list)}
          onSend={async (imgId, caption) => {
            if (!activeId) {
              toast.error('Selecciona un chat');
              return;
            }
            try {
              await api.post(`/chats/${activeId}/send-image`, { imageId: imgId, caption });
              toast.success('Imagen enviada');
              setGalleryOpen(false);
              loadMessages(activeId);
            } catch (err) {
              toast.error(err.response?.data?.message || 'Error al enviar');
            }
          }}
        />
      )}
    </div>
  );
}

// ============= Modales nuevos =============

function SavedRepliesModal({ replies, onClose, onChange }) {
  const [list, setList] = useState(replies);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ shortcut: '', title: '', body: '' });

  const save = async () => {
    if (!form.shortcut || !form.body) {
      toast.error('Atajo y mensaje requeridos');
      return;
    }
    try {
      if (editing) {
        const r = await api.put(`/chats/saved-replies/${editing}`, form);
        const next = list.map((x) => (x._id === editing ? r.data : x));
        setList(next);
        onChange?.(next);
      } else {
        const r = await api.post('/chats/saved-replies', form);
        const next = [...list, r.data];
        setList(next);
        onChange?.(next);
      }
      setEditing(null);
      setForm({ shortcut: '', title: '', body: '' });
      toast.success('Guardado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar este mensaje guardado?')) return;
    try {
      await api.delete(`/chats/saved-replies/${id}`);
      const next = list.filter((x) => x._id !== id);
      setList(next);
      onChange?.(next);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <ModalShell title="Mensajes guardados" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="bg-emerald-50 border border-emerald-100 rounded p-2 text-xs text-emerald-800">
          Usa <code className="font-mono bg-white px-1 py-0.5 rounded">/atajo</code> en el chat para insertarlos rápidamente.
        </div>
        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-3">
            <label className="text-xs font-semibold text-slate-600 block mb-1">Atajo</label>
            <input
              placeholder="ej. saludo"
              value={form.shortcut}
              onChange={(e) => setForm({ ...form, shortcut: e.target.value.toLowerCase().replace(/\s/g, '') })}
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
            />
          </div>
          <div className="col-span-4">
            <label className="text-xs font-semibold text-slate-600 block mb-1">Título (opcional)</label>
            <input
              placeholder="Nombre descriptivo"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
            />
          </div>
          <div className="col-span-5">
            <label className="text-xs font-semibold text-slate-600 block mb-1">Mensaje</label>
            <input
              placeholder="Texto que se insertará"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {editing && (
            <button
              type="button"
              onClick={() => { setEditing(null); setForm({ shortcut: '', title: '', body: '' }); }}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
            >
              Cancelar
            </button>
          )}
          <button
            type="button"
            onClick={save}
            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 border-none cursor-pointer"
          >
            {editing ? 'Actualizar' : 'Agregar'}
          </button>
        </div>
        <ul className="space-y-1 max-h-80 overflow-y-auto">
          {list.length === 0 && <li className="text-xs text-slate-400 text-center py-4">Sin mensajes guardados.</li>}
          {list.map((r) => (
            <li key={r._id} className="flex items-start gap-2 border border-slate-100 rounded p-2 bg-slate-50/40">
              <span className="text-xs font-mono bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">/{r.shortcut}</span>
              <div className="flex-1 min-w-0">
                {r.title && <div className="text-xs font-semibold text-slate-700">{r.title}</div>}
                <div className="text-xs text-slate-600 truncate">{r.body}</div>
              </div>
              <button
                type="button"
                onClick={() => { setEditing(r._id); setForm({ shortcut: r.shortcut, title: r.title || '', body: r.body }); }}
                className="text-emerald-700 text-xs bg-transparent border-none cursor-pointer"
              >Editar</button>
              <button
                type="button"
                onClick={() => remove(r._id)}
                className="text-rose-600 text-xs bg-transparent border-none cursor-pointer"
              >Eliminar</button>
            </li>
          ))}
        </ul>
      </div>
    </ModalShell>
  );
}

function GalleryModal({ images, onClose, onChange, onSend }) {
  const [list, setList] = useState(images);
  const [caption, setCaption] = useState('');
  const [selected, setSelected] = useState('');
  const fileRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Solo imágenes');
    if (file.size > 1.8 * 1024 * 1024) return toast.error('Máximo 1.8MB');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const r = await api.post('/chats/gallery', { name: file.name, dataUrl: ev.target.result });
        const next = [r.data, ...list];
        setList(next);
        onChange?.(next);
        toast.success('Imagen subida');
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error');
      }
    };
    reader.readAsDataURL(file);
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar imagen?')) return;
    try {
      await api.delete(`/chats/gallery/${id}`);
      const next = list.filter((x) => x._id !== id);
      setList(next);
      onChange?.(next);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <ModalShell title="Galería de imágenes" onClose={onClose} size="lg">
      <div className="space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-100 cursor-pointer"
        >
          + Subir nueva imagen
        </button>
        <div className="grid grid-cols-3 gap-2 max-h-80 overflow-y-auto">
          {list.map((img) => (
            <div key={img._id} className={`border rounded p-1 cursor-pointer ${selected === img._id ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-200'}`}
              onClick={() => setSelected(img._id)}>
              <div className="aspect-square bg-slate-100 rounded flex items-center justify-center text-3xl">
                🖼
              </div>
              <div className="text-[10px] text-slate-500 truncate mt-1">{img.name}</div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(img._id); }}
                className="text-[10px] text-rose-600 bg-transparent border-none cursor-pointer mt-1"
              >Eliminar</button>
            </div>
          ))}
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Texto que acompaña a la imagen (opcional)</label>
          <input
            placeholder="Escribe un pie de foto"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
          >Cancelar</button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => onSend(selected, caption)}
            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50 border-none cursor-pointer"
          >Enviar</button>
        </div>
      </div>
    </ModalShell>
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
            {isOptedOut(conv) && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
                Opt-out
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

function ChatHeader({ conv, onToggleFeatured, onTake, onAutoAssign, onOpenOpportunity, onCreateAppointment, onCreateQuotation, meId }) {
  const canTake = !conv.assignedTo || String(conv.assignedTo._id || conv.assignedTo) !== String(meId);
  // "Esperando respuesta" cuando el último mensaje es entrante (del paciente).
  const waitingReply = conv.lastMessageDirection === 'in';
  return (
    <div className="border-b border-slate-100 p-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
        {(conv.contactName || conv.phone || '?').slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1">
        <div className="font-semibold text-slate-800 flex items-center gap-2">
          {conv.contactName || conv.phone}
          {waitingReply && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700" title="El paciente espera respuesta">
              Esperando respuesta
            </span>
          )}
        </div>
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
      <div className="flex gap-1 flex-wrap justify-end">
        {canTake && (
          <button
            onClick={onTake}
            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded-xl"
          >
            Tomar
          </button>
        )}
        {onAutoAssign && (
          <button
            onClick={onAutoAssign}
            className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded-xl"
            title="Asignar al agente con menos chats abiertos (round-robin)"
          >
            Auto-asignar
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
          onClick={onCreateQuotation}
          className="text-xs px-2 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 rounded-lg flex items-center gap-1"
        >
          <HiOutlineDocumentDuplicate className="w-3.5 h-3.5" /> Cotización
        </button>
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

const DELIVERY_META = {
  queued: { label: 'en cola', className: 'text-slate-200' },
  sent: { label: 'enviado', className: 'text-emerald-100' },
  delivered: { label: 'entregado', className: 'text-emerald-100' },
  read: { label: 'leido', className: 'text-sky-100' },
  failed: { label: 'fallido', className: 'text-rose-100' },
};

function DeliveryBadge({ msg }) {
  const meta = DELIVERY_META[msg.deliveryStatus] || DELIVERY_META.sent;
  return (
    <span className={`inline-flex items-center gap-0.5 ${meta.className}`} title={msg.errorMessage || meta.label}>
      {msg.deliveryStatus === 'failed' ? (
        <HiOutlineExclamationTriangle className="w-3 h-3" />
      ) : msg.deliveryStatus === 'read' ? (
        <HiOutlineCheckCircle className="w-3 h-3" />
      ) : null}
      {meta.label}
    </span>
  );
}

function MessageMedia({ msg }) {
  const url = msg.mediaUrl;
  if (!url) return null;
  const type = msg.mediaType || '';
  const isImage = type === 'image' || /^data:image\//.test(url);
  const isAudio = type === 'audio' || /^data:audio\//.test(url);
  if (isImage) {
    return <img src={url} alt="adjunto" className="rounded-lg max-h-60 w-auto mb-1 block" />;
  }
  if (isAudio) {
    return <audio controls src={url} className="mb-1 w-full max-w-[240px]" />;
  }
  // Documento u otro: enlace de descarga.
  return (
    <a href={url} target="_blank" rel="noreferrer" download className="underline text-xs block mb-1">
      📎 Ver adjunto
    </a>
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
        <MessageMedia msg={msg} />
        <div className="whitespace-pre-wrap break-words">{msg.body}</div>
        <div className={`text-[10px] mt-1 flex items-center gap-1 ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {isOut && msg.sentByName && <span>{msg.sentByName} · </span>}
          {formatTime(msg.createdAt)}
          {isOut && <span>Â·</span>}
          {isOut && <DeliveryBadge msg={msg} />}
        </div>
      </div>
    </div>
  );
}

function SidePanel({ conv, agents = [], meId, onUpdated, onEditOpportunity, onScheduleAppointment, onCreateQuotation }) {
  const op = conv.opportunity || {};
  const meta = op.isOpportunity ? stageMeta(op.stage) : null;
  const [registerModal, setRegisterModal] = useState(false);
  const [appts, setAppts] = useState([]);

  // Cargar citas del paciente vinculado para mostrar cuántas tiene y sus fechas.
  useEffect(() => {
    if (!conv.patient?._id && !conv.patient) {
      setAppts([]);
      return;
    }
    const pid = conv.patient?._id || conv.patient;
    api
      .get('/appointments', { params: { patient: pid, limit: 100 } })
      .then((r) => setAppts(Array.isArray(r.data) ? r.data : r.data?.appointments || []))
      .catch(() => setAppts([]));
  }, [conv.patient]);

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
        {isOptedOut(conv) && (
          <div className="mt-2 text-xs bg-rose-50 text-rose-700 border border-rose-100 px-2 py-1 rounded">
            Opt-out de marketing activo.
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1.5">
          {!conv.patient && (
            <button
              onClick={() => setRegisterModal(true)}
              className="w-full text-xs px-2 py-1.5 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 border-none cursor-pointer"
            >
              + Agregar al sistema
            </button>
          )}
          <button
            onClick={() => {
              if (!conv.patient) { toast.error('Primero agrega al paciente al sistema'); return; }
              onScheduleAppointment?.();
            }}
            className="w-full text-xs px-2 py-1.5 bg-sky-50 text-sky-700 rounded-lg hover:bg-sky-100 border border-sky-200 cursor-pointer"
          >
            Agendar cita(s)
          </button>
          <button
            onClick={() => onCreateQuotation?.()}
            className="w-full text-xs px-2 py-1.5 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 border border-amber-200 cursor-pointer"
          >
            Crear cotización y enviar
          </button>
        </div>
      </div>

      {registerModal && (
        <RegisterPatientModal
          conv={conv}
          onClose={() => setRegisterModal(false)}
          onRegistered={(c) => { setRegisterModal(false); onUpdated?.(c); toast.success('Paciente agregado al sistema'); }}
        />
      )}

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
            {(op.tags || []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {op.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <HiOutlineTag className="w-2.5 h-2.5" />{t}
                  </span>
                ))}
              </div>
            )}
            {op.notes && <div className="text-xs text-slate-500 italic">"{op.notes}"</div>}
          </div>
        ) : (
          <div className="text-xs text-slate-400">No es una oportunidad aún.</div>
        )}
      </div>

      <ConvTagsSection conv={conv} onUpdated={onUpdated} />

      <AiSummarySection conv={conv} />

      <NotesSection conv={conv} agents={agents} meId={meId} />

      <TasksSection conv={conv} agents={agents} meId={meId} />

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

      {conv.patient && (
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1 flex items-center justify-between">
            <span>Citas del paciente</span>
            <span className="bg-emerald-100 text-emerald-700 text-[10px] px-1.5 rounded-full">
              {appts.length}
            </span>
          </div>
          {appts.length === 0 ? (
            <div className="text-xs text-slate-400">Sin citas registradas.</div>
          ) : (
            <ul className="space-y-1 max-h-44 overflow-y-auto pr-1">
              {appts
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 10)
                .map((a) => {
                  const dt = new Date(a.date);
                  const dd = String(dt.getDate()).padStart(2, '0');
                  const mm = String(dt.getMonth() + 1).padStart(2, '0');
                  return (
                    <li key={a._id} className="text-xs text-slate-600 flex items-center justify-between bg-slate-50 rounded px-2 py-1">
                      <span>
                        {dd}/{mm}/{dt.getFullYear()} · {a.startTime}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        {a.status}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-slate-500 mb-1">Detalles</div>
        <div className="text-xs text-slate-600 space-y-0.5">
          <div>Canal: <span className="text-slate-800">{conv.channel}</span></div>
          {conv.whatsappAccount?.label && (
            <div>
              Número:{' '}
              <span className="text-slate-800">{conv.whatsappAccount.label}</span>
              <span className="text-slate-400"> · {conv.whatsappAccount.connectionType === 'qr' ? 'QR' : 'Cloud API'}</span>
            </div>
          )}
          <div>Estado: <span className="text-slate-800">{conv.status}</span></div>
          <div>Creado: {(() => {
            const d = new Date(conv.createdAt);
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            return `${dd}/${mm}/${d.getFullYear()}`;
          })()}</div>
          {conv.blocked && (
            <div className="text-rose-600 font-semibold">⛔ Contacto bloqueado</div>
          )}
        </div>
        <button
          onClick={async () => {
            const action = conv.blocked ? 'desbloquear' : 'bloquear';
            if (!window.confirm(`¿${action} este contacto?`)) return;
            try {
              const r = await api.post(`/chats/${conv._id}/block`, { blocked: !conv.blocked });
              onUpdated?.(r.data);
              toast.success(conv.blocked ? 'Contacto desbloqueado' : 'Contacto bloqueado');
            } catch (err) {
              toast.error(err.response?.data?.message || 'Error');
            }
          }}
          className={`w-full mt-2 text-xs px-2 py-1.5 rounded-lg border cursor-pointer ${
            conv.blocked
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
              : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
          }`}
        >
          {conv.blocked ? 'Desbloquear contacto' : 'Bloquear contacto'}
        </button>
      </div>
    </div>
  );
}

// Etiquetas del contacto/conversación (libres, para segmentar). Se guardan en
// Conversation.tags vía PUT /chats/:id.
function ConvTagsSection({ conv, onUpdated }) {
  const [tags, setTags] = useState(conv.tags || []);
  const [saving, setSaving] = useState(false);

  // Sincroniza al cambiar de conversación.
  useEffect(() => {
    setTags(conv.tags || []);
  }, [conv._id]);

  const save = async (next) => {
    setTags(next);
    setSaving(true);
    try {
      const r = await api.put(`/chats/${conv._id}`, { tags: next });
      onUpdated?.(r.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudieron guardar las etiquetas');
      setTags(conv.tags || []);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1">
        <HiOutlineTag className="w-3.5 h-3.5" /> Etiquetas {saving && <span className="text-[10px] text-slate-400">guardando…</span>}
      </div>
      <TagEditor value={tags} onChange={save} />
    </div>
  );
}

// Resumen de la conversación generado por IA (Claude) bajo demanda.
function AiSummarySection({ conv }) {
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);

  // Reinicia el resumen al cambiar de conversación.
  useEffect(() => { setSummary(''); }, [conv._id]);

  const generate = async () => {
    setLoading(true);
    try {
      const { data } = await api.post(`/chats/${conv._id}/summary`);
      setSummary(data.summary || '');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo generar el resumen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-semibold text-slate-500">Resumen IA</div>
        <button
          onClick={generate}
          disabled={loading}
          className="text-[10px] text-emerald-600 hover:underline bg-transparent border-none cursor-pointer disabled:opacity-50"
        >
          {loading ? 'Generando…' : summary ? 'Regenerar' : 'Generar'}
        </button>
      </div>
      {summary ? (
        <div className="text-xs text-slate-600 whitespace-pre-wrap bg-slate-50 border border-slate-100 rounded-lg px-2 py-1.5">
          {summary}
        </div>
      ) : (
        <div className="text-xs text-slate-400">Genera un resumen de la conversación con IA.</div>
      )}
    </div>
  );
}

// Notas internas del equipo (no se envían al paciente) con @menciones a agentes.
function NotesSection({ conv, agents = [], meId }) {
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState([]); // ids de usuarios mencionados
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get(`/chats/${conv._id}/notes`).then((r) => setNotes(r.data || [])).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [conv._id]);

  const onDraftChange = (v) => {
    setDraft(v);
    const at = v.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(v[at - 1]))) {
      const q = v.slice(at + 1);
      if (!q.includes(' ')) { setMentionQuery(q.toLowerCase()); setMentionOpen(true); return; }
    }
    setMentionOpen(false);
  };

  const pickMention = (agent) => {
    const at = draft.lastIndexOf('@');
    const before = at >= 0 ? draft.slice(0, at) : draft;
    setDraft(`${before}@${agent.name} `);
    setMentions((prev) => (prev.includes(agent._id) ? prev : [...prev, agent._id]));
    setMentionOpen(false);
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      // Conserva solo las menciones cuyo nombre sigue presente en el texto.
      const used = mentions.filter((id) => {
        const a = agents.find((x) => x._id === id);
        return a && body.includes(`@${a.name}`);
      });
      await api.post(`/chats/${conv._id}/notes`, { body, mentions: used });
      setDraft(''); setMentions([]); load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar la nota');
    } finally {
      setSaving(false);
    }
  };

  const filtered = agents
    .filter((a) => String(a._id) !== String(meId))
    .filter((a) => !mentionQuery || (a.name || '').toLowerCase().includes(mentionQuery))
    .slice(0, 6);

  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 mb-1">Notas internas</div>
      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1 mb-2">
        {notes.length === 0 && (
          <div className="text-xs text-slate-400">Sin notas. Visibles solo para el equipo.</div>
        )}
        {notes.map((n, i) => (
          <div key={n._id || i} className="text-xs bg-amber-50/60 border border-amber-100 rounded-lg px-2 py-1.5">
            <div className="text-slate-700 whitespace-pre-wrap break-words">{n.body}</div>
            <div className="text-[10px] text-slate-400 mt-0.5">
              {n.author?.name || n.authorName || 'Agente'} · {timeAgo(n.at)}
            </div>
          </div>
        ))}
      </div>
      <div className="relative">
        {mentionOpen && filtered.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-40 overflow-y-auto">
            {filtered.map((a) => (
              <button
                key={a._id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pickMention(a); }}
                className="w-full text-left px-2 py-1.5 hover:bg-emerald-50 text-xs bg-white cursor-pointer border-none"
              >
                @{a.name}
              </button>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor={`note-${conv._id}`}>Nueva nota interna</label>
        <textarea
          id={`note-${conv._id}`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          rows={2}
          placeholder="Nota interna... usa @ para mencionar a un agente"
          className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs resize-none"
        />
      </div>
      <button
        onClick={submit}
        disabled={saving || !draft.trim()}
        className="mt-1 w-full text-xs px-2 py-1.5 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 border-none cursor-pointer"
      >
        {saving ? 'Guardando...' : 'Agregar nota'}
      </button>
    </div>
  );
}

// Tareas/recordatorios del agente ligadas a esta conversación.
function TasksSection({ conv, agents = [], meId }) {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => {
    api
      .get('/agent-tasks', { params: { conversation: conv._id } })
      .then((r) => setTasks(r.data || []))
      .catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [conv._id]);

  const add = async () => {
    if (!title.trim()) return;
    setAdding(true);
    try {
      await api.post('/agent-tasks', {
        title: title.trim(),
        conversation: conv._id,
        patient: conv.patient?._id || conv.patient || null,
        assignedTo: assignedTo || meId,
        dueAt: dueAt || null,
      });
      setTitle(''); setDueAt(''); setAssignedTo(''); load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear la tarea');
    } finally {
      setAdding(false);
    }
  };

  const toggle = async (t) => {
    try {
      await api.put(`/agent-tasks/${t._id}`, { status: t.status === 'done' ? 'open' : 'done' });
      load();
    } catch {
      /* noop */
    }
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 mb-1">Tareas</div>
      <div className="space-y-1 mb-2 max-h-40 overflow-y-auto pr-1">
        {tasks.length === 0 && (
          <div className="text-xs text-slate-400">Sin tareas para este chat.</div>
        )}
        {tasks.map((t) => (
          <div key={t._id} className="flex items-start gap-2 text-xs bg-slate-50 rounded-lg px-2 py-1.5">
            <input
              type="checkbox"
              checked={t.status === 'done'}
              onChange={() => toggle(t)}
              className="mt-0.5"
              title="Marcar como completada"
            />
            <div className="flex-1">
              <div className={t.status === 'done' ? 'line-through text-slate-400' : 'text-slate-700'}>{t.title}</div>
              <div className="text-[10px] text-slate-400">
                {t.assignedTo?.name && <span>{t.assignedTo.name}</span>}
                {t.dueAt && <span> · vence {fmtDate(t.dueAt)}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <label className="sr-only" htmlFor={`task-title-${conv._id}`}>Título de la tarea</label>
      <input
        id={`task-title-${conv._id}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Nueva tarea (ej. llamar mañana 10am)"
        className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs mb-1"
      />
      <div className="grid grid-cols-2 gap-1 mb-1">
        <div>
          <label className="sr-only" htmlFor={`task-due-${conv._id}`}>Fecha de vencimiento</label>
          <input
            id={`task-due-${conv._id}`}
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
            title="Fecha de vencimiento"
          />
        </div>
        <div>
          <label className="sr-only" htmlFor={`task-assignee-${conv._id}`}>Asignar a</label>
          <select
            id={`task-assignee-${conv._id}`}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
            title="Asignar a"
          >
            <option value="">Para mí</option>
            {agents.map((a) => (
              <option key={a._id} value={a._id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>
      <button
        onClick={add}
        disabled={adding || !title.trim()}
        className="w-full text-xs px-2 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer"
      >
        {adding ? 'Creando...' : 'Agregar tarea'}
      </button>
    </div>
  );
}

function RegisterPatientModal({ conv, onClose, onRegistered }) {
  const guessName = (conv.contactName || '').trim().split(/\s+/);
  const [form, setForm] = useState({
    firstName: guessName[0] || '',
    lastName: guessName.slice(1).join(' ') || '',
    cedula: '',
    gender: '',
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.firstName || !form.lastName) return toast.error('Nombres y apellidos requeridos');
    if (!form.gender) return toast.error('El género es obligatorio');
    setSaving(true);
    try {
      const r = await api.post(`/chats/${conv._id}/register-patient`, form);
      onRegistered(r.data.conversation);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al registrar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Agregar paciente al sistema" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Nombres</label>
            <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Apellidos</label>
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Cédula (opcional)</label>
            <input value={form.cedula} onChange={(e) => setForm({ ...form, cedula: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">Género *</label>
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
              <option value="">Seleccionar</option>
              <option value="masculino">Masculino</option>
              <option value="femenino">Femenino</option>
              <option value="otro">Otro</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">Teléfono: {conv.phone}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-700">Cancelar</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 border-none cursor-pointer">
            {saving ? 'Guardando...' : 'Agregar paciente'}
          </button>
        </div>
      </div>
    </ModalShell>
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
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Nombre del contacto (opcional)
          </label>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
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
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Teléfono</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="593987654321"
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre del contacto (opcional)</label>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Nombre del paciente"
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Mensaje entrante simulado</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Texto que enviaría el paciente"
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-none"
          />
        </div>
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
  // Soporta MÚLTIPLES oportunidades por chat. Para compatibilidad, si solo existe
  // la oportunidad legacy `opportunity`, la convertimos al array en pantalla.
  const initial = useMemo(() => {
    const list = Array.isArray(conv.opportunities) && conv.opportunities.length > 0
      ? conv.opportunities
      : (conv.opportunity?.isOpportunity ? [conv.opportunity] : []);
    return list.map((op) => ({
      _existingIdx: list === conv.opportunities ? list.indexOf(op) : -1,
      stage: op.stage || 'nuevo',
      notes: op.notes || '',
      lostReason: op.lostReason || '',
      tags: op.tags || [],
      interested: (op.interestedIn || []).map((s) => s.product?._id || s.product || '').filter(Boolean),
    }));
  }, [conv]);
  const [items, setItems] = useState(initial.length > 0 ? initial : [{ stage: 'nuevo', notes: '', lostReason: '', tags: [], interested: [] }]);
  const [saving, setSaving] = useState(false);

  // Calcular valor esperado desde inventario (precio del producto).
  const valueOf = (interested) =>
    interested
      .filter(Boolean)
      .reduce((sum, id) => {
        const s = services.find((x) => x._id === id);
        return sum + (s ? Number(s.salePrice || 0) : 0);
      }, 0);

  const submit = async () => {
    setSaving(true);
    try {
      let nextConv = conv;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const payload = {
          stage: it.stage,
          notes: it.notes,
          lostReason: it.stage === 'perdido' ? it.lostReason : '',
          tags: it.tags || [],
          interestedIn: it.interested.filter(Boolean).map((id) => {
            const s = services.find((x) => x._id === id);
            return { product: id, name: s?.name };
          }),
        };
        if (it._existingIdx >= 0) {
          // eslint-disable-next-line no-await-in-loop
          const r = await api.put(`/chats/${conv._id}/opportunities/${it._existingIdx}`, payload);
          nextConv = r.data;
        } else {
          // eslint-disable-next-line no-await-in-loop
          const r = await api.post(`/chats/${conv._id}/opportunities`, payload);
          nextConv = r.data;
        }
      }
      onSaved(nextConv);
      toast.success('Oportunidades guardadas');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async (idx, existingIdx) => {
    if (existingIdx >= 0) {
      if (!window.confirm('¿Eliminar esta oportunidad?')) return;
      try {
        const r = await api.delete(`/chats/${conv._id}/opportunities/${existingIdx}`);
        onSaved(r.data);
        toast.success('Eliminada');
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error');
      }
    }
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <ModalShell title="Oportunidades" onClose={onClose} size="lg">
      <div className="space-y-4 text-sm">
        {items.map((it, idx) => (
          <div key={idx} className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/40 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-700">Oportunidad #{idx + 1}</span>
              <button
                type="button"
                onClick={() => removeOne(idx, it._existingIdx)}
                className="text-rose-600 text-xs bg-transparent border-none cursor-pointer"
              >
                Quitar
              </button>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Etapa</label>
              <div className="flex flex-wrap gap-1">
                {STAGES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, stage: s.value } : x))}
                    className={`text-xs px-2 py-1 rounded ${
                      it.stage === s.value ? s.color + ' ring-2 ring-emerald-400' : 'bg-slate-50 text-slate-500'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Servicios de interés</label>
              <ChatServicePicker
                services={services}
                selectedIds={it.interested}
                onAdd={(pid) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, interested: x.interested.includes(pid) ? x.interested : [...x.interested, pid] } : x))}
                onRemove={(pid) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, interested: x.interested.filter((y) => y !== pid) } : x))}
              />
              <div className="text-[11px] text-emerald-700 mt-1">
                Valor esperado (desde inventario): <b>${valueOf(it.interested).toFixed(2)}</b>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Etiquetas</label>
              <TagEditor
                value={it.tags || []}
                onChange={(next) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, tags: next } : x))}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Notas</label>
              <textarea
                value={it.notes}
                onChange={(e) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, notes: e.target.value } : x))}
                rows={2}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-none bg-white"
              />
            </div>
            {it.stage === 'perdido' && (
              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">Motivo (perdido)</label>
                <input
                  value={it.lostReason}
                  onChange={(e) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, lostReason: e.target.value } : x))}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm bg-white"
                />
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setItems((prev) => [...prev, { stage: 'nuevo', notes: '', lostReason: '', tags: [], interested: [] }])}
          className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-100 cursor-pointer"
        >
          + Agregar otra oportunidad
        </button>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={submit}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50 text-sm border-none cursor-pointer"
          >
            Guardar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function SupervisorBoard({ stats, reload, agents = [] }) {
  const byAgent = stats?.byAgent || [];
  const opps = stats?.opportunities || [];
  const responseTimes = stats?.responseTimes || [];
  const sla = stats?.sla || { thresholdMinutes: 60, unanswered: 0 };

  return (
    <div className="flex-1 overflow-y-auto space-y-4">
      <div className="grid sm:grid-cols-4 gap-3">
        <KPICard label="Chats abiertos" value={stats?.byStatus?.find((s) => s._id === 'open')?.count || 0} color="emerald" />
        <KPICard label="Oportunidades" value={opps.reduce((a, x) => a + x.count, 0)} color="indigo" />
        <KPICard label="Ganadas" value={opps.find((x) => x._id === 'ganado')?.count || 0} color="emerald" />
        <KPICard
          label={`Sin responder (>${sla.thresholdMinutes}m)`}
          value={sla.unanswered || 0}
          color={sla.unanswered > 0 ? 'rose' : 'slate'}
        />
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-slate-800">Por agente</h2>
          <button onClick={reload} className="text-xs text-slate-500 hover:underline">
            Recargar
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
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
        <h2 className="font-semibold text-slate-800 mb-2">Tiempo de primera respuesta por agente</h2>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Agente</th>
                <th className="text-right px-3 py-2">Prom. 1ª respuesta</th>
                <th className="text-right px-3 py-2"># Conversaciones</th>
              </tr>
            </thead>
            <tbody>
              {responseTimes.map((r) => (
                <tr key={r._id || r.name} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{r.name || 'Sin asignar'}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`font-semibold ${r.avgMinutes <= sla.thresholdMinutes ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {r.avgMinutes != null ? `${r.avgMinutes} min` : '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">{r.count}</td>
                </tr>
              ))}
              {responseTimes.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-slate-400 text-sm">
                    Aún no hay respuestas registradas
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          Umbral de SLA: {sla.thresholdMinutes} min. En verde, agentes dentro del umbral.
        </p>
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
    rose: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-50 text-slate-700',
  };
  return (
    <div className={`rounded-xl p-3 ${colors[color] || colors.slate}`}>
      <div className="text-xs">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function ModalShell({ title, onClose, children, size = 'md' }) {
  const sizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-[9999] p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`bg-white rounded-xl shadow-2xl w-full ${sizes[size] || sizes.md} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-3 border-b border-slate-100 sticky top-0 bg-white">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer">
            <HiOutlineXMark className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function AppointmentFromChatModal({ conv, services, onClose, onCreated }) {
  const { clinics, activeClinic } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  // Soporte para agendar múltiples citas en una sola operación.
  // Importante: arrancamos SIN servicios pre-seleccionados (el usuario los elige cada vez).
  const emptyAppt = () => ({
    date: today,
    startTime: '09:00',
    reason: '',
    services: [],
  });
  const [items, setItems] = useState([emptyAppt()]);
  const [clinicId, setClinicId] = useState(activeClinic?._id || conv.clinic || '');
  const [saving, setSaving] = useState(false);

  const updateItem = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const addService = (idx, productId) => {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        if (it.services.some((s) => String(s.product) === String(productId))) return it;
        return { ...it, services: [...it.services, { product: productId, quantity: 1 }] };
      })
    );
  };

  const removeService = (idx, productId) => {
    setItems((prev) =>
      prev.map((it, i) =>
        i === idx ? { ...it, services: it.services.filter((s) => String(s.product) !== String(productId)) } : it
      )
    );
  };

  const submit = async () => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.date || !it.startTime) {
        return toast.error(`La cita #${i + 1} requiere fecha y hora`);
      }
      if (!Array.isArray(it.services) || it.services.length === 0) {
        return toast.error(`La cita #${i + 1} requiere al menos un servicio`);
      }
    }
    try {
      setSaving(true);
      const r = await api.post(`/chats/${conv._id}/appointment`, {
        appointments: items.map((it) => ({
          date: it.date,
          startTime: it.startTime,
          reason: it.reason,
          clinic: clinicId || undefined,
          services: it.services,
        })),
      });
      onCreated(r.data.conversation, (r.data.appointments || []).length || 1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear cita(s)');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Agendar cita(s) desde chat" onClose={onClose} size="lg">
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
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1"
            >
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-3">
          {items.map((it, idx) => (
            <div key={idx} className="border border-slate-200 rounded-xl p-3 bg-slate-50/40 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-700">Cita #{idx + 1}</span>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-rose-600 text-xs bg-transparent border-none cursor-pointer hover:underline"
                  >
                    Quitar
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium text-slate-600">Fecha</label>
                  <input type="date" value={it.date} onChange={(e) => updateItem(idx, { date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Hora</label>
                  <input type="time" value={it.startTime} onChange={(e) => updateItem(idx, { startTime: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Motivo (opcional)</label>
                <input value={it.reason} onChange={(e) => updateItem(idx, { reason: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Servicios *</label>
                <ChatServicePicker
                  services={services}
                  selectedIds={it.services.map((s) => s.product)}
                  onAdd={(pid) => addService(idx, pid)}
                  onRemove={(pid) => removeService(idx, pid)}
                />
                {(!it.services || it.services.length === 0) && (
                  <p className="text-[11px] text-rose-600 mt-1">Selecciona al menos un servicio.</p>
                )}
              </div>
              {/* Disponibilidad de horario para esta cita */}
              <SameSlotPanel
                date={it.date}
                startTime={it.startTime}
                clinicId={clinicId}
                compact
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setItems((prev) => [...prev, emptyAppt()])}
          className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-50 cursor-pointer"
        >
          + Agregar otra cita
        </button>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 bg-white"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer"
          >
            {saving ? 'Creando…' : items.length > 1 ? `Crear ${items.length} citas` : 'Crear cita'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Picker compacto de servicios con autocompletado para el modal de chat.
function ChatServicePicker({ services, selectedIds, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const avail = (services || []).filter((s) => !selectedIds.includes(s._id));
    if (!q) return avail.slice(0, 10);
    return avail
      .filter((s) =>
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.code || '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [query, services, selectedIds]);
  const selected = selectedIds
    .map((id) => services.find((s) => s._id === id))
    .filter(Boolean);
  return (
    <div className="space-y-1 mt-1">
      <div className="relative">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          placeholder="Buscar servicio..."
          className="w-full border border-slate-200 rounded-xl px-2 py-1.5 text-xs bg-white"
        />
        {open && matches.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white border border-emerald-100 rounded-lg shadow-md">
            {matches.map((s) => (
              <button
                type="button"
                key={s._id}
                onMouseDown={(e) => { e.preventDefault(); onAdd(s._id); setQuery(''); setOpen(false); }}
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-emerald-50 bg-white border-none cursor-pointer flex justify-between"
              >
                <span>{s.name}</span>
                <span className="text-slate-400">${Number(s.salePrice || 0).toFixed(2)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((s) => (
            <span key={s._id} className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-[11px] px-2 py-0.5 rounded-full">
              {s.name}
              <button type="button" onClick={() => onRemove(s._id)} className="text-emerald-700 bg-transparent border-none cursor-pointer">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotationFromChatModal({ conv, services, onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const addProduct = (productId) => {
    if (items.some((i) => String(i.product) === String(productId))) return;
    const p = services.find((s) => s._id === productId);
    setItems((prev) => [
      ...prev,
      {
        product: productId,
        name: p?.name || '',
        quantity: 1,
        unitPrice: Number(p?.salePrice || 0),
        discount: 0,
      },
    ]);
  };

  const removeProduct = (productId) => {
    setItems((prev) => prev.filter((i) => String(i.product) !== String(productId)));
  };

  const updateItem = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const totals = useMemo(() => {
    let subtotal = 0;
    let discountTotal = 0;
    items.forEach((it) => {
      const base = Number(it.unitPrice || 0) * Number(it.quantity || 0);
      const discPct = Math.min(Math.max(Number(it.discount || 0), 0), 100);
      subtotal += base;
      discountTotal += base * (discPct / 100);
    });
    return { subtotal, discountTotal, total: subtotal - discountTotal };
  }, [items]);

  const submit = async () => {
    if (items.length === 0) return toast.error('Agrega al menos un ítem');
    try {
      setSaving(true);
      await api.post(`/chats/${conv._id}/quotation`, {
        items: items.map((i) => ({
          product: i.product,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          discount: i.discount,
        })),
        validUntil: validUntil || undefined,
        notes,
      });
      onCreated();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al crear cotización');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Crear cotización y enviar al chat" onClose={onClose} size="lg">
      <div className="space-y-3 text-sm">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
          Cliente: <strong>{conv.contactName || conv.phone}</strong>
          <div className="text-amber-700/70 mt-0.5">Se enviará un mensaje con el enlace al PDF en este chat.</div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600">Agregar producto/servicio</label>
          <ChatServicePicker
            services={services}
            selectedIds={items.map((i) => i.product)}
            onAdd={addProduct}
            onRemove={removeProduct}
          />
        </div>

        {items.length > 0 && (
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="tbl text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-2 py-1.5">Ítem</th>
                  <th className="text-center px-2 py-1.5 w-12">Cant.</th>
                  <th className="text-right px-2 py-1.5 w-20">P. Unit</th>
                  <th className="text-right px-2 py-1.5 w-14">Desc.%</th>
                  <th className="px-1 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={it.product} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">{it.name}</td>
                    <td className="px-2 py-1.5">
                      <NumericInput min="1" value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                        className="w-full border border-slate-200 rounded px-1 py-0.5 text-center" />
                    </td>
                    <td className="px-2 py-1.5">
                      <NumericInput step="0.01" value={it.unitPrice}
                        onChange={(e) => updateItem(idx, { unitPrice: Number(e.target.value) })}
                        className="w-full border border-slate-200 rounded px-1 py-0.5 text-right" />
                    </td>
                    <td className="px-2 py-1.5">
                      <NumericInput min="0" max="100" value={it.discount}
                        onChange={(e) => updateItem(idx, { discount: Number(e.target.value) })}
                        className="w-full border border-slate-200 rounded px-1 py-0.5 text-right" />
                    </td>
                    <td className="px-1 py-1.5 text-center">
                      <button type="button" onClick={() => removeProduct(it.product)} className="text-rose-600 bg-transparent border-none cursor-pointer">
                        <HiOutlineTrash className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="bg-emerald-50 px-3 py-2 text-right space-y-0.5">
              <div className="text-xs text-slate-600">Subtotal: ${totals.subtotal.toFixed(2)}</div>
              <div className="text-xs text-slate-600">Descuento: -${totals.discountTotal.toFixed(2)}</div>
              <div className="text-sm font-bold text-emerald-700">Total: ${totals.total.toFixed(2)}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-slate-600">Válida hasta</label>
            <input type="date" value={validUntil} min={today} onChange={(e) => setValidUntil(e.target.value)} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600">Notas (opcional)</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 bg-white">Cancelar</button>
          <button onClick={submit} disabled={saving || items.length === 0}
            className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 border-none cursor-pointer">
            {saving ? 'Enviando…' : 'Crear y enviar al chat'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
