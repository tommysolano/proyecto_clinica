import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import NumericInput from '../components/NumericInput';
import useDebounce from '../hooks/useDebounce';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import SriStatus from '../components/SriStatus';
import {
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
  HiOutlineArrowUturnLeft,
  HiOutlineMicrophone,
  HiOutlinePhone,
  HiOutlineArrowLeft,
  HiOutlineInformationCircle,
  HiOutlineBarsArrowDown,
  HiOutlineBarsArrowUp,
  HiOutlinePhoto,
  HiOutlineEllipsisHorizontal,
  HiOutlineEnvelopeOpen,
  HiOutlineUserPlus,
  HiOutlineUsers,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import SameSlotPanel from '../components/SameSlotPanel';
import TagEditor from '../components/TagEditor';
import { fmtDate, fmtDateTime, todayEc, nowEcHHMM } from '../utils/date';
import { imageFromClipboard, imageFileToDataUrl, pastedImageName, readFileAsDataUrl } from '../utils/chatMedia';
import useVoiceRecorder, { formatDuration } from '../hooks/useVoiceRecorder';
import useWhatsappCall from '../hooks/useWhatsappCall';
import CallPanel from '../components/CallPanel';
import ChatComposerToolbar from '../components/ChatComposerToolbar';
import { renderWhatsappText } from '../utils/whatsappText';

// Etiquetas de los disparadores (para mostrar los flujos en el menú de
// automatizaciones del compositor).
const TRIGGER_LABELS_CHAT = {
  appointment_created: 'Cita agendada',
  appointment_confirmed: 'Cita confirmada',
  appointment_rescheduled: 'Cita reagendada',
  appointment_attended: 'Cita asistida',
  appointment_no_show: 'No asistió',
  appointment_cancelled: 'Cita cancelada',
  treatment_abandoned: 'Tratamiento abandonado',
  patient_birthday: 'Cumpleaños',
  patient_created: 'Paciente creado',
  sale_created: 'Venta registrada',
  payment_received: 'Pago recibido',
  quotation_sent: 'Cotización enviada',
  inbound_message: 'Mensaje entrante',
  keyword: 'Palabra clave',
  new_conversation: 'Nueva conversación',
  tag_added: 'Etiqueta añadida',
  ctwa_ad: 'Anuncio Meta',
};

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
  return new Date(date).toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit' });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// El número de este chat es QR (WhatsApp Web). `effectiveConnectionType` lo
// resuelve el backend: el del número asignado, o el del número por defecto si el
// chat no tiene uno. Los chats viejos sin número asignado ya no se tratan por
// error como Cloud API (que era lo que cerraba la ventana indebidamente).
function isQrConversation(conv) {
  return conv?.effectiveConnectionType === 'qr' || conv?.whatsappAccount?.connectionType === 'qr';
}

function getWindow24hExpiresAt(conv) {
  if (!conv || conv.channel !== 'whatsapp') return null;
  // Fuente de verdad = último ENTRANTE (sobrevive a los mensajes salientes). Se
  // toma el máximo de todo lo disponible para no cerrar una ventana viva.
  const times = [];
  if (conv.window24hExpiresAt) times.push(new Date(conv.window24hExpiresAt).getTime());
  if (conv.lastInboundAt) times.push(new Date(conv.lastInboundAt).getTime() + DAY_MS);
  if (!times.length && conv.lastMessageDirection === 'in' && conv.lastMessageAt) {
    times.push(new Date(conv.lastMessageAt).getTime() + DAY_MS);
  }
  return times.length ? new Date(Math.max(...times)) : null;
}

function isWhatsappWindowClosed(conv) {
  if (!conv || conv.channel !== 'whatsapp') return false;
  // Los números QR (WhatsApp Web) no tienen ventana de 24h: se puede escribir siempre.
  if (isQrConversation(conv)) return false;
  const expiresAt = getWindow24hExpiresAt(conv);
  return !expiresAt || expiresAt.getTime() <= Date.now();
}

function isOptedOut(conv) {
  const marketing = conv?.patient?.marketing;
  return Boolean(marketing?.optOutAt || marketing?.whatsappOptIn === false);
}

// Rellena las variables {{nombre}}/{{apellido}}/{{nombre_completo}} de un
// mensaje guardado con los datos del contacto de la conversación.
function fillSavedVariables(text, conv) {
  const first = conv?.patient?.firstName || (conv?.contactName || '').trim().split(/\s+/)[0] || '';
  const last = conv?.patient?.lastName || '';
  const full = `${first} ${last}`.trim() || conv?.contactName || '';
  return String(text || '')
    .replace(/\{\{\s*(nombre|nombres|firstname|name)\s*\}\}/gi, first)
    .replace(/\{\{\s*(apellido|apellidos|lastname)\s*\}\}/gi, last)
    .replace(/\{\{\s*(nombre_?completo|fullname)\s*\}\}/gi, full);
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
  // Rango del panel de Supervisión. Por defecto, el mes en curso (hora Ecuador).
  const [statsRange, setStatsRange] = useState(() => ({ from: `${todayEc().slice(0, 7)}-01`, to: todayEc() }));
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [templateDraft, setTemplateDraft] = useState({ name: '', language: 'es', vars: '' });
  const [templates, setTemplates] = useState([]); // plantillas WhatsApp aprobadas
  // Menú unificado del compositor: null (cerrado) | 'auto' | 'templates' | 'saved'
  const [pickerTab, setPickerTab] = useState(null);
  const [pickerQuery, setPickerQuery] = useState(''); // buscador del menú (por pestaña)
  const [chatWorkflows, setChatWorkflows] = useState([]); // automatizaciones activas (disparo manual)
  const [runningWf, setRunningWf] = useState(false);
  // Mensajes guardados y galería
  const [savedReplies, setSavedReplies] = useState([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  // Adjunto (imagen/video/audio) preparado desde un mensaje guardado, pegado del
  // portapapeles o grabado como nota de voz; se envía junto con el texto.
  const [attachmentDraft, setAttachmentDraft] = useState(null);
  const [attachingMedia, setAttachingMedia] = useState(false);
  // Mensaje al que se está respondiendo (cita estilo WhatsApp).
  const [replyDraft, setReplyDraft] = useState(null);
  const composerRef = useRef(null);

  // Al pulsar "responder" el cursor pasa directo al editor: sin este foco había
  // que hacer clic en el cuadro antes de poder escribir.
  useEffect(() => {
    if (replyDraft) composerRef.current?.focus();
  }, [replyDraft]);
  const [gallery, setGallery] = useState([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [opportunityModal, setOpportunityModal] = useState(false);
  const [appointmentModal, setAppointmentModal] = useState(false);
  const [quotationModal, setQuotationModal] = useState(false);
  // Panel de info del contacto como cajón lateral cuando la columna derecha
  // no cabe (pantallas pequeñas / sidebar del sistema abierto).
  const [infoOpen, setInfoOpen] = useState(false);
  // Orden de la lista: 'recent' = destacados arriba + actividad más nueva primero;
  // 'oldest' = puro orden de llegada (el que más tiempo lleva esperando, primero).
  const [sortOrder, setSortOrder] = useState(() => localStorage.getItem('chats.sortOrder') || 'recent');
  const toggleSortOrder = () => {
    const next = sortOrder === 'recent' ? 'oldest' : 'recent';
    setSortOrder(next);
    localStorage.setItem('chats.sortOrder', next);
  };
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

  // Parámetros de /chats según la pestaña activa. La pestaña "Todos" excluye los
  // destacados: éstos viven solo en su propia pestaña (no anclan la lista general).
  const paramsForTab = (q = debouncedSearch) => {
    const params = {};
    if (tab === 'mine') params.assigned = 'me';
    else if (tab === 'featured') params.featured = 'true';
    else if (tab === 'opportunities') params.opportunity = 'true';
    else if (tab === 'unread') params.unread = 'true';
    // "Todos" oculta los destacados (viven en su pestaña), salvo al buscar: una
    // búsqueda debe poder encontrar a cualquiera, esté destacado o no.
    else if (tab === 'all' && !q) params.excludeFeatured = 'true';
    if (q) params.q = q;
    return params;
  };

  const loadStats = async (range = statsRange) => {
    try {
      const r = await api.get('/chats/stats', {
        params: { ...(range?.from ? { from: range.from } : {}), ...(range?.to ? { to: range.to } : {}) },
      });
      setStats(r.data);
    } catch {
      /* noop */
    }
  };

  const loadMessages = async (id) => {
    try {
      const r = await api.get(`/chats/${id}/messages`);
      setMessages(r.data || []);
      // Abrir un chat NO lo marca como leído: el badge de "no leído" permanece
      // hasta que el agente responda (ver sendMessage). Así no se pierde el
      // pendiente al saltar entre conversaciones.
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
    api.get('/chats/workflows-list').then((r) => setChatWorkflows(r.data || [])).catch(() => {});
    api.get('/call-center/agents').then((r) => setAgents(r.data || [])).catch(() => {});
    // Plantillas WhatsApp aprobadas por Meta (para enviar desde el chat),
    // más usadas primero (el menú muestra el top 4 por defecto).
    api
      .get('/message-templates', { params: { channel: 'whatsapp', status: 'approved' } })
      .then((r) => setTemplates((r.data || []).slice().sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))))
      .catch(() => {});
    loadStats();
  }, []);

  useEffect(() => {
    loadConversations(paramsForTab());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, debouncedSearch]);

  useEffect(() => {
    if (activeId) loadMessages(activeId);
    else setMessages([]);
    setTemplateDraft({ name: '', language: 'es', vars: '' });
    setAttachmentDraft(null);
    setReplyDraft(null);
  }, [activeId]);

  // Realtime — recargar al recibir cambios
  useSocketEvent(
    'chat:message',
    (payload) => {
      if (payload?.conversationId && String(payload.conversationId) === String(activeId)) {
        loadMessages(activeId);
      }
      loadConversations(paramsForTab());
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
      loadConversations(paramsForTab());
    },
    [tab, debouncedSearch]
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
  // Lista según el orden elegido. El backend manda destacados arriba + recientes
  // primero; 'oldest' reordena aquí por llegada pura (sin anclar destacados).
  const sortedConversations = useMemo(() => {
    if (sortOrder !== 'oldest') return conversations;
    return [...conversations].sort(
      (a, b) => new Date(a.lastMessageAt || 0) - new Date(b.lastMessageAt || 0)
    );
  }, [conversations, sortOrder]);
  const activeWindowClosed = isWhatsappWindowClosed(activeConv);
  const activeOptedOut = isOptedOut(activeConv);
  // El compositor de texto está inhabilitado cuando no se puede escribir libre:
  // contacto bloqueado, ventana de 24h cerrada, opt-out, plantilla seleccionada
  // o una nota de voz preparada (que se envía sola).
  const composerDisabled =
    !!activeConv?.blocked || activeWindowClosed || activeOptedOut ||
    !!templateDraft.name || attachmentDraft?.type === 'audio';

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
    // Una nota de voz viaja sola: WhatsApp no admite pie de texto en un audio.
    // Si había algo escrito se deja en el cuadro para enviarlo aparte, en vez de
    // perderlo en silencio (el proveedor descartaría el caption).
    const isVoice = attachmentDraft?.type === 'audio';
    const body = isVoice ? '' : draft.trim();
    const templateName = templateDraft.name.trim();
    // Si hay una plantilla seleccionada se envía como plantilla (sirve tanto dentro
    // como fuera de la ventana de 24h). Si no, se envía texto libre (solo dentro).
    const useTemplate = !!templateName;
    if (!useTemplate && windowClosed) {
      toast.error('Ventana de 24h cerrada: selecciona una plantilla aprobada');
      return;
    }
    if (!useTemplate && !body && !attachmentDraft) return;
    if (!useTemplate && !isVoice) setDraft('');
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
        : {
            body,
            ...(attachmentDraft
              ? { mediaUrl: attachmentDraft.url, mediaType: attachmentDraft.type || 'image' }
              : {}),
            ...(replyDraft ? { replyTo: replyDraft._id } : {}),
          };
      const r = await api.post(`/chats/${activeId}/messages`, payload);
      setMessages((prev) => [...prev, r.data]);
      const preview = r.data.body || (useTemplate ? `[Plantilla: ${templateName}]` : body);
      setConversations((prev) =>
        prev.map((c) =>
          c._id === activeId
            ? {
                ...c,
                lastMessagePreview: preview.slice(0, 140),
                lastMessageAt: r.data.createdAt,
                lastMessageDirection: 'out',
                // Responder limpia el pendiente de no leído (igual que el backend).
                unreadCount: 0,
              }
            : c
        )
      );
      if (r.data.deliveryStatus === 'failed') {
        toast.error(r.data.errorMessage || 'No se pudo enviar');
      } else if (useTemplate) {
        setTemplateDraft({ name: '', language: 'es', vars: '' });
      }
      if (!useTemplate) {
        setAttachmentDraft(null);
        setReplyDraft(null);
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar');
      if (!windowClosed && !isVoice) setDraft(body);
    }
  };

  // Sube un adjunto ya leído como data URL y lo deja preparado en el composer.
  // Devuelve true si quedó listo. El uploader es el mismo que usan los mensajes
  // guardados: almacena la media y devuelve una URL pública que ambos gateways
  // (Cloud API y QR) saben resolver.
  const attachMedia = async ({ dataUrl, name, type }) => {
    setAttachingMedia(true);
    try {
      const { data } = await api.post('/chats/saved-replies/upload', { name, dataUrl });
      setAttachmentDraft({ url: data.url, type: data.type || type, name: data.name || name });
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || 'No se pudo adjuntar');
      return false;
    } finally {
      setAttachingMedia(false);
    }
  };

  // Pegar una imagen del portapapeles (Ctrl+V) igual que en WhatsApp Web: se sube
  // y queda como adjunto; el texto que se escriba será su pie de foto. Si lo
  // pegado no es una imagen se deja pasar el pegado normal del textarea.
  const handleComposerPaste = async (e) => {
    const file = imageFromClipboard(e);
    if (!file) return;
    e.preventDefault();
    if (attachingMedia) return;
    try {
      const dataUrl = await imageFileToDataUrl(file);
      await attachMedia({ dataUrl, name: pastedImageName(file), type: 'image' });
    } catch (err) {
      toast.error(err.message || 'No se pudo pegar la imagen');
    }
  };

  // Nota de voz: al soltar el botón se sube y queda preparada; el servidor la
  // convierte a ogg/opus para que WhatsApp la reproduzca como nota de voz.
  const recorder = useVoiceRecorder({
    onRecorded: async (blob) => {
      try {
        const dataUrl = await readFileAsDataUrl(blob);
        await attachMedia({ dataUrl, name: `nota-de-voz-${Date.now()}.ogg`, type: 'audio' });
      } catch (err) {
        toast.error(err.message || 'No se pudo preparar la nota de voz');
      }
    },
  });

  const startRecording = async () => {
    try {
      await recorder.start();
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Una nota de voz se envía sola: en WhatsApp un audio no admite pie de texto.
  const voiceNoteAttached = attachmentDraft?.type === 'audio';

  // Llamadas de voz por WhatsApp. `calling` dice si el número de ESTE chat puede
  // llamar (solo Cloud API, y con las llamadas habilitadas en Meta); se consulta
  // al abrir el chat para no ofrecer un botón que fallaría al pulsarlo.
  const voiceCall = useWhatsappCall();
  const [calling, setCalling] = useState(null);
  useEffect(() => {
    if (!activeId) return setCalling(null);
    setCalling(null);
    let cancelled = false;
    api
      .get(`/chats/${activeId}/calling-status`)
      .then(({ data }) => { if (!cancelled) setCalling(data); })
      .catch(() => { if (!cancelled) setCalling({ enabled: false, reason: 'No se pudo comprobar si este número puede llamar.' }); });
    return () => { cancelled = true; };
  }, [activeId]);

  // Inserta un mensaje guardado: reemplaza el token "/atajo" (o añade al final),
  // rellena variables con el contacto y prepara el adjunto si lo tiene.
  const insertSavedReply = (r) => {
    const body = fillSavedVariables(r.body, activeConv);
    setDraft((prev) => {
      const lastSlashAt = prev.lastIndexOf('/');
      if (lastSlashAt >= 0 && (lastSlashAt === 0 || /\s/.test(prev[lastSlashAt - 1]))) {
        return prev.slice(0, lastSlashAt) + body;
      }
      return prev ? `${prev} ${body}` : body;
    });
    if (r.attachment?.url) {
      setAttachmentDraft({
        url: r.attachment.url,
        type: r.attachment.type || 'image',
        name: r.attachment.name || r.title || 'adjunto',
      });
    }
    setSlashOpen(false);
    setSlashQuery('');
    setPickerTab(null);
    // Contador "más usados" (ordena el menú); no bloquea la inserción.
    api.post(`/chats/saved-replies/${r._id}/used`).catch(() => {});
    setSavedReplies((prev) => prev.map((x) => (x._id === r._id ? { ...x, usageCount: (x.usageCount || 0) + 1 } : x)));
  };

  // Disparo MANUAL de una automatización para este chat (cuando el disparo
  // automático no salió). Confirma antes: cada mensaje tiene costo.
  const runWorkflowForChat = async (wf, flow) => {
    if (!activeConv || runningWf) return;
    const flowLabel = (flow.triggerTypes || []).map((t) => TRIGGER_LABELS_CHAT[t] || t).join(' / ');
    if (!window.confirm(`¿Ejecutar la automatización "${wf.name}"${flowLabel ? ` (${flowLabel})` : ''} para este chat?`)) return;
    setRunningWf(true);
    try {
      const r = await api.post(`/chats/${activeConv._id}/run-workflow`, {
        workflowId: wf._id,
        startNodeId: flow.startNodeId,
      });
      if (r.data.warning) {
        toast(`Ejecutada, pero un paso falló: ${r.data.warning}`, { icon: '⚠️', duration: 8000 });
      } else if (r.data.status === 'waiting') {
        toast.success('Automatización iniciada: quedó en espera de su próximo paso.');
      } else {
        toast.success('Automatización ejecutada.');
      }
      setPickerTab(null);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al ejecutar la automatización');
    } finally {
      setRunningWf(false);
    }
  };

  const toggleFeatured = async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/featured`, {
        isFeatured: !conv.isFeatured,
      });
      // Los destacados no salen en "Todos" y sí en "Destacados": al marcar/quitar,
      // el chat entra o sale de la pestaña actual (no solo cambia su estrella).
      setConversations((prev) => {
        if (tab === 'all' && r.data.isFeatured) return prev.filter((c) => c._id !== conv._id);
        if (tab === 'featured' && !r.data.isFeatured) return prev.filter((c) => c._id !== conv._id);
        return prev.map((c) => (c._id === conv._id ? r.data : c));
      });
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

  // Salta al mensaje original citado y lo resalta un instante.
  const scrollToMessage = (id) => {
    if (!id) return;
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-emerald-400', 'rounded-lg');
    setTimeout(() => el.classList.remove('ring-2', 'ring-emerald-400', 'rounded-lg'), 1600);
  };

  // Marca el chat como leído SIN responder: quita la notificación de no leído.
  const markRead = async (conv) => {
    try {
      await api.post(`/chats/${conv._id}/read`);
      setConversations((prev) => prev.map((c) => (c._id === conv._id ? { ...c, unreadCount: 0 } : c)));
      // Si estamos en la pestaña "No leídos", el chat ya no pertenece ahí.
      if (tab === 'unread') {
        setConversations((prev) => prev.filter((c) => c._id !== conv._id));
      }
      toast.success('Marcado como leído');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo marcar como leído');
    }
  };

  // Habilita las llamadas del número Cloud API de este chat (acción de admin).
  const enableCalling = async () => {
    if (!activeId) return;
    try {
      await api.post(`/chats/${activeId}/calling-enable`);
      toast.success('Llamadas habilitadas. Puede tardar unos minutos en activarse en WhatsApp.');
      // Reconsultar el estado para refrescar el botón de llamar.
      const { data } = await api.get(`/chats/${activeId}/calling-status`);
      setCalling(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudieron habilitar las llamadas');
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
    <div className="@container h-[calc(100vh-96px)] sm:h-[calc(100vh-112px)] lg:h-[calc(100vh-128px)] flex flex-col">
      {/* Barra de pestañas + acciones (el título va en la cabecera del sistema) */}
      <div className="flex items-center justify-between gap-2 mb-2 border-b border-slate-200">
        <div className="flex gap-1 flex-wrap">
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
      </div>

      {tab === 'board' ? (
        <SupervisorBoard
          stats={stats}
          reload={() => loadStats()}
          agents={agents}
          range={statsRange}
          onRangeChange={(next) => { setStatsRange(next); loadStats(next); }}
        />
      ) : (
        // Columnas según el ancho REAL disponible (container queries, no viewport):
        // - angosto: una sola vista (lista O conversación, estilo WhatsApp móvil)
        // - medio (≥768px de contenedor): lista + conversación; la info va en un cajón
        // - ancho (≥1280px de contenedor): las 3 columnas de siempre
        <div className="flex-1 grid grid-cols-1 @3xl:grid-cols-[280px_minmax(0,1fr)] @7xl:grid-cols-[300px_minmax(0,1fr)_320px] grid-rows-[minmax(0,1fr)] gap-3 min-h-0">
          {/* Lista de conversaciones */}
          <div className={`bg-white border border-slate-200 rounded-xl flex-col overflow-hidden min-h-0 ${activeId ? 'hidden @3xl:flex' : 'flex'}`}>
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
                onClick={toggleSortOrder}
                className={`p-1.5 rounded-lg ${sortOrder === 'oldest' ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100' : 'text-slate-500 hover:bg-slate-50'}`}
                title={sortOrder === 'oldest'
                  ? 'Orden: primeros en llegar primero (orden de llegada). Clic para ver los más recientes primero.'
                  : 'Orden: últimos en llegar primero (destacados arriba). Clic para atender por orden de llegada.'}
              >
                {sortOrder === 'oldest' ? (
                  <HiOutlineBarsArrowUp className="w-4 h-4" />
                ) : (
                  <HiOutlineBarsArrowDown className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => loadConversations(paramsForTab())}
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
                sortedConversations.map((c) => (
                  <ConversationRow
                    key={c._id}
                    conv={c}
                    active={c._id === activeId}
                    onClick={() => setActiveId(c._id)}
                    onToggleFeatured={() => toggleFeatured(c)}
                    onMarkRead={() => markRead(c)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Panel principal de mensajes */}
          <div className={`bg-white border border-slate-200 rounded-xl flex-col overflow-hidden min-h-0 min-w-0 ${activeId ? 'flex' : 'hidden @3xl:flex'}`}>
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
                  onMarkRead={() => markRead(activeConv)}
                  onEnableCalling={enableCalling}
                  isAdmin={isAdmin}
                  meId={user?._id}
                  calling={calling}
                  onCall={() => voiceCall.startCall(activeConv)}
                  onBack={() => setActiveId(null)}
                  onToggleInfo={() => setInfoOpen(true)}
                />
                <div ref={messagesEndRef} className="flex-1 overflow-y-auto bg-slate-50 p-4 space-y-2">
                  {messages.map((m) => (
                    <MessageBubble
                      key={m._id}
                      msg={m}
                      onReply={() => setReplyDraft(m)}
                      onJumpTo={scrollToMessage}
                    />
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
                  {/* Respondiendo a un mensaje específico (cita) */}
                  {replyDraft && (
                    <div className="mb-2 flex items-stretch gap-2 bg-slate-50 border-l-4 border-emerald-500 rounded-lg pl-2 pr-2 py-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1">
                          <HiOutlineArrowUturnLeft className="w-3 h-3" />
                          Respondiendo a {replyDraft.direction === 'out' ? (replyDraft.sentByName || 'ti') : (activeConv?.contactName || 'contacto')}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {replyDraft.body || (replyDraft.mediaType ? `[${replyDraft.mediaType}]` : 'Mensaje')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setReplyDraft(null)}
                        title="Cancelar respuesta"
                        className="text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer self-center"
                      >
                        <HiOutlineXMark className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  {/* Subiendo un adjunto pegado o grabado */}
                  {attachingMedia && !attachmentDraft && (
                    <div className="mb-2 flex items-center gap-2 border border-slate-200 bg-slate-50 rounded-lg px-2.5 py-1.5">
                      <HiOutlineArrowPath className="w-4 h-4 text-slate-400 animate-spin" />
                      <span className="text-xs text-slate-500">Subiendo adjunto…</span>
                    </div>
                  )}
                  {/* Adjunto preparado (mensaje guardado, imagen pegada o nota de voz) */}
                  {attachmentDraft && (
                    <div className="mb-2 flex items-center gap-2 border border-emerald-200 bg-emerald-50/60 rounded-lg px-2.5 py-1.5">
                      {attachmentDraft.type === 'image' ? (
                        <img src={attachmentDraft.url} alt="adjunto" className="w-8 h-8 rounded object-cover" />
                      ) : (
                        <span className="text-lg">
                          {attachmentDraft.type === 'video' ? '🎬' : attachmentDraft.type === 'audio' ? '🎤' : '📎'}
                        </span>
                      )}
                      {voiceNoteAttached ? (
                        <>
                          <audio controls src={attachmentDraft.url} className="h-8 flex-1 max-w-[260px]" />
                          <span className="text-[11px] text-emerald-700 hidden sm:inline">
                            Se enviará como nota de voz
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-emerald-800 truncate flex-1">
                          Se enviará con adjunto: {attachmentDraft.name}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setAttachmentDraft(null)}
                        className="text-xs text-slate-500 hover:text-rose-600 bg-transparent border-none cursor-pointer flex items-center gap-0.5"
                      >
                        <HiOutlineXMark className="w-3.5 h-3.5" /> Quitar
                      </button>
                    </div>
                  )}
                  {!recorder.recording && (
                    <ChatComposerToolbar
                      composerRef={composerRef}
                      value={draft}
                      onChange={setDraft}
                      disabled={composerDisabled}
                    />
                  )}
                  <div className="relative">
                    {slashOpen && (
                      <div className="absolute bottom-full left-0 mb-1 w-72 max-w-[92vw] max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30">
                        {savedReplies
                          .filter((r) => !slashQuery || r.shortcut.includes(slashQuery) || (r.title || '').toLowerCase().includes(slashQuery))
                          .slice(0, 20)
                          .map((r) => (
                            <button
                              key={r._id}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                insertSavedReply(r);
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-slate-50 text-sm bg-white cursor-pointer"
                            >
                              <div className="font-semibold text-emerald-700 text-xs flex items-center gap-1">
                                /{r.shortcut}
                                {r.title && <span className="text-slate-500 font-normal truncate">· {r.title}</span>}
                                {r.attachment?.url && (
                                  <span title="Con adjunto">{r.attachment.type === 'video' ? '🎬' : '🖼'}</span>
                                )}
                              </div>
                              <div className="text-slate-600 text-xs truncate">{r.body}</div>
                            </button>
                          ))}
                        {savedReplies.length === 0 && (
                          <div className="px-3 py-2 text-xs text-slate-400">
                            Sin mensajes guardados. Configúralos en{' '}
                            <Link
                              to="/saved-replies"
                              className="underline text-emerald-700"
                              onMouseDown={(e) => e.stopPropagation()}
                            >Marketing → Mensajes Guardados</Link>.
                          </div>
                        )}
                      </div>
                    )}
                    {pickerTab && (
                      <div className="absolute bottom-full left-0 mb-1 w-96 max-w-[92vw] max-h-80 flex flex-col bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
                        <div className="flex border-b border-slate-100 bg-white shrink-0">
                          {[
                            ['auto', '⚡ Automatizaciones'],
                            ['templates', '📄 Plantillas'],
                            ['saved', '/ Guardados'],
                          ].map(([k, label]) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => { setPickerTab(k); setPickerQuery(''); }}
                              className={`flex-1 px-2 py-2 text-xs font-semibold border-none cursor-pointer ${pickerTab === k ? 'bg-emerald-50 text-emerald-700 border-b-2 border-emerald-500' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="p-2 border-b border-slate-100 shrink-0">
                          <input
                            autoFocus
                            value={pickerQuery}
                            onChange={(e) => setPickerQuery(e.target.value)}
                            placeholder={
                              pickerTab === 'auto'
                                ? 'Buscar automatización…'
                                : pickerTab === 'templates'
                                  ? 'Buscar plantilla…'
                                  : 'Buscar mensaje guardado…'
                            }
                            className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs"
                          />
                        </div>
                        <div className="overflow-y-auto">
                          {pickerTab === 'auto' && (
                            <>
                              <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-50">
                                Ejecuta un flujo a mano para este chat (p. ej. si el disparo automático no salió).
                                Si el paciente tiene una próxima cita, sus datos se usan en las variables y esperas.
                              </div>
                              {(() => {
                                const q = pickerQuery.trim().toLowerCase();
                                const rows = [];
                                chatWorkflows.forEach((wf) => wf.flows.forEach((flow, fi) => rows.push({ wf, flow, fi })));
                                const shown = q
                                  ? rows.filter(({ wf, flow }) =>
                                      wf.name.toLowerCase().includes(q) ||
                                      (wf.folder || '').toLowerCase().includes(q) ||
                                      (flow.triggerTypes || []).some((t) => (TRIGGER_LABELS_CHAT[t] || t).toLowerCase().includes(q))
                                    ).slice(0, 30)
                                  : rows.slice(0, 4); // top 4 más usadas
                                if (rows.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">
                                    No hay automatizaciones activas. Créalas en Marketing → Workflows.
                                  </div>
                                );
                                if (shown.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">Sin resultados para "{pickerQuery}".</div>
                                );
                                return (
                                  <>
                                    {shown.map(({ wf, flow, fi }) => (
                                      <button
                                        key={`${wf._id}-${flow.startNodeId || fi}`}
                                        type="button"
                                        disabled={runningWf}
                                        onMouseDown={(e) => { e.preventDefault(); runWorkflowForChat(wf, flow); }}
                                        className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-slate-50 text-sm bg-white cursor-pointer disabled:opacity-50"
                                      >
                                        <div className="font-semibold text-slate-700 text-xs flex items-center gap-1.5">
                                          ⚡ {wf.name}
                                          {wf.flows.length > 1 && (
                                            <span className="text-[10px] text-slate-400 font-normal">· flujo {fi + 1}</span>
                                          )}
                                        </div>
                                        <div className="text-slate-500 text-[11px] truncate">
                                          {(flow.triggerTypes || []).map((t) => TRIGGER_LABELS_CHAT[t] || t).join(' / ') || 'Sin disparador'}
                                          <span className="text-slate-300"> · {wf.folder}</span>
                                        </div>
                                      </button>
                                    ))}
                                    {!q && rows.length > 4 && (
                                      <div className="px-3 py-1.5 text-[10px] text-slate-400">
                                        Mostrando las 4 más usadas de {rows.length} — escribe arriba para buscar el resto.
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                            </>
                          )}
                          {pickerTab === 'templates' && (
                            <>
                              <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-50">
                                Plantillas aprobadas por Meta (funcionan aun fuera de la ventana de 24h).
                              </div>
                              {(() => {
                                const q = pickerQuery.trim().toLowerCase();
                                const shown = q
                                  ? templates.filter((t) => t.name.toLowerCase().includes(q) || (t.body || '').toLowerCase().includes(q)).slice(0, 30)
                                  : templates.slice(0, 4); // top 4 más usadas
                                if (templates.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">
                                    No hay plantillas aprobadas. Créalas y apruébalas en Plantillas / Sincroniza con Meta.
                                  </div>
                                );
                                if (shown.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">Sin resultados para "{pickerQuery}".</div>
                                );
                                return (
                                  <>
                                    {shown.map((t) => (
                                      <button
                                        key={t._id}
                                        type="button"
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          setTemplateDraft({ name: t.name, language: t.language || 'es', vars: '' });
                                          setPickerTab(null);
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
                                    {!q && templates.length > 4 && (
                                      <div className="px-3 py-1.5 text-[10px] text-slate-400">
                                        Mostrando las 4 más usadas de {templates.length} — escribe arriba para buscar el resto.
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                            </>
                          )}
                          {pickerTab === 'saved' && (
                            <>
                              <div className="px-3 py-2 text-[11px] text-slate-400 border-b border-slate-50">
                                También puedes escribir "/" en el mensaje para buscarlos al vuelo.
                              </div>
                              {(() => {
                                const q = pickerQuery.trim().toLowerCase();
                                const shown = q
                                  ? savedReplies.filter((r) =>
                                      r.shortcut.includes(q) ||
                                      (r.title || '').toLowerCase().includes(q) ||
                                      (r.body || '').toLowerCase().includes(q)
                                    ).slice(0, 30)
                                  : savedReplies.slice(0, 4); // top 4 más usados
                                if (savedReplies.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">
                                    Sin mensajes guardados. Configúralos en Marketing → Mensajes Guardados.
                                  </div>
                                );
                                if (shown.length === 0) return (
                                  <div className="px-3 py-3 text-xs text-slate-400">Sin resultados para "{pickerQuery}".</div>
                                );
                                return (
                                  <>
                                    {shown.map((r) => (
                                      <button
                                        key={r._id}
                                        type="button"
                                        onMouseDown={(e) => { e.preventDefault(); insertSavedReply(r); }}
                                        className="w-full text-left px-3 py-2 hover:bg-emerald-50 border-b border-slate-50 text-sm bg-white cursor-pointer"
                                      >
                                        <div className="font-semibold text-emerald-700 text-xs flex items-center gap-1">
                                          /{r.shortcut}
                                          {r.title && <span className="text-slate-500 font-normal truncate">· {r.title}</span>}
                                          {r.attachment?.url && (
                                            <span title="Con adjunto">{r.attachment.type === 'video' ? '🎬' : '🖼'}</span>
                                          )}
                                        </div>
                                        <div className="text-slate-600 text-xs truncate">{r.body}</div>
                                      </button>
                                    ))}
                                    {!q && savedReplies.length > 4 && (
                                      <div className="px-3 py-1.5 text-[10px] text-slate-400">
                                        Mostrando los 4 más usados de {savedReplies.length} — escribe arriba para buscar el resto.
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Fila 1: el cuadro de texto ocupa TODO el ancho (o el indicador de grabación) */}
                    {recorder.recording ? (
                      <div className="w-full flex items-center gap-2 border border-rose-200 bg-rose-50 rounded-xl px-3.5 py-3">
                        <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse flex-shrink-0" />
                        <span className="text-sm font-semibold text-rose-700 tabular-nums">
                          {formatDuration(recorder.seconds)}
                        </span>
                        <span className="text-xs text-rose-500 truncate">Grabando nota de voz…</span>
                      </div>
                    ) : (
                      <textarea
                        ref={composerRef}
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
                        onPaste={handleComposerPaste}
                        placeholder={
                          templateDraft.name
                            ? 'Se enviará la plantilla seleccionada…'
                            : voiceNoteAttached
                              ? 'Una nota de voz se envía sola, sin texto'
                              : 'Escribe un mensaje…   ·   / para guardados   ·   pega una imagen'
                        }
                        rows={2}
                        disabled={composerDisabled}
                        className="w-full min-h-[52px] max-h-40 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-y disabled:bg-slate-100"
                      />
                    )}
                    {/* Fila 2: acciones, debajo del cuadro y con todo el ancho disponible */}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      {recorder.recording ? (
                        <>
                          <button
                            type="button"
                            onClick={recorder.cancel}
                            title="Descartar la grabación"
                            className="p-2 bg-white border border-slate-200 text-slate-500 rounded-xl hover:text-rose-600 hover:border-rose-300 cursor-pointer flex items-center"
                          >
                            <HiOutlineTrash className="w-5 h-5" />
                          </button>
                          <button
                            type="button"
                            onClick={recorder.stop}
                            title="Detener y adjuntar la nota de voz"
                            className="ml-auto px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 cursor-pointer flex items-center gap-1.5"
                          >
                            <HiOutlineCheckCircle className="w-5 h-5" />
                            <span className="text-sm font-medium">Adjuntar</span>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setGalleryOpen(true)}
                            title="Galería de imágenes"
                            className="p-2 bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 hover:border-emerald-300 cursor-pointer flex items-center"
                          >
                            <HiOutlinePhoto className="w-5 h-5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setPickerTab((v) => (v ? null : 'auto')); setPickerQuery(''); }}
                            title="Automatizaciones, plantillas y mensajes guardados"
                            className={`p-2 border rounded-xl cursor-pointer disabled:opacity-50 flex items-center ${pickerTab || templateDraft.name ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-emerald-300'}`}
                          >
                            <HiOutlinePlus className="w-5 h-5" />
                          </button>
                          <button
                            type="button"
                            onClick={startRecording}
                            disabled={
                              !!activeConv?.blocked || activeWindowClosed || activeOptedOut ||
                              !!templateDraft.name || attachingMedia || !!attachmentDraft
                            }
                            title="Grabar una nota de voz"
                            className="p-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-50 cursor-pointer flex items-center"
                          >
                            <HiOutlineMicrophone className="w-5 h-5" />
                          </button>
                          <button
                            type="button"
                            onClick={suggestReply}
                            disabled={suggesting || !!activeConv?.blocked || activeOptedOut || activeWindowClosed || voiceNoteAttached}
                            title="Sugerir respuesta con IA"
                            className="p-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:border-emerald-400 disabled:opacity-50 cursor-pointer flex items-center gap-1"
                          >
                            <HiOutlineSparkles className="w-5 h-5" />
                            <span className="hidden @sm:inline text-xs font-medium">{suggesting ? '…' : 'IA'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={sendMessage}
                            disabled={
                              !!activeConv?.blocked ||
                              activeOptedOut ||
                              attachingMedia ||
                              (templateDraft.name.trim()
                                ? false
                                : activeWindowClosed
                                  ? true
                                  : !draft.trim() && !attachmentDraft)
                            }
                            className="ml-auto px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                          >
                            <HiOutlinePaperAirplane className="w-5 h-5" />
                            <span className="text-sm font-medium">Enviar</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Panel lateral derecho - info y oportunidad (columna fija solo en ancho) */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-y-auto p-3 hidden @7xl:block">
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

          {/* Cajón de info del contacto cuando la columna derecha no cabe */}
          {infoOpen && activeConv && (
            <div className="fixed inset-0 z-40 @7xl:hidden" onClick={() => setInfoOpen(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div
                className="absolute right-0 top-0 bottom-0 w-[340px] max-w-[92vw] bg-white shadow-2xl overflow-y-auto p-3"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-end mb-1">
                  <button
                    onClick={() => setInfoOpen(false)}
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer"
                    title="Cerrar"
                  >
                    <HiOutlineXMark className="w-5 h-5" />
                  </button>
                </div>
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
              </div>
            </div>
          )}
        </div>
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
      {/* Fuera del chat activo a propósito: una llamada entrante debe sonar
          aunque el agente esté mirando otra conversación. */}
      <CallPanel
        call={voiceCall.call}
        seconds={voiceCall.seconds}
        muted={voiceCall.muted}
        onAccept={voiceCall.acceptCall}
        onReject={voiceCall.rejectCall}
        onHangUp={voiceCall.hangUp}
        onToggleMute={voiceCall.toggleMute}
      />
    </div>
  );
}

// ============= Modales nuevos =============

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

function ConversationRow({ conv, active, onClick, onToggleFeatured, onMarkRead }) {
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkRead?.();
                }}
                title="Marcar como leído"
                className="bg-emerald-600 text-white text-[10px] rounded-full px-1.5 min-w-[18px] text-center border-none cursor-pointer hover:bg-emerald-700 flex items-center gap-0.5 group/unread"
              >
                <HiOutlineEnvelopeOpen className="w-3 h-3 hidden group-hover/unread:inline" />
                <span className="group-hover/unread:hidden">{conv.unreadCount}</span>
                <span className="hidden group-hover/unread:inline">Leído</span>
              </button>
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

// Menú desplegable de acciones (⋯) para pantallas estrechas: agrupa todas las
// acciones del chat que no caben en la barra. Cierra al elegir o al hacer clic
// fuera. Se usa cuando la cabecera no tiene ancho para mostrarlas en línea.
function HeaderActionsMenu({ actions }) {
  const [open, setOpen] = useState(false);
  if (!actions.length) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer"
        title="Más acciones"
      >
        <HiOutlineEllipsisHorizontal className="w-5 h-5" />
      </button>
      {open && (
        <>
          {/* Fondo transparente para cerrar al hacer clic fuera. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-56 max-w-[80vw] bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 overflow-hidden">
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={() => { setOpen(false); a.onClick(); }}
                className="w-full text-left px-3 py-2 text-sm bg-white hover:bg-slate-50 border-none cursor-pointer flex items-center gap-2 text-slate-700"
              >
                <a.icon className={`w-4 h-4 shrink-0 ${a.iconClass || 'text-slate-400'}`} />
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChatHeader({ conv, onToggleFeatured, onTake, onAutoAssign, onOpenOpportunity, onCreateAppointment, onCreateQuotation, onMarkRead, onEnableCalling, isAdmin, meId, calling, onCall, onBack, onToggleInfo }) {
  const canTake = !conv.assignedTo || String(conv.assignedTo._id || conv.assignedTo) !== String(meId);
  // "Esperando respuesta" cuando el último mensaje es entrante (del paciente).
  const waitingReply = conv.lastMessageDirection === 'in';
  // Un admin puede encender las llamadas de un número Cloud API que las tiene
  // apagadas (sin entrar a Meta). Por QR es imposible: no se ofrece.
  const canEnableCalls = isAdmin && calling && calling.enabled === false && calling.canEnable;

  // Acciones secundarias: en línea en pantallas anchas, en el menú "⋯" cuando no
  // caben. Una sola fuente de verdad para ambos modos.
  const actions = [
    canTake && { key: 'take', label: 'Tomar', icon: HiOutlineUserPlus, onClick: onTake },
    onAutoAssign && { key: 'auto', label: 'Auto-asignar', icon: HiOutlineUsers, onClick: onAutoAssign },
    {
      key: 'opp',
      label: conv.opportunity?.isOpportunity ? 'Editar / añadir oportunidad' : 'Crear oportunidad',
      icon: HiOutlineTag,
      iconClass: 'text-emerald-600',
      onClick: onOpenOpportunity,
    },
    conv.patient && { key: 'appt', label: 'Crear cita', icon: HiOutlineCalendarDays, iconClass: 'text-indigo-600', onClick: onCreateAppointment },
    { key: 'quote', label: 'Cotización', icon: HiOutlineDocumentDuplicate, iconClass: 'text-amber-600', onClick: onCreateQuotation },
    conv.unreadCount > 0 && { key: 'read', label: 'Marcar como leído', icon: HiOutlineEnvelopeOpen, onClick: onMarkRead },
    canEnableCalls && { key: 'enablecall', label: 'Habilitar llamadas', icon: HiOutlinePhone, iconClass: 'text-emerald-600', onClick: onEnableCalling },
  ].filter(Boolean);

  return (
    <div className="border-b border-slate-100 p-3 flex items-center gap-2">
      {onBack && (
        <button
          onClick={onBack}
          className="@3xl:hidden p-1.5 -ml-1 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer shrink-0"
          title="Volver a la lista"
        >
          <HiOutlineArrowLeft className="w-5 h-5" />
        </button>
      )}
      <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold shrink-0">
        {(conv.contactName || conv.phone || '?').slice(0, 2).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-slate-800 flex items-center gap-2">
          <span className="truncate">{conv.contactName || conv.phone}</span>
          {waitingReply && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 shrink-0 hidden @xl:inline" title="El paciente espera respuesta">
              Esperando respuesta
            </span>
          )}
          {conv.unreadCount > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-600 text-white shrink-0" title="Mensajes sin leer">
              {conv.unreadCount}
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 truncate">
          {conv.phone}
          {conv.patient && (
            <span className="ml-2 text-emerald-700">· Paciente vinculado</span>
          )}
          {conv.assignedToName && (
            <span className="ml-2">· Agente: {conv.assignedToName}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Llamar por WhatsApp. Solo los números Cloud API pueden llamar: si el
            chat usa un número QR o Meta no tiene las llamadas habilitadas, el
            botón queda deshabilitado explicando por qué en vez de fallar al pulsar. */}
        <button
          onClick={onCall}
          disabled={!calling?.enabled || conv.blocked}
          title={conv.blocked ? 'Contacto bloqueado' : calling?.enabled ? 'Llamar por WhatsApp' : (calling?.reason || 'Comprobando si este número puede llamar…')}
          className="text-xs px-2 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed border-none cursor-pointer flex items-center gap-1 shrink-0"
        >
          <HiOutlinePhone className="w-4 h-4" /> <span className="hidden @5xl:inline">Llamar</span>
        </button>

        {/* Acciones en línea (solo icono + tooltip) cuando hay ancho (≥ @5xl).
            Se mantienen sin texto para que nunca desborden la columna: la versión
            con etiquetas está en el menú "⋯" de pantallas estrechas. */}
        <div className="hidden @5xl:flex items-center gap-1">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={a.onClick}
              title={a.label}
              className="p-1.5 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-lg border-none cursor-pointer flex items-center shrink-0"
            >
              <a.icon className={`w-4 h-4 ${a.iconClass || ''}`} />
            </button>
          ))}
        </div>

        <button
          onClick={onToggleFeatured}
          className={`p-1.5 rounded-lg shrink-0 ${conv.isFeatured ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
          title={conv.isFeatured ? 'Quitar destacado' : 'Marcar destacado'}
        >
          {conv.isFeatured ? (
            <HiStar className="w-4 h-4 text-amber-500" />
          ) : (
            <HiOutlineStar className="w-4 h-4 text-slate-400" />
          )}
        </button>
        {onToggleInfo && (
          <button
            onClick={onToggleInfo}
            className="@7xl:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer shrink-0"
            title="Info del contacto y oportunidad"
          >
            <HiOutlineInformationCircle className="w-4 h-4" />
          </button>
        )}

        {/* Menú "⋯" con las acciones, SOLO en pantallas estrechas (< @5xl). */}
        <div className="@5xl:hidden">
          <HeaderActionsMenu actions={actions} />
        </div>
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

// Tamaño de archivo legible (para la tarjeta de documento).
function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Emoji según la extensión del documento, para que se reconozca de un vistazo.
function docIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return '📊';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📝';
  if (['pdf'].includes(ext)) return '📕';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📈';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return '🗜️';
  return '📄';
}

function MessageMedia({ msg, isOut }) {
  const url = msg.mediaUrl;
  const type = msg.mediaType || '';
  if (!url) {
    // Media que no se pudo descargar/guardar: al menos indicar qué era.
    if (type) {
      return (
        <div className={`text-xs italic mb-1 ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {type === 'document' ? (msg.mediaName || 'Documento') : type} (no disponible)
        </div>
      );
    }
    return null;
  }
  const isImage = type === 'image' || /^data:image\//.test(url);
  const isSticker = type === 'sticker';
  const isAudio = type === 'audio' || /^data:audio\//.test(url);
  const isVideo = type === 'video' || /^data:video\//.test(url);

  // Sticker: pequeño y sin marco (como en WhatsApp), fondo transparente.
  if (isSticker) {
    return <img src={url} alt="sticker" className="max-h-28 w-auto mb-1 block bg-transparent" />;
  }
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block mb-1">
        <img src={url} alt="adjunto" className="rounded-lg max-h-60 w-auto block" />
      </a>
    );
  }
  if (isVideo) {
    return <video controls src={url} className="rounded-lg max-h-60 w-auto mb-1 block max-w-full" />;
  }
  if (isAudio) {
    return <audio controls src={url} className="mb-1 w-full max-w-[240px]" />;
  }
  // Documento: tarjeta con icono, nombre y tamaño (como WhatsApp), no un genérico
  // "Ver adjunto". El nombre real llega en `mediaName`.
  const name = msg.mediaName || 'Documento';
  const size = formatFileSize(msg.mediaSize);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={name}
      className={`flex items-center gap-2 mb-1 rounded-lg px-2.5 py-2 no-underline ${
        isOut ? 'bg-emerald-600/40 hover:bg-emerald-600/60' : 'bg-slate-100 hover:bg-slate-200'
      }`}
    >
      <span className="text-2xl leading-none shrink-0">{docIcon(name)}</span>
      <span className="min-w-0">
        <span className={`block text-xs font-semibold truncate ${isOut ? 'text-white' : 'text-slate-700'}`}>
          {name}
        </span>
        <span className={`block text-[10px] ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {size ? `${size} · ` : ''}Descargar
        </span>
      </span>
    </a>
  );
}

// Botón "responder" que aparece al pasar el cursor sobre la burbuja.
function ReplyButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Responder a este mensaje"
      className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 w-7 h-7 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-500 hover:text-emerald-600 hover:border-emerald-300 cursor-pointer"
    >
      <HiOutlineArrowUturnLeft className="w-3.5 h-3.5" />
    </button>
  );
}

// Traduce el resultado real de la cita ('failed:<motivo>') a un texto corto.
// Solo se muestra cuando la respuesta NO llegó citada al destinatario.
function quoteFailureText(code) {
  const reason = String(code || '').replace(/^failed:/, '');
  let base = 'Se envió sin la cita en WhatsApp.';
  if (reason.startsWith('no_wamid')) base = 'Se envió sin la cita: el mensaje original no tiene ID de WhatsApp.';
  else if (reason.startsWith('library_dropped')) base = 'Se envió sin la cita: WhatsApp no permitió citar ese mensaje.';
  else if (reason.startsWith('not_found')) base = 'Se envió sin la cita: no se encontró el mensaje original en WhatsApp.';
  else if (reason.startsWith('reply_error')) base = 'Se envió sin la cita: el envío citando falló.';
  // El código técnico permite diagnosticar el paso exacto desde una captura.
  return `${base} (${reason.slice(0, 90)})`;
}

function MessageBubble({ msg, onReply, onJumpTo }) {
  const isOut = msg.direction === 'out';
  // Etiqueta de remitente: quién envió el mensaje (agente con acceso al chat, o
  // "Automático" para flujos, o "WhatsApp (teléfono)" si se envió desde el móvil
  // fuera del sistema). Solo en salientes.
  const senderLabel = isOut
    ? (msg.origin === 'phone' ? '📱 WhatsApp (teléfono)' : msg.sentByName || (msg.isAutoReply ? 'Automático' : 'Equipo'))
    : null;
  const reply = msg.replyTo && (msg.replyTo.body || msg.replyTo.mediaType || msg.replyTo.senderName)
    ? msg.replyTo
    : null;
  return (
    <div className={`group flex items-center gap-1.5 ${isOut ? 'justify-end' : 'justify-start'}`}>
      {isOut && <ReplyButton onClick={onReply} />}
      <div
        id={`msg-${msg._id}`}
        className={`max-w-[85%] @3xl:max-w-[70%] rounded-lg px-3 py-2 text-sm shadow-sm transition-shadow ${
          isOut ? 'bg-emerald-500 text-white' : 'bg-white border border-slate-200 text-slate-800'
        }`}
      >
        {senderLabel && (
          <div className={`text-[11px] font-semibold mb-1 flex items-center gap-1 ${isOut ? 'text-white/95' : 'text-emerald-700'}`}>
            <HiOutlineUserCircle className="w-3.5 h-3.5" /> {senderLabel}
          </div>
        )}
        {/* Mensaje citado (respuesta a uno específico): clic para saltar al original */}
        {reply && (
          <button
            type="button"
            onClick={() => onJumpTo?.(reply.message)}
            className={`w-full text-left mb-1 rounded-md border-l-4 pl-2 pr-2 py-1 cursor-pointer ${
              isOut ? 'bg-emerald-600/40 border-white/70' : 'bg-slate-100 border-emerald-500'
            }`}
          >
            <div className={`text-[10px] font-semibold ${isOut ? 'text-white/90' : 'text-emerald-700'}`}>
              {reply.senderName || 'Mensaje'}
            </div>
            <div className={`text-[11px] truncate ${isOut ? 'text-white/80' : 'text-slate-500'}`}>
              {reply.body || (reply.mediaType ? `[${reply.mediaType}]` : 'Mensaje')}
            </div>
          </button>
        )}
        {/* La cita se verificó tras el envío y NO llegó aplicada a WhatsApp */}
        {reply && isOut && String(msg.quoteResult || '').startsWith('failed') && (
          <div className="text-[10px] mb-1 flex items-start gap-1 text-amber-100 bg-amber-500/30 rounded px-1.5 py-0.5">
            <HiOutlineExclamationTriangle className="w-3 h-3 shrink-0 mt-px" />
            <span>{quoteFailureText(msg.quoteResult)}</span>
          </div>
        )}
        <MessageMedia msg={msg} isOut={isOut} />
        {msg.templateName && (
          <div className={`text-[10px] font-medium mb-0.5 ${isOut ? 'text-emerald-100' : 'text-slate-500'}`}>
            Plantilla · {msg.templateName}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{renderWhatsappText(msg.body)}</div>
        <div className={`text-[10px] mt-1 flex items-center gap-1 ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {formatTime(msg.createdAt)}
          {isOut && <span>·</span>}
          {isOut && <DeliveryBadge msg={msg} />}
        </div>
      </div>
      {!isOut && <ReplyButton onClick={onReply} />}
    </div>
  );
}

function SidePanel({ conv, agents = [], meId, onUpdated, onEditOpportunity, onScheduleAppointment, onCreateQuotation }) {
  const op = conv.opportunity || {};
  const meta = op.isOpportunity ? stageMeta(op.stage) : null;
  const [registerModal, setRegisterModal] = useState(false);
  const [appts, setAppts] = useState([]);
  const [resched, setResched] = useState(null); // cita a reagendar
  const [apptsVersion, setApptsVersion] = useState(0); // fuerza recarga tras reagendar

  // Cargar citas del paciente vinculado para mostrar cuántas tiene y sus fechas.
  // clinic=all: el chat es global, la cita puede ser de cualquier sucursal.
  useEffect(() => {
    if (!conv.patient?._id && !conv.patient) {
      setAppts([]);
      return;
    }
    const pid = conv.patient?._id || conv.patient;
    api
      .get('/appointments', { params: { patient: pid, limit: 100, clinic: 'all' } })
      .then((r) => setAppts(Array.isArray(r.data) ? r.data : r.data?.appointments || []))
      .catch(() => setAppts([]));
  }, [conv.patient, apptsVersion]);

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
        {(() => {
          // Todas las oportunidades del chat (una por anuncio/interés). El campo
          // `opportunity` es solo el espejo de la última; aquí se listan todas.
          const opsList = (conv.opportunities || []).length
            ? conv.opportunities
            : op.isOpportunity
            ? [op]
            : [];
          return (
            <>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold text-slate-500">
                  Oportunidades{opsList.length > 0 ? ` (${opsList.length})` : ''}
                </div>
                <button onClick={onEditOpportunity} className="text-[10px] text-emerald-600 hover:underline">
                  {opsList.length > 0 ? 'Editar / añadir' : 'Crear'}
                </button>
              </div>
              {opsList.length === 0 ? (
                <div className="text-xs text-slate-400">No es una oportunidad aún.</div>
              ) : (
                <div className="space-y-2">
                  {opsList.map((o, idx) => {
                    const m = STAGES.find((s) => s.value === o.stage) || STAGES[0];
                    return (
                      <div key={idx} className="border border-slate-100 rounded-lg p-2 space-y-1 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`inline-block text-[11px] px-2 py-0.5 rounded ${m.color}`}>{m.label}</span>
                          {o.expectedValue > 0 && (
                            <span className="text-[11px] text-slate-500">${o.expectedValue}</span>
                          )}
                        </div>
                        {(o.attribution?.adId || o.attribution?.campaign) && (
                          <div className="text-[10px] text-violet-700 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5 inline-block">
                            📣 {o.attribution.campaign || `Anuncio ${o.attribution.adId}`}
                          </div>
                        )}
                        {(o.interestedIn || []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {(o.interestedIn || []).map((s, i) => (
                              <span key={i} className="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">
                                {s.name || s.product?.name}
                              </span>
                            ))}
                          </div>
                        )}
                        {(o.tags || []).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {o.tags.map((t) => (
                              <span key={t} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                                <HiOutlineTag className="w-2.5 h-2.5" />{t}
                              </span>
                            ))}
                          </div>
                        )}
                        {o.notes && <div className="text-xs text-slate-500 italic">"{o.notes}"</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
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
                  // Una cita ya atendida/cobrada no se reagenda desde el chat.
                  const canResched = !['completada', 'asistida'].includes(a.status);
                  return (
                    <li key={a._id} className="text-xs text-slate-600 flex items-center justify-between gap-1 bg-slate-50 rounded px-2 py-1">
                      <span>
                        {dd}/{mm}/{dt.getFullYear()} · {a.startTime}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] uppercase tracking-wide text-slate-400">
                          {a.status}
                        </span>
                        {canResched && (
                          <button
                            type="button"
                            title="Reagendar esta cita"
                            onClick={() => setResched(a)}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-none cursor-pointer"
                          >
                            Reagendar
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}

      {resched && (
        <RescheduleApptModal
          appt={resched}
          onClose={() => setResched(null)}
          onSaved={() => {
            setResched(null);
            setApptsVersion((v) => v + 1);
          }}
        />
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

  // Autocompletado por cédula/RUC desde el SRI (nombres/apellidos).
  const cedulaLookup = useSriLookup(form.cedula, {
    onData: (d, prev) => {
      setForm((f) => ({
        ...f,
        firstName: fillField(f.firstName, d.found ? d.firstName || '' : '', prev?.firstName),
        lastName: fillField(f.lastName, d.found ? d.lastName || '' : '', prev?.lastName),
      }));
    },
  });

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
            <label className="text-xs font-semibold text-slate-600 block mb-1">Cédula / Pasaporte (opcional)</label>
            <input value={form.cedula} onChange={(e) => setForm({ ...form, cedula: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" maxLength={20} />
            <SriStatus status={cedulaLookup} />
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
      attribution: op.attribution || null, // solo lectura: anuncio de origen
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-emerald-700 flex items-center gap-2 min-w-0">
                Oportunidad #{idx + 1}
                {(it.attribution?.adId || it.attribution?.campaign) && (
                  <span className="text-[10px] font-normal text-violet-700 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5 truncate">
                    📣 {it.attribution.campaign || `Anuncio ${it.attribution.adId}`}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeOne(idx, it._existingIdx)}
                className="text-rose-600 text-xs bg-transparent border-none cursor-pointer shrink-0"
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

// Atajos del filtro de fechas del panel (en hora Ecuador).
function rangePresets() {
  const today = todayEc();
  const shift = (days) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  };
  return [
    { label: 'Hoy', from: today, to: today },
    { label: 'Últimos 7 días', from: shift(6), to: today },
    { label: 'Este mes', from: `${today.slice(0, 7)}-01`, to: today },
    { label: 'Últimos 30 días', from: shift(29), to: today },
    { label: 'Todo', from: '', to: '' },
  ];
}

// Minutos → texto corto ("45 min", "2 h 10 min"): un chat respondido al día
// siguiente en minutos no se lee.
function fmtMinutes(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

function SupervisorBoard({ stats, reload, agents = [], range, onRangeChange }) {
  const byAgent = stats?.byAgent || [];
  const opps = stats?.opportunities || [];
  const responseTimes = stats?.responseTimes || [];
  const appointments = stats?.appointments || { created: 0, attended: 0 };
  const sla = stats?.sla || { thresholdMinutes: 60, unanswered: 0 };
  const presets = rangePresets();
  const activePreset = presets.find((p) => p.from === (range?.from || '') && p.to === (range?.to || ''));

  return (
    <div className="flex-1 overflow-y-auto space-y-4">
      {/* Filtro de fechas: aplica a todo el panel */}
      <section className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onRangeChange({ from: p.from, to: p.to })}
              className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer ${
                activePreset?.label === p.label
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <input
            type="date"
            value={range?.from || ''}
            max={range?.to || undefined}
            onChange={(e) => onRangeChange({ ...range, from: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1 text-xs"
          />
          <span className="text-xs text-slate-400">a</span>
          <input
            type="date"
            value={range?.to || ''}
            min={range?.from || undefined}
            onChange={(e) => onRangeChange({ ...range, to: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1 text-xs"
          />
          <button onClick={reload} className="text-xs text-slate-500 hover:underline ml-1 bg-transparent border-none cursor-pointer">
            Recargar
          </button>
        </div>
      </section>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard label="Chats abiertos" value={stats?.byStatus?.find((s) => s._id === 'open')?.count || 0} color="emerald" />
        <KPICard
          label={`Sin responder (>${sla.thresholdMinutes}m)`}
          value={sla.unanswered || 0}
          color={sla.unanswered > 0 ? 'rose' : 'slate'}
        />
        <KPICard label="Citas creadas" value={appointments.created || 0} color="indigo" />
        <KPICard label="Citas asistidas" value={appointments.attended || 0} color="emerald" />
        <KPICard label="Oportunidades" value={opps.reduce((a, x) => a + x.count, 0)} color="indigo" />
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-slate-800">Por agente</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Agente</th>
                <th className="text-right px-3 py-2">Total chats</th>
                <th className="text-right px-3 py-2">Abiertos</th>
                <th className="text-right px-3 py-2">Sin responder</th>
                <th className="text-right px-3 py-2">Citas creadas</th>
                <th className="text-right px-3 py-2">Asistidas</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.map((a) => (
                <tr key={a._id || 'unassigned'} className="border-t border-slate-100">
                  <td className={`px-3 py-2 font-medium ${a._id ? '' : 'text-slate-400 italic'}`}>{a.name}</td>
                  <td className="px-3 py-2 text-right">{a.total}</td>
                  <td className="px-3 py-2 text-right">{a.open}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={a.unanswered > 0 ? 'text-rose-600 font-bold' : 'text-slate-400'}>
                      {a.unanswered}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">{a.appointmentsCreated}</td>
                  <td className="px-3 py-2 text-right text-emerald-700 font-bold">{a.appointmentsAttended}</td>
                </tr>
              ))}
              {byAgent.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-slate-400 text-sm">
                    Sin actividad en este periodo
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          <strong>Sin responder</strong>: chats abiertos de ese agente cuyo último mensaje es del paciente,
          esperando respuesta ahora mismo (la tarjeta de arriba cuenta solo los que ya pasaron de{' '}
          {sla.thresholdMinutes} min). Los chats que aún no tiene nadie salen en la fila{' '}
          <em>Sin asignar</em>. En <strong>citas</strong> solo se cuentan las agendadas{' '}
          <strong>desde un chat</strong>.
        </p>
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
                      {fmtMinutes(r.avgMinutes)}
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

/**
 * Reagendar una cita del paciente desde el chat. Envía PUT /appointments/:id
 * con ?clinic=<sucursal de la cita> (el chat es global: la cita puede ser de
 * otra sede). El backend valida no-pasado, registra el reagendamiento en el
 * historial y re-sincroniza los recordatorios de workflows pendientes.
 */
function RescheduleApptModal({ appt, onClose, onSaved }) {
  const toYmd = (v) => {
    const d = new Date(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const [date, setDate] = useState(() => toYmd(appt.date));
  const [startTime, setStartTime] = useState(appt.startTime || '09:00');
  const [saving, setSaving] = useState(false);
  const today = todayEc();

  const save = async () => {
    if (!date || !startTime) return toast.error('Fecha y hora requeridas');
    setSaving(true);
    try {
      // Mantener la duración original: si la cita tenía hora de fin, se desplaza.
      const toMin = (s) => {
        const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      };
      const s0 = toMin(appt.startTime);
      const e0 = toMin(appt.endTime);
      const s1 = toMin(startTime);
      const payload = { date, startTime };
      if (s0 != null && e0 != null && s1 != null && e0 > s0) {
        const e1 = Math.min(23 * 60 + 59, s1 + (e0 - s0));
        payload.endTime = `${String(Math.floor(e1 / 60)).padStart(2, '0')}:${String(e1 % 60).padStart(2, '0')}`;
      }
      await api.put(`/appointments/${appt._id}`, payload, { params: { clinic: appt.clinic } });
      toast.success('Cita reagendada');
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al reagendar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Reagendar cita" onClose={onClose} size="sm">
      <div className="p-4 space-y-3">
        <p className="text-xs text-slate-500">
          Cita actual: <b className="text-slate-700">{toYmd(appt.date).split('-').reverse().join('/')} · {appt.startTime}</b>
          <span className="ml-1 uppercase text-[10px] tracking-wide text-slate-400">({appt.status})</span>
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-slate-600">Nueva fecha</label>
            <input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Nueva hora</label>
            <input
              type="time"
              value={startTime}
              min={date === today ? nowEcHHMM() : undefined}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white text-sm"
            />
          </div>
        </div>
        {['cancelada', 'no_asistio'].includes(appt.status) && (
          <p className="text-[11px] text-slate-400">
            Al reagendar, la cita vuelve a estado <b>pendiente</b>.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-slate-200 bg-white cursor-pointer">Cancelar</button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-sm bg-emerald-600 text-white border-none cursor-pointer disabled:opacity-60"
          >
            {saving ? 'Guardando…' : 'Reagendar'}
          </button>
        </div>
      </div>
    </ModalShell>
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
  const today = todayEc();
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
                  <input type="date" value={it.date} min={today} onChange={(e) => updateItem(idx, { date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Hora</label>
                  <input type="time" value={it.startTime} min={it.date === today ? nowEcHHMM() : undefined} onChange={(e) => updateItem(idx, { startTime: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
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
  const today = todayEc();
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
