import { useEffect, useMemo, useRef, useState, useCallback, memo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
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
  HiOutlineChevronUp,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
  HiOutlineArrowPath,
  HiOutlinePlus,
  HiOutlineBackspace,
  HiOutlineTag,
  HiOutlineCalendarDays,
  HiOutlineUserCircle,
  HiOutlineXMark,
  HiOutlineCheckCircle,
  HiOutlineCheck,
  HiOutlineClock,
  HiOutlinePaperClip,
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
  HiOutlineEnvelope,
  HiOutlineEnvelopeOpen,
  HiOutlineEye,
  HiOutlineUserPlus,
  HiOutlineUsers,
  HiOutlinePlay,
  HiOutlinePause,
  HiOutlinePencilSquare,
  HiOutlineUser,
  HiOutlineChartBar,
  HiOutlineBolt,
  HiOutlineArrowDownTray,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent, useSocket } from '../context/SocketContext';
import SameSlotPanel from '../components/SameSlotPanel';
import TimeSlotInput from '../components/TimeSlotInput';
import ServiceItemPicker from '../components/ServiceItemPicker';
import TagEditor from '../components/TagEditor';
import SuggestInput from '../components/SuggestInput';
import WhatsappButtons from '../components/WhatsappButtons';
import { fmtDate, fmtDateTime, todayEc, nowEcHHMM } from '../utils/date';
import { imageFromClipboard, imageFileToDataUrl, pastedImageName, readFileAsDataUrl } from '../utils/chatMedia';
import useVoiceRecorder, { formatDuration } from '../hooks/useVoiceRecorder';
import useWhatsappCall from '../hooks/useWhatsappCall';
import CallPanel from '../components/CallPanel';
import ChatComposerToolbar from '../components/ChatComposerToolbar';
import { renderWhatsappText } from '../utils/whatsappText';
import { downloadFromUrl, triggerAnchorDownload, triggerBlobDownload } from '../utils/download';
import { ENROLL_STATUS, STEP_LABELS } from '../utils/workflowLabels';
import DateInput from '../components/DateInput';
import DateTimeInput from '../components/DateTimeInput';

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

// Clave YYYY-MM-DD en hora de Ecuador, para agrupar mensajes por día.
function ecDateKey(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
}

// Etiqueta del separador de día en el chat, estilo WhatsApp: "Hoy", "Ayer", el
// día de la semana ("Sábado", "Miércoles") si fue en los últimos 7 días, o la
// fecha corta (12/05/2026) si es más antiguo. Sin esto un mensaje viejo parecía
// de hoy (confundía con la ventana de 24h de WhatsApp).
function formatDateDivider(date) {
  const key = ecDateKey(date);
  const todayKey = ecDateKey(new Date());
  if (key === todayKey) return 'Hoy';
  const yesterdayKey = ecDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  if (key === yesterdayKey) return 'Ayer';
  // Diferencia en días entre fechas EC (los keys YYYY-MM-DD se parsean a UTC 00:00).
  const diffDays = Math.round((Date.parse(todayKey) - Date.parse(key)) / (24 * 60 * 60 * 1000));
  if (diffDays > 1 && diffDays < 7) {
    return new Date(date).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', weekday: 'long' });
  }
  return new Date(date).toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function DateDivider({ date }) {
  return (
    <div className="flex justify-center my-3">
      <span className="text-[11px] font-medium text-slate-500 bg-white border border-slate-200 rounded-full px-3 py-1 shadow-sm capitalize">
        {formatDateDivider(date)}
      </span>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Qué puede enviar de verdad cada canal (lo que el backend sabe entregar de
// verdad — ver server/utils/messaging.js#sendToProvider). Oculta en el
// compositor lo que el canal no soporta, en vez de dejar botones que "parecen"
// funcionar y en realidad no llegan al contacto.
const MEDIA_CHANNELS = ['whatsapp', 'messenger', 'instagram'];
// Meta no tiene plantillas HSM fuera de WhatsApp, pero el TEXTO de la plantilla
// sí se puede mandar como mensaje normal por Messenger/Instagram (ver
// server/utils/messaging.js#sendToProvider). TikTok no es de Meta: sin envío.
const TEMPLATE_CHANNELS = ['whatsapp', 'messenger', 'instagram'];
const CHANNEL_TAB_LABELS = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', tiktok: 'TikTok', sms: 'SMS', web: 'Web' };
function channelSendsMedia(conv) {
  return MEDIA_CHANNELS.includes(conv?.channel || 'whatsapp');
}
function channelSendsTemplates(conv) {
  return TEMPLATE_CHANNELS.includes(conv?.channel || 'whatsapp');
}

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
  // Espejo de `getWhatsappWindowExpiresAt` del servidor: NUNCA se deduce del
  // último mensaje "entrante" por dirección — un chat recién creado por un envío
  // nuestro parecería tener ventana abierta y Meta rechaza el texto libre (131047).
  const times = [];
  if (conv.window24hExpiresAt) times.push(new Date(conv.window24hExpiresAt).getTime());
  if (conv.lastInboundAt) times.push(new Date(conv.lastInboundAt).getTime() + DAY_MS);
  return times.length ? new Date(Math.max(...times)) : null;
}

// Milisegundos que quedan de ventana según el SERVIDOR (o null si no aplica /
// está cerrada). El servidor decide si la ventana APLICA (según el número real
// por el que sale el mensaje) y da el `expiresAt` exacto; el cliente solo compara
// contra el reloj para que un chat abierto mucho rato refleje el cierre en vivo,
// sin recalcular la regla (que antes podía discrepar del backend).
function windowMsRemaining(conv) {
  const w = conv?.window;
  if (w && typeof w.applies === 'boolean') {
    if (!w.applies) return null; // QR u otro canal: sin ventana
    if (!w.expiresAt) return 0; // aplica pero nunca hubo entrante → cerrada
    return new Date(w.expiresAt).getTime() - Date.now();
  }
  return undefined; // sin dato del servidor: usar el respaldo local
}

// Códigos con los que Meta rechaza un TEXTO LIBRE por estar fuera de la ventana
// de 24h (131047 en Cloud API; 470 es el equivalente antiguo). Reintentar el mismo
// mensaje no puede funcionar: solo entra una plantilla aprobada.
const OUT_OF_WINDOW_ERROR_CODES = new Set(['131047', '470']);
const QR_UNCONFIRMED_ERROR_CODES = new Set(['qr_send_unconfirmed', 'qr_media_unconfirmed']);
function isOutOfWindowError(msg) {
  return OUT_OF_WINDOW_ERROR_CODES.has(String(msg?.errorCode || ''));
}

function isQrUnconfirmedError(msg) {
  return QR_UNCONFIRMED_ERROR_CODES.has(String(msg?.errorCode || ''));
}

function isWhatsappWindowClosed(conv) {
  if (!conv || conv.channel !== 'whatsapp') return false;
  const ms = windowMsRemaining(conv);
  if (ms !== undefined) return ms !== null && ms <= 0;
  // Respaldo para respuestas viejas en caché sin `window`: cálculo local.
  if (isQrConversation(conv)) return false;
  const expiresAt = getWindow24hExpiresAt(conv);
  return !expiresAt || expiresAt.getTime() <= Date.now();
}

// Último mensaje ENTRANTE del contacto (fecha), para explicar la ventana.
function lastInboundDate(conv) {
  // Solo un entrante REAL: si no lo hay, el aviso dice "todavía no te ha escrito"
  // en vez de inventarse una fecha a partir del último mensaje.
  const raw = conv?.window?.lastInboundAt || conv?.lastInboundAt || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "hace 3 h", "hace 12 días"… en castellano y sin dependencias.
function humanizeSince(date) {
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'hace unos segundos';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

// "faltan 6 h 12 min" para el tiempo que queda de ventana.
function humanizeRemaining(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Fecha + hora completas: "10 jul 2026, 22:39". Se usa en el aviso de la ventana
// para que "cerrada" venga siempre con el CUÁNDO — en el hilo solo se ve la hora
// y un mensaje de hace dos semanas parece de anoche.
function formatDateTimeEc(date) {
  return new Date(date).toLocaleString('es-EC', {
    timeZone: 'America/Guayaquil',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isOptedOut(conv) {
  const marketing = conv?.patient?.marketing;
  return Boolean(marketing?.optOutAt || marketing?.whatsappOptIn === false);
}

/**
 * ¿El "teléfono" del chat es en realidad el identificador interno de WhatsApp?
 *
 * En los contactos de número oculto (@lid) WhatsApp no comparte el teléfono, y
 * mostrar ese identificador de 15 dígitos como si fuera un número solo confunde:
 * no se puede llamar, ni buscar, ni copiar a ningún lado. Mientras no se resuelva
 * el número real se dice claramente que está oculto.
 */
function isHiddenNumber(conv) {
  const jid = String(conv?.externalUserId || '');
  if (!jid.endsWith('@lid')) return false;
  const lidDigits = jid.replace(/@lid$/, '').replace(/\D/g, '');
  return String(conv?.phone || '').replace(/\D/g, '') === lidDigits;
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
  // Navegación en dos niveles (estilo Daplox):
  //  - `view` (riel izquierdo): 'inbox' (bandeja) | 'opportunities' | 'board'.
  //  - `scope` (riel izquierdo, solo bandeja): 'mine' = solo los asignados a mí,
  //    'all' = bandeja compartida salvo reservas exclusivas de workflow ajenas.
  //  - `filter` (barra superior, solo bandeja): 'all' | 'unread' | 'featured'.
  const [view, setView] = useState('inbox');
  // Parámetros de la URL: sirven para entrar directo a un chat (?phone=…).
  const [urlParams, setUrlParams] = useSearchParams();
  const [scope, setScope] = useState(() => localStorage.getItem('chats.scope') || 'all');
  const [filter, setFilter] = useState('all');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const selectScope = (s) => {
    setView('inbox');
    setScope(s);
    localStorage.setItem('chats.scope', s);
  };
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  // Espejo del chat abierto para leerlo DENTRO de callbacks asíncronos (envío,
  // respuestas que llegan tarde) sin quedarse con el valor viejo del closure.
  const activeIdRef = useRef(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const [messages, setMessages] = useState([]);
  // Buscador DENTRO del chat abierto (estilo WhatsApp): resalta y salta entre
  // coincidencias del mensaje buscado en la conversación activa.
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [chatMatchIdx, setChatMatchIdx] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [stats, setStats] = useState(null);
  // Contadores de chats NO LEÍDOS para los badges del riel (mis chats / grupal).
  const [unreadCounts, setUnreadCounts] = useState({ mine: 0, all: 0, featured: 0, total: 0, totalMine: 0 });
  // Rango del panel de Supervisión. Por defecto, el mes en curso (hora Ecuador).
  const [statsRange, setStatsRange] = useState(() => ({ from: `${todayEc().slice(0, 7)}-01`, to: todayEc() }));
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  // Asesores que están escribiendo AHORA en el chat abierto. Cada entrada es una
  // pestaña/socket; al pintar se de-duplican por usuario.
  const [typingAgents, setTypingAgents] = useState([]);
  const typingExpiryRef = useRef(new Map());
  // Envío en curso: bloquea el botón (ver sendMessage) y pinta "Enviando…".
  const [sending, setSending] = useState(false);
  const [templateDraft, setTemplateDraft] = useState({ name: '', language: 'es', vars: '' });
  const [templates, setTemplates] = useState([]); // plantillas WhatsApp aprobadas
  // Menú unificado del compositor: null (cerrado) | 'auto' | 'templates' | 'saved'
  const [pickerTab, setPickerTab] = useState(null);
  const [pickerQuery, setPickerQuery] = useState(''); // buscador del menú (por pestaña)
  const [chatWorkflows, setChatWorkflows] = useState([]); // automatizaciones activas (disparo manual)
  const [runningWf, setRunningWf] = useState(false);
  // Sube al ejecutar una automatización a mano: refresca la lista del panel derecho.
  const [automationsVersion, setAutomationsVersion] = useState(0);
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
  // Zona del compositor que incluye los menús flotantes (automatizaciones /
  // plantillas / guardados) y el botón que los abre: un clic FUERA los cierra.
  const composerMenusRef = useRef(null);
  // Compositor COMPACTO por defecto (una línea) para ver más mensajes; se EXPANDE
  // (más alto) al enfocarlo o cuando ya hay texto/adjunto, para escribir cómodo
  // mensajes largos — igual que en Daplox.
  const [composerFocused, setComposerFocused] = useState(false);

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
  const [transferModal, setTransferModal] = useState(false);
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
  // Transferir el chat lo puede hacer CUALQUIER usuario de la bandeja; el reparto
  // automático (round-robin) dentro del transferidor sigue siendo de admin/supervisor.
  const canAutoAssign = isSupervisor || isAdmin;

  // ══ LA BANDEJA ENTRA POR PÁGINAS ══
  //
  // Antes se pedían los 300 chats de golpe y la lista no pintaba NADA hasta que
  // llegaban todos: con miles de conversaciones, abrir /chats eran varios segundos
  // de pantalla en blanco. Ahora entran los primeros 25 y el agente pide más solo
  // si baja hasta el final. Los números de las pestañas NO dependen de esto: se
  // cuentan en la base (ver /chats/unread-counts), así que siguen siendo los reales
  // aunque no se haya cargado ni una página más.
  const CHATS_PAGE = 25;
  const [convTotal, setConvTotal] = useState(0);
  const [convHasMore, setConvHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cuántos chats hay pedidos ahora mismo. Una recarga (evento en vivo, volver a
  // la pestaña) tiene que traer LOS MISMOS que había, no volver a 25: si no, la
  // lista se encogía sola en cuanto llegaba un mensaje.
  const convLoadedRef = useRef(CHATS_PAGE);

  // Solo la respuesta de la última búsqueda actualiza la lista: descarta
  // respuestas fuera de orden que sobrescribirían con datos obsoletos.
  const convReqRef = useRef(0);
  const loadConversations = async (params = {}, { append = false } = {}) => {
    const reqId = ++convReqRef.current;
    const skip = append ? conversations.length : 0;
    const limit = append ? CHATS_PAGE : Math.max(CHATS_PAGE, convLoadedRef.current);
    try {
      if (append) setLoadingMore(true);
      else setLoading(true);
      const r = await api.get('/chats', { params: { ...params, limit, skip } });
      if (reqId !== convReqRef.current) return; // respuesta obsoleta: descartar
      // Compat: si el servidor aún devolviera el array pelado (deploy a medias),
      // se trata como una única página completa en vez de romper la bandeja.
      const items = Array.isArray(r.data) ? r.data : r.data?.items || [];
      setConversations((prev) => {
        if (!append) return items;
        // Puede haber solapamiento si entró un mensaje nuevo entre página y
        // página (la lista va por actividad reciente): se de-duplica por id.
        const ids = new Set(prev.map((c) => String(c._id)));
        return [...prev, ...items.filter((c) => !ids.has(String(c._id)))];
      });
      setConvTotal(Array.isArray(r.data) ? items.length : r.data?.total ?? items.length);
      setConvHasMore(Array.isArray(r.data) ? false : !!r.data?.hasMore);
      convLoadedRef.current = skip + items.length;
    } catch (err) {
      if (reqId === convReqRef.current) toast.error(err.response?.data?.message || 'Error al cargar chats');
    } finally {
      if (reqId === convReqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  const loadMoreConversations = () => {
    if (loadingMore || !convHasMore) return;
    loadConversations(paramsForView(), { append: true });
  };

  // Recarga de la lista AGRUPADA: en horas punta entran varios mensajes por
  // segundo y cada uno pedía la lista entera. Se junta todo en una sola petición
  // poco después del último evento, que es lo que de verdad ve el agente.
  const convRefreshTimer = useRef(null);
  const refreshConversations = () => {
    clearTimeout(convRefreshTimer.current);
    convRefreshTimer.current = setTimeout(() => loadConversations(paramsForView()), 400);
  };
  useEffect(() => () => clearTimeout(convRefreshTimer.current), []);

  // Parámetros de /chats según la vista + alcance + filtro activos.
  //  - Oportunidades: todas las conversaciones marcadas como oportunidad.
  //  - Bandeja: el alcance (mine/all) se combina con el filtro superior. El
  //    filtro "Todos" excluye los destacados (viven en su propio filtro), salvo
  //    al buscar: una búsqueda debe encontrar a cualquiera, esté destacado o no.
  const paramsForView = (q = debouncedSearch) => {
    const params = {};
    if (view === 'opportunities') {
      params.opportunity = 'true';
      if (q) params.q = q;
      return params;
    }
    // El orden va al servidor: la lista entra por páginas, así que ordenarla aquí
    // solo ordenaría los 25 cargados (y "el que más tiempo lleva esperando"
    // dejaría fuera precisamente a los que más esperan).
    if (sortOrder === 'oldest') params.sort = 'oldest';
    if (scope === 'mine') params.assigned = 'me';
    if (filter === 'unread') params.unread = 'true';
    else if (filter === 'featured') params.featured = 'true';
    else if (filter === 'all' && !q) params.excludeFeatured = 'true';
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

  // Contadores de no leídos (mis chats / grupal) para los badges del riel. Se
  // recarga en cada evento de chat y al marcar como leído.
  const loadUnreadCounts = async () => {
    try {
      const r = await api.get('/chats/unread-counts');
      setUnreadCounts({
        mine: r.data?.mine || 0,
        all: r.data?.all || 0,
        featured: r.data?.featured || 0,
        total: r.data?.total || 0,
        totalMine: r.data?.totalMine || 0,
      });
    } catch {
      /* noop */
    }
  };

  /**
   * Mensajes guardados y galería. Se RECARGAN cada vez que se abre el selector,
   * no solo al montar la página: si un agente edita un mensaje guardado en la
   * página "Mensajes Guardados" (p.ej. le adjunta un video) mientras tiene el
   * chat abierto en otra pestaña, la copia del chat se quedaba vieja y al
   * insertarlo se enviaba SOLO el texto — el adjunto se perdía en silencio.
   */
  const loadSavedReplies = async () => {
    try {
      const r = await api.get('/chats/saved-replies');
      setSavedReplies(r.data || []);
    } catch {
      /* si falla se mantiene la copia anterior */
    }
  };

  const loadGallery = async () => {
    try {
      const r = await api.get('/chats/gallery');
      setGallery(r.data || []);
    } catch {
      /* noop */
    }
  };

  // Igual que en `loadConversations`: solo la respuesta del ÚLTIMO chat pedido
  // puede pintar. Sin esta guardia, saltar de un chat a otro dejaba la pantalla
  // con los mensajes del anterior: la petición del chat lento llegaba la última y
  // pisaba la del chat que el agente ya tenía abierto. Además se ABORTA la
  // petición que quedó obsoleta, para no gastar la conexión en algo que se va a
  // descartar (el navegador solo permite unas pocas peticiones a la vez).
  const msgReqRef = useRef(0);
  const msgAbortRef = useRef(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  // ¿Quedan mensajes más antiguos por cargar? El hilo trae la última página; los
  // anteriores se piden solo si el agente los pide (ver loadOlderMessages).
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const PAGE_SIZE = 80;

  const loadMessages = async (id, { silent = false } = {}) => {
    const reqId = ++msgReqRef.current;
    msgAbortRef.current?.abort();
    const controller = new AbortController();
    msgAbortRef.current = controller;
    if (!silent) setMessagesLoading(true);
    try {
      const r = await api.get(`/chats/${id}/messages`, {
        params: { limit: PAGE_SIZE },
        signal: controller.signal,
      });
      if (reqId !== msgReqRef.current) return; // respuesta obsoleta: descartar
      const list = r.data || [];
      setMessages(list);
      // Si vino la página entera, es probable que haya conversación más atrás.
      setHasOlder(list.length >= PAGE_SIZE);
      // Abrir un chat NO lo marca como leído: el badge de "no leído" permanece
      // hasta que el agente responda (ver sendMessage). Así no se pierde el
      // pendiente al saltar entre conversaciones.
    } catch (err) {
      // Una petición cancelada al cambiar de chat no es un error que mostrar.
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      if (reqId !== msgReqRef.current) return;
      toast.error(err.response?.data?.message || 'Error al cargar mensajes');
    } finally {
      if (reqId === msgReqRef.current) setMessagesLoading(false);
    }
  };

  /**
   * Trae la página ANTERIOR del hilo y la antepone. El chat abre solo con los
   * últimos mensajes (así entra al instante aunque la conversación tenga años de
   * historia); lo de más atrás se carga bajo demanda. Se conserva la posición de
   * lectura para que al agente no le salte la pantalla.
   */
  const loadOlderMessages = async () => {
    if (!activeId || loadingOlder || !messages.length) return;
    setLoadingOlder(true);
    const box = messagesEndRef.current;
    const prevHeight = box?.scrollHeight || 0;
    try {
      const r = await api.get(`/chats/${activeId}/messages`, {
        params: { limit: PAGE_SIZE, before: messages[0].createdAt },
      });
      const older = r.data || [];
      if (!older.length) {
        setHasOlder(false);
        return;
      }
      setMessages((prev) => [...older, ...prev]);
      setHasOlder(older.length >= PAGE_SIZE);
      // El efecto de auto-scroll lleva el hilo abajo cuando cambian los mensajes;
      // aquí queremos justo lo contrario: quedarse donde estaba leyendo.
      requestAnimationFrame(() => {
        if (box) box.scrollTop = box.scrollHeight - prevHeight;
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudieron cargar los mensajes anteriores');
    } finally {
      setLoadingOlder(false);
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
    loadSavedReplies();
    loadGallery();
    api.get('/chats/workflows-list').then((r) => setChatWorkflows(r.data || [])).catch(() => {});
    api.get('/call-center/agents').then((r) => setAgents(r.data || [])).catch(() => {});
    // Plantillas WhatsApp aprobadas por Meta (para enviar desde el chat),
    // más usadas primero (el menú muestra el top 4 por defecto).
    api
      .get('/message-templates', { params: { channel: 'whatsapp', status: 'approved' } })
      .then((r) => setTemplates((r.data || []).slice().sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))))
      .catch(() => {});
    // OJO: aquí NO se piden las estadísticas. `/chats/stats` son 7 agregaciones
    // (1,6 s medidos en producción el 30-jul-2026) y solo las usa el tablero de
    // Supervisión — que la mayoría de agentes no abre nunca. Se cargan en el
    // efecto de abajo, al entrar en esa vista. El único dato que la bandeja
    // necesitaba de ahí era el contador de destacados, que ahora viene en
    // /chats/unread-counts (un countDocuments sobre un índice).
    loadUnreadCounts();
  }, []);

  // Estadísticas de Supervisión: SOLO cuando se abre el tablero. Se piden una vez
  // por entrada a la vista; dentro del tablero se refrescan con su botón o al
  // cambiar el rango de fechas.
  useEffect(() => {
    if (view !== 'board') return;
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view === 'board') return; // el tablero de supervisión no usa la lista
    // Cambiar de pestaña, de alcance o de búsqueda empieza una lista NUEVA: se
    // vuelve a la primera página (si no, un filtro con 3 resultados heredaría el
    // "traeme 200" de la pestaña anterior).
    convLoadedRef.current = CHATS_PAGE;
    loadConversations(paramsForView());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scope, filter, sortOrder, debouncedSearch]);

  useEffect(() => {
    // El hilo se vacía SIEMPRE al cambiar de chat. Antes se quedaban a la vista
    // los mensajes del contacto anterior hasta que llegaba la respuesta del
    // nuevo: el agente creía que el sistema "no cambiaba de chat" y, peor, podía
    // ponerse a leer (o a responder sobre) la conversación equivocada.
    setMessages([]);
    if (activeId) loadMessages(activeId);
    setTemplateDraft({ name: '', language: 'es', vars: '' });
    setAttachmentDraft(null);
    setReplyDraft(null);
  }, [activeId]);

  // Realtime — el mensaje llega ENTERO en el evento, así que se añade al hilo sin
  // volver a pedirlo. Antes cada mensaje entrante disparaba una recarga completa
  // de la conversación (con sus adjuntos) y otra de la lista: con el equipo
  // trabajando, el chat se pasaba el día recargándose encima del agente y las
  // respuestas se sentían lentas. Si el mensaje ya está (llegó por la respuesta
  // del envío) se reemplaza en su sitio en vez de duplicarse.
  useSocketEvent(
    'chat:message',
    (payload) => {
      const incoming = payload?.message;
      if (incoming && payload?.conversationId && String(payload.conversationId) === String(activeId)) {
        setMessages((prev) => {
          const i = prev.findIndex(
            (m) =>
              String(m._id) === String(incoming._id) ||
              (incoming.clientId && m.clientId && m.clientId === incoming.clientId)
          );
          if (i === -1) return [...prev, incoming];
          const next = prev.slice();
          next[i] = { ...next[i], ...incoming };
          return next;
        });
      } else if (payload?.conversationId && String(payload.conversationId) === String(activeId)) {
        // Evento sin cuerpo (emisores antiguos): ahí sí toca releer el hilo.
        loadMessages(activeId, { silent: true });
      }
      if (view !== 'board') refreshConversations();
      loadUnreadCounts();
    },
    [activeId, view, scope, filter, sortOrder, debouncedSearch]
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
      if (view !== 'board') refreshConversations();
      loadUnreadCounts();
    },
    [view, scope, filter, sortOrder, debouncedSearch]
  );

  // La asignación normal sigue compartida. Solo una restricción explícita creada
  // por un workflow retira el chat a los demás asesores; marketing/admin siempre
  // conservan la vista completa.
  useSocketEvent(
    'chat:assignment',
    (payload) => {
      const conversationId = String(payload?.conversationId || '');
      if (!conversationId) return;
      const me = String(user?.id || user?._id || '');
      const restrictedTo = String(payload?.restrictedTo || '');
      // Los eventos nuevos conservan el propietario del workflow aunque su
      // candado quede temporalmente abierto fuera del turno.
      const restrictionActive = !!restrictedTo && payload?.restrictionActive !== false;
      const isRestrictedAgent = !isAdmin && !isSupervisor;
      const hiddenByAnotherOwner = restrictionActive && restrictedTo !== me;
      const hiddenBecauseMyShiftEnded = !restrictionActive && restrictedTo === me;
      if (isRestrictedAgent && restrictedTo && (hiddenByAnotherOwner || hiddenBecauseMyShiftEnded)) {
        setConversations((prev) => prev.filter((conv) => String(conv._id) !== conversationId));
        if (String(activeIdRef.current) === conversationId) {
          msgReqRef.current += 1;
          msgAbortRef.current?.abort();
          setActiveId(null);
          setMessages([]);
          setTypingAgents([]);
          setOpenConvSnap(null);
          setActiveDetail(null);
          toast(hiddenBecauseMyShiftEnded
            ? 'Tu turno terminó: este chat queda disponible para los demás asesores'
            : 'Este chat quedó reservado para otro asesor mediante un workflow');
        }
      } else {
        // El propietario al entrar en turno, los demás al salir y los
        // supervisores siempre reciben/actualizan el chat sin esperar mensajes.
        if (view !== 'board') refreshConversations();
      }
      loadUnreadCounts();
    },
    [isAdmin, isSupervisor, user?.id, user?._id, view, scope, filter, debouncedSearch]
  );

  // Me transfirieron un chat: aviso para que el asesor sepa que le llegó algo
  // (la lista ya se actualiza sola con 'chat:assignment').
  useSocketEvent(
    'chat:assigned',
    (payload) => {
      if (!payload?.transferredBy) return;
      toast.success(
        `${payload.transferredBy} te pasó el chat${payload.contactName ? ` de ${payload.contactName}` : ''}`,
        { icon: '📥' }
      );
    },
    []
  );

  // Se llevaron un chat que yo tenía asignado.
  useSocketEvent(
    'chat:transferred-away',
    (payload) => {
      if (!payload?.to) return;
      toast(`${payload.by || 'Un compañero'} transfirió un chat tuyo a ${payload.to}`, { icon: '↪️' });
    },
    []
  );

  // Otro agente tocó la oportunidad del chat que tengo abierto: se relee el
  // detalle (paciente, oportunidades y sus productos), que la lista ya no trae.
  useSocketEvent(
    'chat:opportunity',
    (payload) => {
      if (payload?.conversationId && String(payload.conversationId) === String(activeIdRef.current)) {
        loadActiveDetail(activeIdRef.current);
      }
    },
    []
  );

  // Estado del tiempo real (socket). Se muestra en la cabecera y gobierna el
  // respaldo por sondeo de abajo.
  const { socket: realtimeSocket, connected: realtimeConnected } = useSocket();

  // Indicador de escritura recibido de los otros asesores. El timeout es una red
  // de seguridad: si se pierde el evento "dejó de escribir", desaparece solo.
  useSocketEvent(
    'chat:typing',
    (payload) => {
      if (!payload?.typingId || String(payload.conversationId) !== String(activeIdRef.current)) return;
      const myId = String(user?.id || user?._id || '');
      if (payload.userId && String(payload.userId) === myId) return;
      const key = String(payload.typingId);
      clearTimeout(typingExpiryRef.current.get(key));
      typingExpiryRef.current.delete(key);
      if (payload.isTyping === false) {
        setTypingAgents((prev) => prev.filter((a) => a.typingId !== key));
        return;
      }
      setTypingAgents((prev) => [
        ...prev.filter((a) => a.typingId !== key),
        { typingId: key, userId: String(payload.userId || ''), name: payload.name || 'Asesor' },
      ]);
      const timeout = setTimeout(() => {
        setTypingAgents((prev) => prev.filter((a) => a.typingId !== key));
        typingExpiryRef.current.delete(key);
      }, 5500);
      typingExpiryRef.current.set(key, timeout);
    },
    [user?.id, user?._id]
  );

  useEffect(() => {
    setTypingAgents([]);
    for (const timeout of typingExpiryRef.current.values()) clearTimeout(timeout);
    typingExpiryRef.current.clear();
  }, [activeId]);

  useEffect(() => () => {
    for (const timeout of typingExpiryRef.current.values()) clearTimeout(timeout);
    typingExpiryRef.current.clear();
  }, []);

  // Refresco al VOLVER a la pestaña o recuperar el foco: si mientras estabas en
  // otra pestaña se perdió algún evento en vivo, al volver ves todo al día sin
  // pulsar "recargar".
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (view !== 'board') loadConversations(paramsForView());
      // `silent`: es una puesta al día de fondo, no debe parpadear el hilo que el
      // agente ya está leyendo.
      if (activeId) loadMessages(activeId, { silent: true });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, view, scope, filter, sortOrder, debouncedSearch]);

  // RESPALDO cuando el tiempo real está CAÍDO: sondea cada 8 s para que los
  // mensajes nuevos aparezcan solos aunque el socket no esté conectado (así nunca
  // hay que pulsar "recargar"). Cuando el socket funciona, esto NO corre: el
  // tiempo real ya entrega los mensajes al instante.
  useEffect(() => {
    if (realtimeConnected || view === 'board') return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadConversations(paramsForView());
      if (activeId) loadMessages(activeId, { silent: true });
    }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeConnected, activeId, view, scope, filter, sortOrder, debouncedSearch]);

  // Auto-scroll al final SOLO si el agente ya estaba abajo (o si el hilo acaba de
  // abrirse). Si está leyendo mensajes de más arriba —o acaba de cargar la página
  // anterior— bajarlo de golpe le hace perder el punto de lectura.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const box = messagesEndRef.current;
    if (!box) return;
    if (stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

  const handleThreadScroll = () => {
    const box = messagesEndRef.current;
    if (!box) return;
    // 80px de margen: "abajo del todo" con holgura para el rebote del scroll.
    stickToBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  };
  // Al cambiar de chat se vuelve a empezar abajo, como en WhatsApp.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeId]);

  // Versión "viva" del chat abierto tomada de la lista filtrada.
  const liveActiveConv = useMemo(
    () => conversations.find((c) => c._id === activeId),
    [conversations, activeId]
  );
  // Snapshot del chat abierto: si el chat sale de la lista FILTRADA (p.ej. al
  // responder en "No leídos" deja de estar sin leer y desaparece de esa lista), el
  // panel NO debe cerrarse. Guardamos su último estado conocido y lo usamos como
  // respaldo, para que quede abierto y se pueda seguir escribiendo sin re-buscarlo
  // (comportamiento estilo Daplox).
  const [openConvSnap, setOpenConvSnap] = useState(null);
  useEffect(() => {
    if (liveActiveConv) setOpenConvSnap(liveActiveConv);
  }, [liveActiveConv]);
  /**
   * Detalle COMPLETO del chat abierto (paciente, oportunidades con sus productos,
   * cita vinculada). La lista ya no trae nada de esto: cargar los datos del
   * paciente de 300 conversaciones para pintar unas filas que solo muestran
   * nombre y último mensaje era lo que la hacía tardar segundos. Aquí se pide UNA
   * conversación, que tarda ~350 ms, y solo cuando el agente la abre.
   */
  const [activeDetail, setActiveDetail] = useState(null);
  const loadActiveDetail = (id) => {
    if (!id) return Promise.resolve();
    return api
      .get(`/chats/${id}`)
      .then(({ data }) => {
        // Solo pinta si el agente sigue en ese chat: si ya se movió, esta
        // respuesta tardía llenaría el panel con los datos del contacto anterior.
        if (String(data?._id) === String(activeIdRef.current)) setActiveDetail(data);
      })
      .catch(() => {});
  };
  useEffect(() => {
    setActiveDetail(null);
    if (activeId) loadActiveDetail(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Mezcla EXPLÍCITA. La fila de la lista manda en todo lo que cambia en vivo
  // (último mensaje, no leídos, ventana de 24h) y el detalle aporta solo los
  // campos que la lista ya no trae completos. Se enumeran uno a uno a propósito:
  // con un `{...detail, ...base}` a secas, el `patient` de la fila —que ahora es
  // solo un identificador— pisaría el objeto entero del paciente y el panel
  // lateral se quedaría en blanco.
  const activeConv = useMemo(() => {
    const base = liveActiveConv || (openConvSnap && openConvSnap._id === activeId ? openConvSnap : undefined);
    const detail = activeDetail && String(activeDetail._id) === String(activeId) ? activeDetail : null;
    if (!detail) return base;
    if (!base) return detail;
    return {
      ...base,
      patient: detail.patient,
      opportunity: detail.opportunity,
      opportunities: detail.opportunities,
      featuredBy: detail.featuredBy,
      // Correo que el contacto escribió en el chat: solo viene en el detalle.
      detectedEmail: detail.detectedEmail,
      // Otros chats del MISMO contacto (whatsapp/messenger/instagram): alimenta
      // las pestañas de canal del compositor. Solo viene en el detalle.
      linkedConversations: detail.linkedConversations,
    };
  }, [liveActiveConv, openConvSnap, activeDetail, activeId]);

  /**
   * Aplica una conversación ya actualizada por el servidor (asignar, etiquetar,
   * vincular paciente, crear cita, editar oportunidad…). Las respuestas de esas
   * mutaciones vienen COMPLETAS, así que sirven a la vez de fila de la lista y de
   * detalle del panel. Hay que refrescar las dos cosas: si solo se actualizara la
   * lista, el panel seguiría mostrando el paciente o las oportunidades de antes
   * de guardar, porque esos campos salen del detalle (ver activeConv).
   */
  const applyConversationUpdate = (c) => {
    if (!c?._id) return;
    setConversations((prev) => prev.map((x) => (String(x._id) === String(c._id) ? c : x)));
    setOpenConvSnap((prev) => (prev && String(prev._id) === String(c._id) ? c : prev));
    if (String(c._id) === String(activeIdRef.current)) setActiveDetail(c);
  };
  // El orden ya viene ordenado del servidor (ver paramsForView): con la lista
  // paginada tiene que ser así, porque los chats que más llevan esperando están
  // al FINAL de la lista completa y aquí no se han cargado siquiera.
  const sortedConversations = conversations;
  const activeWindowClosed = isWhatsappWindowClosed(activeConv);
  const activeOptedOut = isOptedOut(activeConv);
  const activeSendsMedia = channelSendsMedia(activeConv);
  const activeSendsTemplates = channelSendsTemplates(activeConv);
  // El compositor de texto está inhabilitado cuando no se puede escribir libre:
  // contacto bloqueado, ventana de 24h cerrada, opt-out, plantilla seleccionada
  // o una nota de voz preparada (que se envía sola).
  const composerDisabled =
    !!activeConv?.blocked || activeWindowClosed || activeOptedOut ||
    !!templateDraft.name || attachmentDraft?.type === 'audio';
  // Mientras hay texto y foco, manda un latido cada 2,5 s. Al borrar, enviar,
  // cambiar de chat o desenfocar se apaga inmediatamente.
  //
  // Elegir una automatización, una plantilla o un mensaje guardado TAMBIÉN cuenta
  // como estar escribiendo: el asesor ya está preparando la respuesta aunque el
  // cuadro de texto siga vacío, y sin esto dos personas contestan el mismo chat.
  const isPickingReply = !!pickerTab || slashOpen;
  const isActivelyTyping = !!(
    realtimeConnected && realtimeSocket && activeId &&
    (isPickingReply || (composerFocused && draft.trim() && !composerDisabled))
  );
  useEffect(() => {
    if (!realtimeSocket || !activeId) return undefined;
    const conversationId = String(activeId);
    const emit = (isTyping) => realtimeSocket.emit('chat:typing', { conversationId, isTyping });
    if (!isActivelyTyping) {
      emit(false);
      return undefined;
    }
    emit(true);
    const heartbeat = setInterval(() => emit(true), 2500);
    return () => {
      clearInterval(heartbeat);
      emit(false);
    };
  }, [realtimeSocket, realtimeConnected, activeId, isActivelyTyping]);
  // Un clic fuera del compositor cierra los menús flotantes y apaga el botón "+"
  // (antes se quedaban abiertos tapando la conversación hasta volver a pulsarlo).
  // Se escucha en captura para adelantarse a los onMouseDown de las opciones.
  useEffect(() => {
    if (!pickerTab && !slashOpen) return undefined;
    const onDown = (e) => {
      if (composerMenusRef.current?.contains(e.target)) return;
      setPickerTab(null);
      setSlashOpen(false);
    };
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      setPickerTab(null);
      setSlashOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [pickerTab, slashOpen]);
  // El cuadro se expande al enfocarlo o cuando ya hay algo escrito/adjunto (así no
  // se colapsa a media escritura ni al hacer clic en un botón de acción).
  const composerExpanded =
    composerFocused || draft.trim().length > 0 || !!attachmentDraft;

  const sendMessage = async () => {
    if (!activeId || !activeConv) return;
    // Candado: mientras un envío está en curso NO se acepta otro. Es la mitad del
    // arreglo al problema de los mensajes repetidos (la otra mitad es `clientId`,
    // que hace que el servidor reconozca el envío duplicado aunque el candado se
    // salte por recarga o por dos pestañas abiertas).
    if (sending) return;
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

    // La conversación se FIJA aquí. Antes el resultado se pintaba en el chat que
    // estuviera abierto al responder el servidor: si el agente pasaba al
    // siguiente contacto mientras el mensaje salía, la burbuja aterrizaba en la
    // conversación equivocada y en la de origen no aparecía nada — de ahí el
    // "cambié de chat y el mensaje no se envió" (sí se enviaba; se perdía de vista).
    const convId = activeId;
    const convAtSend = activeConv;
    // Llave de idempotencia de ESTE envío: si la petición se repite (doble clic,
    // reintento del navegador), el servidor devuelve el mensaje ya creado.
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    setSending(true);
    try {
      const payload = useTemplate
        ? {
            clientId,
            templateName,
            templateLanguage: templateDraft.language || 'es',
            templateVars: templateDraft.vars
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          }
        : {
            clientId,
            body,
            ...(attachmentDraft
              ? { mediaUrl: attachmentDraft.url, mediaType: attachmentDraft.type || 'image', mediaName: attachmentDraft.name || '', mediaSize: attachmentDraft.size || 0 }
              : {}),
            ...(replyDraft ? { replyTo: replyDraft._id } : {}),
          };
      const r = await api.post(`/chats/${convId}/messages`, payload);
      // El servidor acepta y entrega por detrás, así que esto vuelve enseguida.
      // Solo se pinta si el agente sigue en ese chat; si ya se movió, el mensaje
      // está guardado igual y lo verá al volver (y el socket lo anunció).
      setMessages((prev) => {
        if (String(convId) !== String(activeIdRef.current)) return prev;
        if (prev.some((m) => String(m._id) === String(r.data._id))) return prev;
        return [...prev, r.data];
      });
      const preview = r.data.body || (useTemplate ? `[Plantilla: ${templateName}]` : body);
      const convPatch = {
        lastMessagePreview: preview.slice(0, 140),
        lastMessageAt: r.data.createdAt,
        lastMessageDirection: 'out',
        // Responder limpia el pendiente de no leído (igual que el backend).
        unreadCount: 0,
      };
      // Mantener el chat abierto con datos frescos aunque salga de la lista filtrada.
      if (convAtSend && String(convId) === String(activeIdRef.current)) {
        setOpenConvSnap({ ...convAtSend, ...convPatch });
      }
      setConversations((prev) => {
        const updated = prev.map((c) => (c._id === convId ? { ...c, ...convPatch } : c));
        // En "No leídos", responder saca el chat de esa lista (como Daplox); el panel
        // sigue abierto por el snapshot, así se puede seguir escribiendo sin buscarlo.
        if (view === 'inbox' && filter === 'unread') return updated.filter((c) => c._id !== convId);
        return updated;
      });
      if (useTemplate) setTemplateDraft({ name: '', language: 'es', vars: '' });
      else {
        setAttachmentDraft(null);
        setReplyDraft(null);
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al enviar');
      // El texto vuelve al cuadro SOLO si el agente sigue en el mismo chat: si ya
      // se movió, devolvérselo le metería el mensaje de otro contacto encima.
      if (!windowClosed && !isVoice && String(convId) === String(activeIdRef.current)) setDraft(body);
    } finally {
      setSending(false);
    }
  };

  // Reintenta un mensaje que quedó FALLIDO (mismo contenido, nuevo intento por el
  // mismo endpoint). Si vuelve a fallar, muestra el motivo real del proveedor.
  const retrySend = useCallback(async (msg) => {
    if (!msg) return;
    const convId = msg.conversation || activeId;
    if (!convId) return;
    const payload = msg.templateName
      ? { templateName: msg.templateName, templateLanguage: 'es' }
      : {
          body: msg.body || '',
          ...(msg.mediaUrl ? { mediaUrl: msg.mediaUrl, mediaType: msg.mediaType || 'image', mediaName: msg.mediaName || '', mediaSize: msg.mediaSize || 0 } : {}),
        };
    try {
      await api.post(`/chats/${convId}/messages`, payload);
      toast.success('Mensaje reenviado');
      if (String(convId) === String(activeId)) loadMessages(activeId);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo reenviar el mensaje');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Abre el selector en la pestaña de plantillas. Lo usa la burbuja de un mensaje
  // rechazado por ventana cerrada: ahí "Reintentar" no sirve y lo que hace falta
  // es elegir una plantilla aprobada.
  const openTemplatePicker = useCallback(() => setPickerTab('templates'), []);

  // Vuelve a pedirle a WhatsApp el archivo de un mensaje entrante cuyo adjunto no
  // se pudo descargar (el archivo sigue en WhatsApp: un fallo puntual de la sesión
  // no tiene por qué costar la foto o la nota de voz del paciente).
  const retryMedia = useCallback(async (msg) => {
    try {
      const { data } = await api.post(`/chats/${msg.conversation || activeId}/messages/${msg._id}/retry-media`);
      setMessages((prev) => prev.map((m) => (m._id === data._id ? data : m)));
      toast.success('Archivo recuperado');
    } catch (err) {
      const doc = err.response?.data?.messageDoc;
      if (doc) setMessages((prev) => prev.map((m) => (m._id === doc._id ? doc : m)));
      toast.error(err.response?.data?.message || 'No se pudo recuperar el archivo');
    }
  }, [activeId]);

  // Sube un adjunto ya leído como data URL y lo deja preparado en el composer.
  // Devuelve true si quedó listo. El uploader es el mismo que usan los mensajes
  // guardados: almacena la media y devuelve una URL pública que ambos gateways
  // (Cloud API y QR) saben resolver.
  const attachMedia = async ({ dataUrl, name, type, size = 0 }) => {
    setAttachingMedia(true);
    try {
      const { data } = await api.post('/chats/saved-replies/upload', { name, dataUrl });
      setAttachmentDraft({ url: data.url, type: data.type || type, name: data.name || name, size });
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || 'No se pudo adjuntar');
      return false;
    } finally {
      setAttachingMedia(false);
    }
  };

  // Adjuntar un ARCHIVO cualquiera (documento PDF/Word/Excel, imagen, video…) desde
  // el explorador. El tipo lo decide el MIME real; lo que no sea imagen/video/audio
  // viaja como DOCUMENTO (con su nombre e icono, como en WhatsApp).
  const filePickRef = useRef(null);
  const handleFilePick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo
    if (!file || attachingMedia) return;
    const m = (file.type || '').toLowerCase();
    const type = m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'document';
    try {
      let dataUrl = type === 'image' ? await imageFileToDataUrl(file) : await readFileAsDataUrl(file);
      // Archivos sin tipo MIME: se marcan como binario para que el backend los
      // acepte como documento en vez de rechazarlos por "data URL inválido".
      if (/^data:;base64,/i.test(dataUrl)) dataUrl = dataUrl.replace(/^data:;base64,/i, 'data:application/octet-stream;base64,');
      await attachMedia({ dataUrl, name: file.name, type, size: file.size });
    } catch (err) {
      toast.error(err.message || 'No se pudo adjuntar el archivo');
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

  // ¿Hay algo preparado para enviar? Texto, adjunto o plantilla elegida.
  const composerHasContent =
    draft.trim().length > 0 || !!attachmentDraft || !!templateDraft.name;

  // Deja el compositor en blanco de una sola vez. Es lo que antes costaba dos o
  // tres pasos: al elegir el mensaje guardado equivocado (los que traen foto o
  // video) había que borrar el texto a mano Y quitar el adjunto con su ✕.
  const clearComposer = () => {
    setDraft('');
    setAttachmentDraft(null);
    setTemplateDraft({ name: '', language: 'es', vars: '' });
    setSlashOpen(false);
    setSlashQuery('');
    setPickerTab(null);
    composerRef.current?.focus();
  };

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
  //
  // Se pide al servidor la versión VIGENTE antes de insertar (la misma llamada
  // que ya contaba el uso). La copia que tiene el chat se carga al abrir la
  // página y se quedaba vieja: si el mensaje guardado se editaba en la otra
  // pestaña para adjuntarle un video, el chat insertaba la copia SIN adjunto y
  // el mensaje salía como texto pelado, sin avisar de nada.
  const insertSavedReply = async (r) => {
    setSlashOpen(false);
    setSlashQuery('');
    setPickerTab(null);
    let fresh = r;
    try {
      const { data } = await api.post(`/chats/saved-replies/${r._id}/used`);
      if (data?._id) fresh = data;
    } catch {
      /* sin respuesta del servidor: se usa la copia local (mejor que no insertar) */
    }
    const body = fillSavedVariables(fresh.body, activeConv);
    setDraft((prev) => {
      const lastSlashAt = prev.lastIndexOf('/');
      if (lastSlashAt >= 0 && (lastSlashAt === 0 || /\s/.test(prev[lastSlashAt - 1]))) {
        return prev.slice(0, lastSlashAt) + body;
      }
      return prev ? `${prev} ${body}` : body;
    });
    if (fresh.attachment?.url) {
      setAttachmentDraft({
        url: fresh.attachment.url,
        type: fresh.attachment.type || 'image',
        name: fresh.attachment.name || fresh.title || 'adjunto',
      });
    }
    setSavedReplies((prev) =>
      prev.map((x) => (x._id === r._id ? { ...x, ...fresh, usageCount: (x.usageCount || 0) + 1 } : x))
    );
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
      setAutomationsVersion((v) => v + 1); // que aparezca ya en el panel del contacto
      setPickerTab(null);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al ejecutar la automatización');
    } finally {
      setRunningWf(false);
    }
  };

  // OJO: `toggleFeatured`, `toggleRead` y `selectConversation` van envueltos en
  // useCallback porque se pasan como props a ConversationRow, que está memoizado
  // (ver React.memo abajo). Si se recrearan en cada render, la memoización no
  // serviría de nada: las 300 filas verían props "nuevas" y se repintarían igual.
  const toggleFeatured = useCallback(async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/featured`, {
        isFeatured: !conv.isFeatured,
      });
      // Los destacados no salen en "Todos" y sí en "Destacados": al marcar/quitar,
      // el chat entra o sale del filtro actual (no solo cambia su estrella).
      setConversations((prev) => {
        if (view === 'inbox' && filter === 'all' && r.data.isFeatured) return prev.filter((c) => c._id !== conv._id);
        if (view === 'inbox' && filter === 'featured' && !r.data.isFeatured) return prev.filter((c) => c._id !== conv._id);
        return prev.map((c) => (c._id === conv._id ? r.data : c));
      });
      toast.success(r.data.isFeatured ? 'Marcado como destacado' : 'Destacado removido');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  }, [view, filter]);

  const takeChat = async (conv) => {
    try {
      const r = await api.post(`/chats/${conv._id}/assign`, {});
      applyConversationUpdate(r.data);
      toast.success('Chat asignado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  // Salta al mensaje original citado y lo resalta un instante.
  const scrollToMessage = useCallback((id) => {
    if (!id) return;
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-emerald-400', 'rounded-lg');
    setTimeout(() => el.classList.remove('ring-2', 'ring-emerald-400', 'rounded-lg'), 1600);
  }, []);

  // Coincidencias del buscador dentro del chat (ids de mensajes, orden cronológico).
  const chatMatches = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return [];
    return messages.filter((m) => (m.body || '').toLowerCase().includes(q)).map((m) => m._id);
  }, [messages, chatSearch]);

  // Al cambiar el texto: salta a la coincidencia MÁS RECIENTE (como WhatsApp).
  useEffect(() => {
    if (!chatSearchOpen) return;
    if (!chatMatches.length) { setChatMatchIdx(0); return; }
    const last = chatMatches.length - 1;
    setChatMatchIdx(last);
    scrollToMessage(chatMatches[last]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSearch, chatSearchOpen]);

  // Cerrar/limpiar el buscador al cambiar de conversación.
  useEffect(() => {
    setChatSearchOpen(false);
    setChatSearch('');
    setChatMatchIdx(0);
  }, [activeId]);

  const gotoChatMatch = (delta) => {
    if (!chatMatches.length) return;
    const n = chatMatches.length;
    const next = (chatMatchIdx + delta + n) % n;
    setChatMatchIdx(next);
    scrollToMessage(chatMatches[next]);
  };
  const closeChatSearch = () => { setChatSearchOpen(false); setChatSearch(''); setChatMatchIdx(0); };

  // Alterna leído/no leído SIN responder. La acción permanece disponible en
  // ambos estados; al volverlo no leído el servidor crea un pendiente de 1.
  const toggleRead = useCallback(async (conv) => {
    const markAsRead = Number(conv?.unreadCount || 0) > 0;
    try {
      const { data } = await api.post(`/chats/${conv._id}/read`, { read: markAsRead });
      const unreadCount = Number(data?.unreadCount ?? (markAsRead ? 0 : 1));
      const updated = { ...conv, unreadCount };
      setConversations((prev) => {
        let found = false;
        let next = prev.map((c) => {
          if (c._id !== conv._id) return c;
          found = true;
          return { ...c, unreadCount };
        });
        if (view === 'inbox' && filter === 'unread') {
          if (markAsRead) next = next.filter((c) => c._id !== conv._id);
          else if (!found) next = [updated, ...next];
        }
        return next;
      });
      // Mantener actualizado el chat abierto aunque haya salido/entrado en el
      // filtro "No leídos".
      setOpenConvSnap((prev) => (prev && prev._id === conv._id ? { ...prev, unreadCount } : prev));
      loadUnreadCounts();
      toast.success(markAsRead ? 'Marcado como leído' : 'Marcado como no leído');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo cambiar el estado de lectura');
    }
  }, [view, filter]);

  // Seleccionar chat: estable (solo llama a un setter de estado), para que las
  // filas memoizadas no se invaliden.
  const selectConversation = useCallback((id) => setActiveId(id), []);

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

  /**
   * Deja abierto el chat de un número: si ya existe se abre y si no se crea.
   * El servidor responde 200 con el que ya había y 201 con el nuevo, así que
   * aquí se sabe cuál de las dos cosas pasó sin consultar antes.
   */
  /** Deja una conversación abierta y a la vista, venga de donde venga. */
  const mostrarChat = (conv) => {
    // Bandeja global y filtro "Todos": un chat recién abierto no tiene
    // no-leídos ni está destacado, así que en otra vista no aparecería.
    setView('inbox');
    setScope('all');
    localStorage.setItem('chats.scope', 'all');
    setFilter('all');
    setConversations((prev) => [conv, ...prev.filter((c) => String(c._id) !== String(conv._id))]);
    // Respaldo por si la recarga de la lista todavía no lo trae (se llega desde
    // otra pantalla, con la lista sin cargar): el panel se pinta igual.
    setOpenConvSnap(conv);
    setActiveId(conv._id);
  };

  const abrirChatDe = async ({ phone, contactName }) => {
    const r = await api.post('/chats', { phone, contactName });
    mostrarChat(r.data);
    return { conv: r.data, creado: r.status === 201 };
  };

  // Nuevo chat: abre (o crea) la conversación con un número y la deja lista para
  // escribir. Como no hay ventana de 24h abierta con un contacto nuevo, el
  // compositor solo permitirá enviar una plantilla aprobada (igual que Daplox).
  const createNewChat = async ({ phone, contactName }) => {
    const { conv } = await abrirChatDe({ phone, contactName });
    setNewChatOpen(false);
    toast.success('Chat listo. Para el primer mensaje envía una plantilla aprobada (botón +).');
    return conv;
  };

  /**
   * Enlace directo a un chat, para llegar desde otra pantalla en otra pestaña:
   *
   *   /chats?chat=<id>                  una conversación que YA existe
   *   /chats?phone=593…&name=Ana Pérez  por número: si no hay chat, se crea
   *
   * Por `chat` lo abren las Analíticas (el detalle de una barra ya sabe de qué
   * conversación es, y así vale para cualquier canal, no solo WhatsApp). Por
   * `phone` lo abre el detalle de una importación de contactos, donde puede que
   * todavía no exista chat: la conversación se identifica por el número (ver
   * [ventana 24h por número]), así que el mismo teléfono es el mismo chat.
   */
  const deepLinkRef = useRef('');
  useEffect(() => {
    const chatId = (urlParams.get('chat') || '').trim();
    const phone = (urlParams.get('phone') || '').trim();
    const clave = chatId || phone;
    if (!clave || deepLinkRef.current === clave) return;
    deepLinkRef.current = clave;
    const contactName = (urlParams.get('name') || '').trim();
    // La URL se limpia enseguida: recargar la pestaña no debe volver a abrir
    // nada y el teléfono no tiene por qué quedarse en la barra de direcciones.
    const resto = new URLSearchParams(urlParams);
    ['chat', 'phone', 'name'].forEach((k) => resto.delete(k));
    setUrlParams(resto, { replace: true });

    const abrir = chatId
      ? api.get(`/chats/${chatId}`).then(({ data }) => { mostrarChat(data); return { creado: false }; })
      : abrirChatDe({ phone, contactName });
    abrir
      .then(({ creado }) => {
        if (creado) {
          toast.success('Chat listo. Para el primer mensaje envía una plantilla aprobada (botón +).');
        }
      })
      .catch((err) => toast.error(err.response?.data?.message || 'No se pudo abrir el chat de ese contacto'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams]);

  // Pasa la conversación a otro compañero. Sin `userId` (opción "automático",
  // solo para admin/supervisor) la reparte al agente con menos chats abiertos.
  const transferChat = async (conv, userId) => {
    try {
      const r = userId
        ? await api.post(`/chats/${conv._id}/assign`, { userId })
        : await api.post(`/chats/${conv._id}/auto-assign`, {});
      applyConversationUpdate(r.data);
      toast.success(`Chat transferido a ${r.data.assignedToName || 'otro usuario'}`);
      setTransferModal(false);
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo transferir el chat');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-row gap-2 sm:gap-3">
      {/* Riel de navegación (estilo Daplox): nuevo chat + alcance + vistas */}
      <ChatRail
        view={view}
        scope={scope}
        canSupervise={isAdmin || isSupervisor}
        unreadCounts={unreadCounts}
        onNewChat={() => setNewChatOpen(true)}
        onSelectScope={selectScope}
        onSelectView={setView}
      />

      {/* Contenido: el @container mide el ancho REAL de la bandeja (sin el riel),
          para que los breakpoints de columnas sigan siendo correctos. */}
      <div className="@container flex-1 flex flex-col min-h-0">
        {/* Filtros de la bandeja (solo aplican a Mi chat / Grupal) */}
        {view === 'inbox' && (
          <div className="flex items-center justify-between gap-2 mb-2 border-b border-slate-200">
            <div className="flex gap-1 flex-wrap">
              {[
                { id: 'unread', label: 'No leídos' },
                { id: 'all', label: 'Todos' },
                { id: 'featured', label: 'Destacados' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setFilter(t.id)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                    filter === t.id
                      ? 'border-emerald-600 text-emerald-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {t.label}
                  {t.id === 'unread' && (scope === 'mine' ? unreadCounts.mine : unreadCounts.all) > 0 && (
                    <span className="ml-1.5 bg-emerald-600 text-white text-[10px] px-1.5 rounded-full">
                      {scope === 'mine' ? unreadCounts.mine : unreadCounts.all}
                    </span>
                  )}
                  {/* El total de "Todos" se cuenta en la BASE, no en lo que se ha
                      llegado a cargar: la lista entra de 25 en 25 y aun así la
                      pestaña dice cuántos chats hay de verdad. */}
                  {t.id === 'all' && (scope === 'mine' ? unreadCounts.totalMine : unreadCounts.total) > 0 && (
                    <span className="ml-1.5 bg-slate-100 text-slate-600 text-[10px] px-1.5 rounded-full">
                      {(scope === 'mine' ? unreadCounts.totalMine : unreadCounts.total).toLocaleString('es-EC')}
                    </span>
                  )}
                  {t.id === 'featured' && unreadCounts.featured > 0 && (
                    <span className="ml-1.5 bg-amber-100 text-amber-700 text-[10px] px-1.5 rounded-full">
                      {unreadCounts.featured}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

      {view === 'board' ? (
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
              {/* El teléfono se busca en cualquier formato: 0988535561,
                  098 853 5561 o +593 98 853 5561 encuentran el mismo chat. */}
              <div className="relative flex-1">
                <HiOutlineMagnifyingGlass className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar nombre, teléfono o mensaje..."
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
                onClick={() => loadConversations(paramsForView())}
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
                <>
                  {sortedConversations.map((c) => (
                    <ConversationRow
                      key={c._id}
                      conv={c}
                      active={c._id === activeId}
                      onSelect={selectConversation}
                      onToggleFeatured={toggleFeatured}
                      onToggleRead={toggleRead}
                    />
                  ))}
                  {/* Pie de la lista: cuántos se están viendo de cuántos hay, y el
                      botón para traer los siguientes 25. */}
                  <div className="p-3 text-center">
                    {convHasMore ? (
                      <>
                        <button
                          onClick={loadMoreConversations}
                          disabled={loadingMore}
                          className="w-full py-2 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 disabled:opacity-60"
                        >
                          {loadingMore ? 'Cargando…' : 'Cargar más chats'}
                        </button>
                        <div className="mt-1.5 text-[11px] text-slate-400">
                          {conversations.length.toLocaleString('es-EC')} de {convTotal.toLocaleString('es-EC')}
                        </div>
                      </>
                    ) : (
                      convTotal > CHATS_PAGE && (
                        <div className="text-[11px] text-slate-400">
                          {convTotal.toLocaleString('es-EC')} chats · no hay más
                        </div>
                      )
                    )}
                  </div>
                </>
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
                  onTransfer={() => setTransferModal(true)}
                  onOpenOpportunity={() => setOpportunityModal(true)}
                  onCreateAppointment={() => setAppointmentModal(true)}
                  onCreateQuotation={() => setQuotationModal(true)}
                  onToggleRead={() => toggleRead(activeConv)}
                  onEnableCalling={enableCalling}
                  isAdmin={isAdmin}
                  meId={user?._id}
                  calling={calling}
                  onCall={() => voiceCall.startCall(activeConv)}
                  onBack={() => setActiveId(null)}
                  onToggleInfo={() => setInfoOpen(true)}
                  onToggleSearch={() => setChatSearchOpen((v) => !v)}
                  searchActive={chatSearchOpen}
                />
                <ChannelTabs conv={activeConv} onSelect={selectConversation} />
                {/* Buscador dentro de la conversación (estilo WhatsApp) */}
                {chatSearchOpen && (
                  <div className="border-b border-slate-100 px-3 py-2 flex items-center gap-2 bg-white">
                    <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400 shrink-0" />
                    <input
                      autoFocus
                      value={chatSearch}
                      onChange={(e) => setChatSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); gotoChatMatch(e.shiftKey ? -1 : 1); }
                        if (e.key === 'Escape') closeChatSearch();
                      }}
                      placeholder="Buscar en esta conversación…"
                      className="flex-1 text-sm border-none outline-none bg-transparent"
                    />
                    {chatSearch.trim() && (
                      <span className="text-xs text-slate-400 shrink-0 tabular-nums">
                        {chatMatches.length ? `${chatMatchIdx + 1}/${chatMatches.length}` : '0/0'}
                      </span>
                    )}
                    <button
                      onClick={() => gotoChatMatch(-1)}
                      disabled={!chatMatches.length}
                      title="Anterior (más arriba)"
                      className="p-1 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer shrink-0"
                    >
                      <HiOutlineChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => gotoChatMatch(1)}
                      disabled={!chatMatches.length}
                      title="Siguiente (más abajo)"
                      className="p-1 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer shrink-0"
                    >
                      <HiOutlineChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      onClick={closeChatSearch}
                      title="Cerrar búsqueda"
                      className="p-1 rounded-lg text-slate-500 hover:bg-slate-100 bg-transparent border-none cursor-pointer shrink-0"
                    >
                      <HiOutlineXMark className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {!realtimeConnected && (
                  <div className="text-[11px] text-amber-800 bg-amber-50 border-b border-amber-200 px-3 py-1 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Reconectando el tiempo real… los mensajes nuevos siguen llegando (se refresca solo cada pocos segundos).
                  </div>
                )}
                <div
                  ref={messagesEndRef}
                  onScroll={handleThreadScroll}
                  className="flex-1 overflow-y-auto bg-slate-50 p-4 space-y-2"
                >
                  {/* Señal explícita de que el hilo está cargando: con el panel en
                      blanco y sin aviso, el agente no sabía si el chat estaba
                      vacío, si se había colgado o si debía volver a hacer clic. */}
                  {messagesLoading && !messages.length && (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                      <HiOutlineArrowPath className="w-4 h-4 animate-spin" />
                      Cargando mensajes…
                    </div>
                  )}
                  {/* El chat abre con los últimos mensajes para que entre al
                      instante; el historial anterior se trae solo si hace falta. */}
                  {hasOlder && !!messages.length && (
                    <div className="flex justify-center pb-2">
                      <button
                        type="button"
                        onClick={loadOlderMessages}
                        disabled={loadingOlder}
                        className="px-3 py-1 text-xs rounded-full bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-60 cursor-pointer"
                      >
                        {loadingOlder ? 'Cargando…' : 'Ver mensajes anteriores'}
                      </button>
                    </div>
                  )}
                  {messages.map((m, i) => {
                    // Separador de día cuando cambia la fecha (o en el primero).
                    const prev = messages[i - 1];
                    const showDivider = !prev || ecDateKey(prev.createdAt) !== ecDateKey(m.createdAt);
                    return (
                      <Fragment key={m._id}>
                        {showDivider && <DateDivider date={m.createdAt} />}
                        <MessageBubble
                          highlight={chatSearchOpen ? chatSearch : ''}
                          msg={m}
                          onReply={setReplyDraft}
                          onJumpTo={scrollToMessage}
                          onRetry={retrySend}
                          onRetryMedia={retryMedia}
                          onUseTemplate={openTemplatePicker}
                        />
                      </Fragment>
                    );
                  })}
                </div>
                {typingAgents.length > 0 && <TypingIndicator agents={typingAgents} />}
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
                      {(() => {
                        // La ventana de 24h es de la pareja (nuestro número, contacto):
                        // que el paciente escribiera a OTRO de nuestros números no abre
                        // ninguna ventana en el número por el que va a salir esto. Sin
                        // decirlo, el aviso parece un error del sistema — el contacto
                        // escribió hace un rato y aun así "cerrada".
                        if (activeConv?.window?.otherNumber) {
                          const last = lastInboundDate(activeConv);
                          const num = activeConv?.sendingAccount;
                          return (
                            <div className="mt-0.5 text-amber-700">
                              El contacto escribió {last ? <>el <b>{formatDateTimeEc(last)}</b> </> : ''}a <b>otro</b> de
                              tus números, así que por {num?.label ? <b>{num.label}</b> : 'este número'}
                              {num?.displayPhone ? ` (${num.displayPhone})` : ''} no hay ventana abierta.
                            </div>
                          );
                        }
                        // El CUÁNDO es la clave: sin la fecha, un chat cuyo último
                        // entrante fue hace dos semanas parece de anoche (en el hilo
                        // solo se ve la hora) y la ventana cerrada parece un error.
                        const last = lastInboundDate(activeConv);
                        if (!last) {
                          return (
                            <div className="mt-0.5 text-amber-700">
                              Este contacto todavía no te ha escrito, así que nunca se abrió una ventana.
                            </div>
                          );
                        }
                        return (
                          <div className="mt-0.5 text-amber-700">
                            El contacto escribió por última vez el <b>{formatDateTimeEc(last)}</b> ({humanizeSince(last)}); la
                            ventana se cerró 24 h después.
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  {(() => {
                    if (activeWindowClosed || activeOptedOut || templateDraft.name) return null;
                    const ms = windowMsRemaining(activeConv);
                    if (!ms || ms <= 0) return null; // null = no aplica (QR); <=0 = cerrada
                    return (
                      <div className="mb-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                        Ventana de 24h <b>abierta</b>: puedes escribir libremente durante {humanizeRemaining(ms)} más.
                      </div>
                    );
                  })()}
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
                  <div className="relative" ref={composerMenusRef}>
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
                            // Las plantillas son un concepto de WhatsApp (HSM aprobadas por
                            // Meta): no existe equivalente para Messenger/Instagram/TikTok.
                            ...(activeSendsTemplates ? [['templates', '📄 Plantillas']] : []),
                            ['saved', '/ Guardados'],
                          ].map(([k, label]) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => {
                                setPickerTab(k);
                                setPickerQuery('');
                                // Datos frescos al cambiar de pestaña: lo que se
                                // inserte debe ser la versión ACTUAL (con su adjunto).
                                if (k === 'saved') loadSavedReplies();
                              }}
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
                              // Al ABRIR el menú (no en cada tecla) se refrescan los
                              // guardados: así se inserta la versión actual con su adjunto.
                              if (!slashOpen) loadSavedReplies();
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
                        onFocus={() => setComposerFocused(true)}
                        onBlur={() => setComposerFocused(false)}
                        placeholder={
                          templateDraft.name
                            ? 'Se enviará la plantilla seleccionada…'
                            : voiceNoteAttached
                              ? 'Una nota de voz se envía sola, sin texto'
                              : composerExpanded
                                ? 'Escribe un mensaje…   ·   / para guardados   ·   pega una imagen'
                                : 'Escribe un mensaje…'
                        }
                        rows={composerExpanded ? 5 : 1}
                        disabled={composerDisabled}
                        // Compacto (una línea) en reposo; alto y cómodo al enfocar o
                        // cuando ya hay contenido. resize-y deja ajustarlo a mano.
                        className={`w-full ${
                          composerExpanded ? 'min-h-[132px]' : 'min-h-[44px]'
                        } max-h-[55vh] border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-y disabled:bg-slate-100 transition-[min-height] duration-150`}
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
                          {activeSendsMedia && (
                            <button
                              type="button"
                              onClick={() => setGalleryOpen(true)}
                              title="Galería de imágenes"
                              className="p-2 bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 hover:border-emerald-300 cursor-pointer flex items-center"
                            >
                              <HiOutlinePhoto className="w-5 h-5" />
                            </button>
                          )}
                          <input
                            ref={filePickRef}
                            type="file"
                            className="hidden"
                            onChange={handleFilePick}
                            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,.rar,image/*,video/*,audio/*"
                          />
                          {activeSendsMedia && (
                            <button
                              type="button"
                              onClick={() => filePickRef.current?.click()}
                              disabled={
                                !!activeConv?.blocked || activeWindowClosed || activeOptedOut ||
                                !!templateDraft.name || attachingMedia || !!attachmentDraft
                              }
                              title="Adjuntar archivo (PDF, Word, Excel, imagen…)"
                              className="p-2 bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 hover:border-emerald-300 disabled:opacity-50 cursor-pointer flex items-center"
                            >
                              <HiOutlinePaperClip className="w-5 h-5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setPickerTab((v) => (v ? null : 'auto'));
                              setPickerQuery('');
                              loadSavedReplies(); // ver loadSavedReplies: evita insertar una versión vieja
                            }}
                            title="Automatizaciones, plantillas y mensajes guardados"
                            className={`p-2 border rounded-xl cursor-pointer disabled:opacity-50 flex items-center ${pickerTab || templateDraft.name ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-emerald-300'}`}
                          >
                            <HiOutlinePlus className="w-5 h-5" />
                          </button>
                          {activeSendsMedia && (
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
                          )}
                          <button
                            type="button"
                            onClick={clearComposer}
                            disabled={!composerHasContent}
                            title="Limpiar: borra el texto, el adjunto y la plantilla elegida"
                            className="p-2 bg-white border border-slate-200 text-slate-600 rounded-xl hover:border-rose-300 hover:text-rose-600 disabled:opacity-50 cursor-pointer flex items-center gap-1"
                          >
                            <HiOutlineBackspace className="w-5 h-5" />
                            <span className="hidden @sm:inline text-xs font-medium">Limpiar</span>
                          </button>
                          <button
                            type="button"
                            onClick={sendMessage}
                            disabled={
                              sending ||
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
                            <span className="text-sm font-medium">{sending ? 'Enviando…' : 'Enviar'}</span>
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
                  applyConversationUpdate(c);
                }}
                onEditOpportunity={() => setOpportunityModal(true)}
                onScheduleAppointment={() => setAppointmentModal(true)}
                onCreateQuotation={() => setQuotationModal(true)}
                automationsVersion={automationsVersion}
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
                    applyConversationUpdate(c);
                  }}
                  onEditOpportunity={() => setOpportunityModal(true)}
                  onScheduleAppointment={() => setAppointmentModal(true)}
                  onCreateQuotation={() => setQuotationModal(true)}
                  automationsVersion={automationsVersion}
                />
              </div>
            </div>
          )}
        </div>
      )}
      </div>
      {/* fin del contenido (@container); los modales viven fuera, en el riel+contenido */}

      {opportunityModal && activeConv && (
        <OpportunityModal
          conv={activeConv}
          services={services}
          onClose={() => setOpportunityModal(false)}
          onSaved={(c) => {
            applyConversationUpdate(c);
            setOpportunityModal(false);
          }}
        />
      )}
      {appointmentModal && activeConv && (
        <AppointmentFromChatModal
          conv={activeConv}
          onClose={() => setAppointmentModal(false)}
          onCreated={(c, count) => {
            applyConversationUpdate(c);
            setAppointmentModal(false);
            toast.success(count > 1 ? `${count} citas creadas desde el chat` : 'Cita creada desde el chat');
          }}
        />
      )}
      {transferModal && activeConv && (
        <TransferChatModal
          conv={activeConv}
          meId={user?.id || user?._id}
          canAutoAssign={canAutoAssign}
          onClose={() => setTransferModal(false)}
          onTransfer={(userId) => transferChat(activeConv, userId)}
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
              // 502 = el proveedor RECHAZÓ la imagen: el mensaje queda FALLIDO en el
              // chat (burbuja roja con motivo). Se cierra y recarga para verlo, en
              // vez de dejar el modal como si nada (antes parecía "enviado").
              toast.error(err.response?.data?.message || 'No se pudo enviar la imagen');
              if (err.response?.status === 502) {
                setGalleryOpen(false);
                loadMessages(activeId);
              }
            }
          }}
        />
      )}
      {newChatOpen && (
        <NewChatModal onClose={() => setNewChatOpen(false)} onCreate={createNewChat} />
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

// Miniatura de una imagen de la galería. Carga la imagen real (por `url` público
// o dataUrl) con carga diferida; si falla, cae a un icono para no dejar el hueco.
function GalleryThumb({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className="text-3xl" role="img" aria-label="imagen">🖼</span>;
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-full h-full object-cover"
    />
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
    if (file.size > 6 * 1024 * 1024) return toast.error('Máximo 6MB');
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
              <div className="aspect-square bg-slate-100 rounded overflow-hidden flex items-center justify-center">
                <GalleryThumb src={img.url || img.dataUrl} alt={img.name} />
              </div>
              <div className="text-[10px] text-slate-500 truncate mt-1" title={img.name}>{img.name}</div>
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

// Riel de navegación vertical (estilo Daplox): a la izquierda de la bandeja.
//  - "Nuevo" abre el compositor para escribirle a un número nuevo (solo plantillas).
//  - "Mi chat" / "Grupal" cambian el alcance de la bandeja (asignados a mí / todos).
//  - "Oportun." y "Superv." son vistas aparte (esta última solo admin/marketing).
// El buscador NO va aquí a propósito: se queda en la cabecera de la lista.
function RailItem(props) {
  // Icon se declara como const (mayúscula) para que se pueda usar como <Icon/>
  // sin que el linter la marque como no usada (varsIgnorePattern '^[A-Z_]').
  const { Icon, label, active, onClick, badge } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      title={badge ? `${label} · ${badge} sin leer` : label}
      className={`relative w-full flex flex-col items-center gap-1 py-2.5 rounded-xl border-none cursor-pointer transition-colors ${
        active
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-700'
      }`}
    >
      <span className="relative">
        <Icon className="w-6 h-6" />
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center shadow-sm">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium leading-tight text-center">{label}</span>
    </button>
  );
}

function ChatRail({ view, scope, canSupervise, unreadCounts = { mine: 0, all: 0 }, onNewChat, onSelectScope, onSelectView }) {
  return (
    <div className="w-[64px] sm:w-[72px] shrink-0 bg-white border border-slate-200 rounded-xl flex flex-col items-stretch p-1.5 gap-0.5 overflow-y-auto">
      <button
        type="button"
        onClick={onNewChat}
        title="Nuevo chat"
        className="w-full flex flex-col items-center gap-1 py-2.5 rounded-xl border-none cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm shadow-emerald-600/20"
      >
        <HiOutlinePencilSquare className="w-6 h-6" />
        <span className="text-[10px] font-semibold leading-tight text-center">Nuevo</span>
      </button>
      <div className="h-px bg-slate-100 mx-2 my-1.5" />
      <RailItem
        Icon={HiOutlineUser}
        label="Mi chat"
        badge={unreadCounts.mine}
        active={view === 'inbox' && scope === 'mine'}
        onClick={() => onSelectScope('mine')}
      />
      <RailItem
        Icon={HiOutlineUsers}
        label="Grupal"
        badge={unreadCounts.all}
        active={view === 'inbox' && scope === 'all'}
        onClick={() => onSelectScope('all')}
      />
      <div className="h-px bg-slate-100 mx-2 my-1.5" />
      <RailItem
        Icon={HiOutlineTag}
        label="Oportun."
        active={view === 'opportunities'}
        onClick={() => onSelectView('opportunities')}
      />
      {canSupervise && (
        <RailItem
          Icon={HiOutlineChartBar}
          label="Superv."
          active={view === 'board'}
          onClick={() => onSelectView('board')}
        />
      )}
    </div>
  );
}

// Modal "Nuevo chat": abre una conversación con un número que aún no ha escrito.
// Como no hay ventana de 24h abierta, el primer mensaje debe ser una plantilla
// aprobada (se recuerda en el compositor). El backend normaliza el número a
// E.164 (0999… → 593999…) y vincula al paciente si ya existe con ese teléfono.
function NewChatModal({ onClose, onCreate }) {
  const [phone, setPhone] = useState('');
  const [contactName, setContactName] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!phone.trim()) return toast.error('Escribe un número de teléfono');
    setSaving(true);
    try {
      await onCreate({ phone: phone.trim(), contactName: contactName.trim() });
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo crear el chat');
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalShell title="Nuevo chat" onClose={onClose} size="sm">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Teléfono</label>
          <input
            autoFocus
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="0999123456 o 593999123456"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Número de Ecuador: puedes escribirlo con 0 o con 593. Se detecta al paciente si ya existe.
          </p>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre (opcional)</label>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Nombre del contacto"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
          El contacto aún no ha escrito, así que el primer mensaje debe ser una
          <b> plantilla aprobada</b>. Al abrir el chat, elígela con el botón <b>+</b>.
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-white cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || !phone.trim()}
            onClick={submit}
            className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50 border-none cursor-pointer"
          >
            {saving ? 'Creando…' : 'Abrir chat'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * Fila de la bandeja. MEMOIZADA a propósito.
 *
 * POR QUÉ: el estado del compositor (`draft`) vive en el componente Chats, que es
 * el mismo que renderiza estas filas. Sin memoizar, CADA TECLA que el agente
 * escribía en el cuadro de respuesta repintaba las 300 filas de la lista —cada
 * una con su `timeAgo()`, su `stageMeta()` y sus iconos—. Eso es lo que se sentía
 * como "la app va a tirones" al escribir.
 *
 * Para que la memoización funcione de verdad, los manejadores llegan ESTABLES
 * (useCallback en el padre) y reciben la conversación como argumento, en vez de
 * ser flechas nuevas en cada render (`onClick={() => toggleFeatured(c)}`), que
 * habrían invalidado la memoización en cada render igualmente.
 */
const ConversationRow = memo(function ConversationRow({ conv, active, onSelect, onToggleFeatured, onToggleRead }) {
  const meta = conv.opportunity?.isOpportunity ? stageMeta(conv.opportunity.stage) : null;
  const select = () => onSelect?.(conv._id);
  return (
    <div
      onClick={select}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleRead?.(conv);
              }}
              title={conv.unreadCount > 0 ? 'Marcar como leído' : 'Marcar como no leído'}
              aria-label={conv.unreadCount > 0 ? 'Marcar como leído' : 'Marcar como no leído'}
              className={`text-[10px] rounded-full px-1.5 min-w-[18px] min-h-[18px] text-center cursor-pointer flex items-center justify-center gap-0.5 group/unread ${
                conv.unreadCount > 0
                  ? 'bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-500 border border-slate-300 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              {conv.unreadCount > 0 ? (
                <>
                <HiOutlineEnvelopeOpen className="w-3 h-3 hidden group-hover/unread:inline" />
                <span className="group-hover/unread:hidden">{conv.unreadCount}</span>
                <span className="hidden group-hover/unread:inline">Leído</span>
                </>
              ) : (
                <>
                  <HiOutlineEnvelope className="w-3 h-3" />
                  <span className="hidden group-hover/unread:inline">No leído</span>
                </>
              )}
            </button>
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
            {/* Quién atendió POR ÚLTIMA VEZ, no a quién está asignado: el
                asignado se queda pegado al primero que tocó el chat, y lo que
                se quiere ver de un vistazo es quién contestó de verdad. */}
            {conv.lastAgentReplyName && (
              <span className="text-[10px] text-slate-400" title="Última asesora que respondió">
                ↩ {conv.lastAgentReplyName}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFeatured?.(conv);
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
});

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

function ChatHeader({ conv, onToggleFeatured, onTake, onTransfer, onOpenOpportunity, onCreateAppointment, onCreateQuotation, onToggleRead, onEnableCalling, isAdmin, meId, calling, onCall, onBack, onToggleInfo, onToggleSearch, searchActive }) {
  const canTake = !conv.assignedTo || String(conv.assignedTo._id || conv.assignedTo) !== String(meId);
  // "Esperando respuesta" cuando el último mensaje es entrante (del paciente).
  const waitingReply = conv.lastMessageDirection === 'in';
  // Un admin puede encender las llamadas de un número Cloud API que las tiene
  // apagadas (sin entrar a Meta). Por QR es imposible: no se ofrece.
  const canEnableCalls = isAdmin && calling && calling.enabled === false && calling.canEnable;

  // Acciones secundarias: en línea en pantallas anchas, en el menú "⋯" cuando no
  // caben. "Transferir chat" lo ve cualquier usuario de la bandeja: abre el
  // selector para pasarle la conversación a otro compañero.
  const actions = [
    canTake && { key: 'take', label: 'Tomar', icon: HiOutlineUserPlus, onClick: onTake },
    { key: 'transfer', label: 'Transferir chat', icon: HiOutlineUsers, iconClass: 'text-sky-600', onClick: onTransfer },
    {
      key: 'opp',
      label: conv.opportunity?.isOpportunity ? 'Editar / añadir oportunidad' : 'Crear oportunidad',
      icon: HiOutlineTag,
      iconClass: 'text-emerald-600',
      onClick: onOpenOpportunity,
    },
    conv.patient && { key: 'appt', label: 'Crear cita', icon: HiOutlineCalendarDays, iconClass: 'text-indigo-600', onClick: onCreateAppointment },
    { key: 'quote', label: 'Cotización', icon: HiOutlineDocumentDuplicate, iconClass: 'text-amber-600', onClick: onCreateQuotation },
    {
      key: 'read',
      label: conv.unreadCount > 0 ? 'Marcar como leído' : 'Marcar como no leído',
      icon: conv.unreadCount > 0 ? HiOutlineEnvelopeOpen : HiOutlineEnvelope,
      onClick: onToggleRead,
    },
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
          {isHiddenNumber(conv) ? (
            <span
              className="italic"
              title="WhatsApp aún no comparte el teléfono de este contacto (número oculto). Se mostrará en cuanto lo entregue."
            >
              Número oculto
            </span>
          ) : (
            conv.phone
          )}
          {conv.patient && (
            <span className="ml-2 text-emerald-700">· Paciente vinculado</span>
          )}
          {conv.lastAgentReplyName && (
            <span className="ml-2" title="Última asesora que respondió este chat">
              · Últ. respuesta: {conv.lastAgentReplyName}
            </span>
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

        {onToggleSearch && (
          <button
            onClick={onToggleSearch}
            className={`p-1.5 rounded-lg shrink-0 border-none cursor-pointer ${searchActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}
            title="Buscar en esta conversación"
          >
            <HiOutlineMagnifyingGlass className="w-4 h-4" />
          </button>
        )}
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

/**
 * Pestañas de canal (whatsapp/messenger/instagram) cuando el contacto tiene MÁS
 * DE UN chat vinculado al mismo paciente (ver `registerPatientFromChat` y
 * `getConversation#linkedConversations`). Cambiar de pestaña abre ESE OTRO chat
 * (`selectConversation`): cada canal sigue siendo su propia conversación —solo
 * se deja saltar entre ellas sin buscar en la bandeja— así el agente responde
 * por el medio que ya tiene registrado sin perder el contexto del contacto.
 */
function ChannelTabs({ conv, onSelect }) {
  const linked = conv?.linkedConversations;
  if (!linked || !linked.length) return null;
  const tabs = [
    { _id: conv._id, channel: conv.channel || 'whatsapp', unreadCount: conv.unreadCount || 0 },
    ...linked,
  ];
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-slate-50 overflow-x-auto">
      <span className="text-[11px] text-slate-400 shrink-0">Responder por:</span>
      {tabs.map((t) => {
        const isActive = String(t._id) === String(conv._id);
        return (
          <button
            key={t._id}
            type="button"
            onClick={() => !isActive && onSelect(t._id)}
            title={isActive ? undefined : `Cambiar a este chat de ${CHANNEL_TAB_LABELS[t.channel] || t.channel}`}
            className={`text-xs font-medium px-2.5 py-1 rounded-full border shrink-0 cursor-pointer ${
              isActive
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            {CHANNEL_TAB_LABELS[t.channel] || t.channel}
            {t.unreadCount > 0 && (
              <span className={`ml-1.5 ${isActive ? 'text-emerald-100' : 'text-emerald-600'}`}>
                {t.unreadCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// El texto es el mismo, pero el ÍCONO y el tooltip distinguen lo que de verdad
// pasó: "enviado" (un ✓) = WhatsApp lo aceptó pero AÚN NO se confirma que llegó al
// contacto; "entregado" (✓✓) = llegó a su teléfono; "leído" (✓✓ azul) = lo leyó.
// Así nadie confunde "enviado" con "le llegó al contacto".
const DELIVERY_META = {
  // 'queued' = el sistema ya lo aceptó y lo está entregando a WhatsApp. Decía "en
  // cola — todavía no se envía", que sonaba a atascado: con un video (que tarda
  // más de un minuto en subir por QR) los agentes lo daban por perdido y lo
  // reenviaban varias veces. "enviando…" dice lo que de verdad está pasando.
  queued: { label: 'enviando…', className: 'text-slate-200', icon: 'clock', tip: 'Enviando a WhatsApp. Los videos y audios tardan más; no hace falta reenviarlo.' },
  sent: { label: 'enviado', className: 'text-emerald-100/80', icon: 'one', tip: 'Enviado a WhatsApp. Aún SIN confirmar que le llegó al contacto.' },
  delivered: { label: 'entregado', className: 'text-emerald-100', icon: 'two', tip: 'Entregado: llegó al teléfono del contacto.' },
  read: { label: 'leido', className: 'text-sky-200', icon: 'two', tip: 'Leído por el contacto.' },
  failed: { label: 'fallido', className: 'text-rose-100', icon: 'fail', tip: 'No se envió — el contacto NO lo recibió.' },
};

// Doble check estilo WhatsApp (dos ✓ solapados).
function DoubleCheck({ className }) {
  return (
    <span className={`relative inline-block w-4 h-3 ${className || ''}`}>
      <HiOutlineCheck className="w-3 h-3 absolute left-0 top-0" />
      <HiOutlineCheck className="w-3 h-3 absolute left-1 top-0" />
    </span>
  );
}

function DeliveryBadge({ msg }) {
  const meta = DELIVERY_META[msg.deliveryStatus] || DELIVERY_META.sent;
  return (
    <span className={`inline-flex items-center gap-0.5 ${meta.className}`} title={msg.errorMessage || meta.tip}>
      {meta.icon === 'fail' && <HiOutlineExclamationTriangle className="w-3 h-3" />}
      {meta.icon === 'clock' && <HiOutlineClock className="w-3 h-3" />}
      {meta.icon === 'one' && <HiOutlineCheck className="w-3 h-3" />}
      {meta.icon === 'two' && <DoubleCheck />}
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

function fmtAudioTime(s) {
  if (!s || !Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Velocidades de reproducción, en el mismo orden que WhatsApp (se van rotando
// con un toque). La elegida se recuerda para las siguientes notas de voz.
const AUDIO_SPEEDS = [1, 1.5, 2];
const AUDIO_SPEED_KEY = 'chat.audioSpeed';

function readSavedAudioSpeed() {
  try {
    const v = Number(localStorage.getItem(AUDIO_SPEED_KEY));
    return AUDIO_SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

// Reproductor de nota de voz estilo WhatsApp: botón play/pausa, barra de progreso
// y duración. Reemplaza al <audio controls> nativo (que se veía pobre).
function AudioPlayer({ src, isOut, onDownload }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(readSavedAudioSpeed);
  // El navegador no pudo decodificar el audio (Safari/iOS no reproduce ogg/opus,
  // que es el formato de TODAS las notas de voz de WhatsApp). En vez de un botón
  // de play que no hace nada, se ofrece descargarlo.
  const [failed, setFailed] = useState(false);

  // El navegador reinicia playbackRate al cargar la fuente, así que se vuelve a
  // aplicar en cada cambio de velocidad y al tener metadata (ver onLoadedMeta).
  useEffect(() => {
    const a = audioRef.current;
    if (a) a.playbackRate = rate;
  }, [rate]);

  const cycleRate = () => {
    const next = AUDIO_SPEEDS[(AUDIO_SPEEDS.indexOf(rate) + 1) % AUDIO_SPEEDS.length];
    setRate(next);
    try { localStorage.setItem(AUDIO_SPEED_KEY, String(next)); } catch { /* noop */ }
  };

  // Las notas de voz de MediaRecorder/OGG a veces reportan duration=Infinity hasta
  // que se busca al final; se fuerza UNA vez para conocer la duración real.
  const onLoadedMeta = () => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = rate;
    if (a.duration === Infinity || Number.isNaN(a.duration)) {
      const onSeeked = () => {
        a.removeEventListener('seeked', onSeeked);
        setDuration(Number.isFinite(a.duration) ? a.duration : 0);
        a.currentTime = 0;
      };
      a.addEventListener('seeked', onSeeked);
      try { a.currentTime = 1e6; } catch { /* noop */ }
    } else {
      setDuration(a.duration || 0);
    }
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    // `play()` puede rechazar (formato no soportado, o audio aún sin cargar): se
    // avisa en vez de dejar el botón muerto y en silencio.
    if (a.paused) {
      a.playbackRate = rate;
      a.play().catch(() => setFailed(true));
    } else a.pause();
  };

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
  };

  const pct = duration ? Math.min(100, (current / duration) * 100) : 0;
  // Muestra el tiempo transcurrido mientras suena; la duración total en reposo.
  const shown = playing || current > 0 ? current : duration;

  if (failed) {
    return (
      <button
        type="button"
        onClick={() => (onDownload ? onDownload() : saveMediaFile(src, 'nota-de-voz.ogg'))}
        className={`w-full text-left flex items-center gap-2 mb-1 rounded-lg px-2.5 py-2 border-none cursor-pointer ${
          isOut ? 'bg-emerald-600/40 hover:bg-emerald-600/60' : 'bg-slate-100 hover:bg-slate-200'
        }`}
      >
        <span className="text-2xl leading-none shrink-0">🎤</span>
        <span className="min-w-0">
          <span className={`block text-xs font-semibold ${isOut ? 'text-white' : 'text-slate-700'}`}>Nota de voz</span>
          <span className={`block text-[10px] ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
            Este navegador no puede reproducirla · Descargar
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-2 mb-1 min-w-[190px] max-w-[280px] ${isOut ? 'text-white' : 'text-slate-700'}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onError={() => setFailed(true)}
        onLoadedMetadata={onLoadedMeta}
        onDurationChange={() => {
          const d = audioRef.current?.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={() => setCurrent(audioRef.current?.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
      />
      <button
        type="button"
        onClick={toggle}
        title={playing ? 'Pausar' : 'Reproducir'}
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center border-none cursor-pointer ${isOut ? 'bg-white/25 hover:bg-white/40 text-white' : 'bg-emerald-500 hover:bg-emerald-600 text-white'}`}
      >
        {playing ? <HiOutlinePause className="w-4 h-4" /> : <HiOutlinePlay className="w-4 h-4 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div onClick={seek} className={`h-1.5 rounded-full cursor-pointer ${isOut ? 'bg-white/30' : 'bg-slate-200'}`}>
          <div className={`h-full rounded-full ${isOut ? 'bg-white' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`text-[10px] mt-1 tabular-nums ${isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          {fmtAudioTime(shown)}
        </div>
      </div>
      {/* Como en WhatsApp: la píldora de velocidad aparece al empezar a escuchar
          (o si ya se dejó fijada otra velocidad); si no, solo el ícono de micrófono. */}
      {playing || current > 0 || rate !== 1 ? (
        <button
          type="button"
          onClick={cycleRate}
          title={`Velocidad ${rate}x · toca para cambiar`}
          className={`shrink-0 h-6 px-1.5 rounded-full text-[11px] font-bold tabular-nums border-none cursor-pointer ${
            isOut ? 'bg-white/25 hover:bg-white/40 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-600'
          }`}
        >
          {rate}x
        </button>
      ) : (
        <span className="text-lg shrink-0" aria-hidden>🎤</span>
      )}
      {/* Guardar la nota de voz a disco (tanto las que llegan como las que enviamos). */}
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          title="Descargar audio"
          className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center border-none cursor-pointer ${
            isOut ? 'bg-white/25 hover:bg-white/40 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-600'
          }`}
        >
          <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// Descarga un adjunto del chat (documento, nota de voz…) a disco. Mismo criterio
// que `downloadChatMedia`: si es una URL del servidor se la damos al navegador
// con `?download=1`; solo los `data:` URL heredados pasan por Blob, porque el
// navegador no deja navegar a un data: URL.
async function saveMediaFile(url, filename) {
  if (!url) return;
  if (!url.startsWith('data:')) {
    triggerAnchorDownload(`${url}${url.includes('?') ? '&' : '?'}download=1`, filename);
    return;
  }
  try {
    await downloadFromUrl(url, filename);
  } catch {
    toast.error('No se pudo descargar el archivo');
  }
}

// Extensión real según el tipo MIME que sirve el backend (WhatsApp manda las
// fotos en jpeg, las notas de voz en ogg/opus, los videos en mp4…).
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'application/pdf': 'pdf',
};
const MEDIA_EXT_FALLBACK = { image: 'jpg', sticker: 'webp', video: 'mp4', audio: 'ogg', document: 'bin' };
const MEDIA_NAME_BASE = { image: 'foto', sticker: 'sticker', video: 'video', audio: 'nota-de-voz', document: 'documento' };

// "foto-2026-08-06-1425": nombre legible para la media que llega SIN nombre
// (WhatsApp solo informa el nombre real de los documentos).
function mediaBaseName(msg) {
  const d = new Date(msg?.createdAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${MEDIA_NAME_BASE[msg?.mediaType] || 'archivo'}-${stamp}`;
}

/**
 * Descarga a disco el adjunto de un mensaje (foto, video, sticker, nota de voz o
 * documento), tanto de los que llegan como de los que enviamos nosotros.
 *
 * SE ENTREGA LA URL AL NAVEGADOR, NO SE BAJA A MANO. Antes esto hacía
 * `fetch()` → Blob → `<a download>` sintético, y el resultado era el clásico "a
 * mí sí me baja y a mi compañero no", sin ningún error en pantalla:
 *   - el object URL se revocaba en el mismo tick del clic y Firefox/Safari
 *     cancelaban la descarga en silencio;
 *   - tras el `await fetch` Chrome ya no considera la descarga "hecha por el
 *     usuario" y la bloquea sola si la petición tardó unos segundos (conexión de
 *     oficina, PDF de varios MB);
 *   - y el archivo entero pasaba por la memoria de la pestaña.
 * Ahora se pide `?download=1` al endpoint público, que responde con
 * `Content-Disposition: attachment` (ver mediaController), así que basta un
 * enlace normal: lo guarda el gestor de descargas del navegador, funciona aunque
 * la media viva en otro dominio (PUBLIC_API_URL) y no hay tope de tamaño.
 *
 * Los adjuntos anteriores a la migración siguen siendo `data:` URLs, a los que el
 * navegador NO deja navegar: esos sí van por Blob.
 */
function downloadChatMedia(msg) {
  const url = msg?.mediaUrl;
  if (!url) return;
  if (url.startsWith('data:')) {
    downloadInlineMedia(msg);
    return;
  }
  const href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  // `download` es solo el nombre sugerido (y el navegador lo ignora entre
  // dominios): el nombre bueno lo manda el servidor en la cabecera.
  triggerAnchorDownload(href, chatMediaFilename(msg));
}

/** Adjunto que todavía viaja como data URL: se baja a Blob y se guarda. */
async function downloadInlineMedia(msg) {
  try {
    const res = await fetch(msg.mediaUrl);
    if (!res.ok) throw new Error('http');
    const blob = await res.blob();
    triggerBlobDownload(blob, chatMediaFilename(msg, blob.type));
  } catch {
    toast.error('No se pudo descargar el archivo');
  }
}

/**
 * Nombre con el que se guarda. WhatsApp solo informa el nombre real de los
 * documentos, así que a las fotos y notas de voz se les pone uno con la fecha y
 * la extensión que toca según el tipo MIME.
 */
function chatMediaFilename(msg, mimeType = '') {
  const name = String(msg.mediaName || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const ext = MIME_EXT[String(mimeType).split(';')[0].trim()] || MEDIA_EXT_FALLBACK[msg.mediaType] || 'bin';
  return `${name || mediaBaseName(msg)}.${ext}`;
}

// Botón de descarga superpuesto a una foto / video / sticker del chat.
function MediaDownloadButton({ msg, className = '' }) {
  return (
    <button
      type="button"
      title="Descargar"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadChatMedia(msg); }}
      className={`absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center bg-black/45 hover:bg-black/75 text-white border-none cursor-pointer opacity-80 hover:opacity-100 transition-opacity ${className}`}
    >
      <HiOutlineArrowDownTray className="w-4 h-4" />
    </button>
  );
}

// Etiqueta de la media por tipo, para cuando no se puede mostrar el archivo.
const MEDIA_LABEL = {
  image: '📷 Foto',
  video: '🎬 Video',
  audio: '🎤 Nota de voz',
  document: '📄 Documento',
  sticker: '🌟 Sticker',
};

function MessageMedia({ msg, isOut, onRetryMedia }) {
  const [retrying, setRetrying] = useState(false);
  // Las fotos que envía el contacto empiezan protegidas. El estado vive por
  // burbuja (MessageBubble usa msg._id como key), así revelar una no descubre las
  // demás ni afecta fotos de otros chats.
  const [imageRevealed, setImageRevealed] = useState(false);
  const url = msg.mediaUrl;
  const type = msg.mediaType || '';
  if (!url) {
    // Media que no se pudo descargar/guardar: se dice QUÉ llegó y POR QUÉ no está,
    // en vez de dejar la burbuja vacía (o perder el mensaje, como antes). El
    // archivo sigue en WhatsApp, así que se ofrece volver a pedirlo.
    if (type) {
      const label = type === 'document' ? `📄 ${msg.mediaName || 'Documento'}` : MEDIA_LABEL[type] || type;
      return (
        <div className={`mb-1 rounded-lg px-2.5 py-2 ${isOut ? 'bg-emerald-600/40' : 'bg-slate-100'}`}>
          <div className={`text-xs font-semibold ${isOut ? 'text-white' : 'text-slate-600'}`}>{label}</div>
          <div className={`text-[11px] mt-0.5 ${isOut ? 'text-emerald-100' : 'text-slate-500'}`}>
            No se pudo descargar el archivo de WhatsApp.
          </div>
          {msg.direction === 'in' && onRetryMedia && (
            <button
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await onRetryMedia(msg);
                } finally {
                  setRetrying(false);
                }
              }}
              className={`mt-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border-none cursor-pointer disabled:opacity-60 ${
                isOut ? 'bg-white/25 text-white hover:bg-white/40' : 'bg-emerald-600 text-white hover:bg-emerald-700'
              }`}
            >
              {retrying ? 'Recuperando…' : 'Reintentar descarga'}
            </button>
          )}
          {msg.errorMessage ? (
            <div className={`text-[10px] mt-1 italic break-words ${isOut ? 'text-emerald-100/80' : 'text-slate-400'}`}>
              {msg.errorMessage}
            </div>
          ) : null}
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
    return (
      <div className="relative inline-block mb-1">
        <img src={url} alt="sticker" className="max-h-28 w-auto block bg-transparent" />
        <MediaDownloadButton msg={msg} className="!w-6 !h-6" />
      </div>
    );
  }
  if (isImage) {
    const protectedImage = !isOut && !imageRevealed;
    return (
      <div className="relative inline-block mb-1 overflow-hidden rounded-lg bg-slate-200">
        {protectedImage ? (
          <div className="relative">
            <img
              src={url}
              alt="Imagen recibida oculta"
              className="rounded-lg max-h-60 w-auto block blur-xl scale-110 select-none pointer-events-none"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900/30 p-3">
              <button
                type="button"
                onClick={() => setImageRevealed(true)}
                aria-label="Ver imagen recibida"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/40 bg-slate-950/80 px-3 py-1.5 text-xs font-semibold text-white shadow-lg cursor-pointer hover:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-white/80"
              >
                <HiOutlineEye className="w-4 h-4" /> Ver imagen
              </button>
            </div>
          </div>
        ) : (
          <>
            <a href={url} target="_blank" rel="noreferrer" className="block">
              <img src={url} alt="adjunto" className="rounded-lg max-h-60 w-auto block" />
            </a>
            <MediaDownloadButton msg={msg} />
          </>
        )}
      </div>
    );
  }
  if (isVideo) {
    return (
      <div className="relative inline-block mb-1 max-w-full">
        <video controls src={url} className="rounded-lg max-h-60 w-auto block max-w-full" />
        <MediaDownloadButton msg={msg} />
      </div>
    );
  }
  if (isAudio) {
    return <AudioPlayer src={url} isOut={isOut} onDownload={() => downloadChatMedia(msg)} />;
  }
  // Documento: tarjeta con icono, nombre y tamaño (como WhatsApp), no un genérico
  // "Ver adjunto". El nombre real llega en `mediaName`. Al hacer clic se descarga
  // por `downloadChatMedia`, que se lo pasa al gestor de descargas del navegador
  // (ver ahí por qué NO se baja a Blob desde JavaScript).
  const name = msg.mediaName || 'Documento';
  const size = formatFileSize(msg.mediaSize);
  return (
    <button
      type="button"
      onClick={() => downloadChatMedia(msg)}
      className={`w-full text-left flex items-center gap-2 mb-1 rounded-lg px-2.5 py-2 border-none cursor-pointer ${
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
    </button>
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

// Resalta (en <mark>) las coincidencias del texto buscado dentro del cuerpo del
// mensaje. Solo se usa mientras el buscador del chat está abierto con texto.
function highlightMatches(text, term, isOut) {
  const t = String(text || '');
  const q = String(term || '').trim();
  if (!q) return t;
  const lower = t.toLowerCase();
  const ql = q.toLowerCase();
  const out = [];
  let i = 0;
  let k = 0;
  while (i < t.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) { out.push(t.slice(i)); break; }
    if (idx > i) out.push(t.slice(i, idx));
    out.push(
      <mark key={k++} className={`rounded px-0.5 ${isOut ? 'bg-yellow-300 text-slate-900' : 'bg-yellow-200 text-slate-900'}`}>
        {t.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return out;
}

function TypingIndicator({ agents = [] }) {
  const unique = [];
  const seen = new Set();
  for (const agent of agents) {
    const key = agent.userId || agent.typingId;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(agent);
  }
  if (!unique.length) return null;
  const names = unique.map((a) => a.name || 'Asesor');
  const label = names.length === 1
    ? `${names[0]} está escribiendo`
    : names.length === 2
      ? `${names[0]} y ${names[1]} están escribiendo`
      : `${names[0]} y ${names.length - 1} asesores más están escribiendo`;

  return (
    <div className="px-4 py-1.5 bg-slate-50 border-t border-slate-100 flex justify-end" aria-live="polite">
      <div className="inline-flex items-center gap-2 rounded-full bg-white border border-emerald-200 shadow-sm px-3 py-1.5 text-xs text-emerald-700">
        <span className="font-medium">{label}</span>
        <span className="inline-flex items-end gap-0.5 h-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

// Icono del chip según el tipo de evento interno.
const EVENT_ICON = {
  opportunity_created: '🎯',
  opportunity_stage_changed: '🔀',
};

/**
 * Burbuja de mensaje. MEMOIZADA por el mismo motivo que ConversationRow: el hilo
 * abierto trae hasta 80 mensajes y se repintaba entero con cada tecla escrita en
 * el compositor. Los manejadores llegan estables desde el padre (useCallback) y
 * `onReply` recibe el mensaje como argumento en vez de ser una flecha nueva por
 * burbuja en cada render.
 */
const MessageBubble = memo(function MessageBubble({ msg, onReply, onJumpTo, highlight, onRetry, onRetryMedia, onUseTemplate }) {
  // Evento INTERNO del sistema (kind='event'): chip centrado, visible SOLO para el
  // equipo (nunca se envió al contacto). P.ej. "Oportunidad creada".
  if (msg.kind === 'event') {
    return (
      <div className="flex justify-center my-1.5">
        <div className="max-w-[85%] text-center text-[11px] text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-3 py-1 flex items-center gap-1.5">
          <span>{EVENT_ICON[msg.eventType] || '•'}</span>
          <span className="font-medium">{msg.body}</span>
          {msg.sentByName && <span className="text-violet-400">· {msg.sentByName}</span>}
        </div>
      </div>
    );
  }
  const isOut = msg.direction === 'out';
  // Un saliente FALLIDO se muestra en ROJO (no verde) con un aviso claro y botón
  // "Reintentar": es peligroso que un mensaje que nunca salió parezca enviado.
  const failed = isOut && msg.deliveryStatus === 'failed';
  // En un timeout QR el proveedor no confirmó el resultado: NO se puede afirmar
  // que el contacto no lo recibió. Se distingue visualmente y el botón ejecutará
  // primero la comprobación antiduplicado del servidor.
  const unconfirmed = failed && isQrUnconfirmedError(msg);
  // Con el buscador abierto se resalta el término; si no, formato WhatsApp normal.
  const bodyContent = highlight && highlight.trim()
    ? highlightMatches(msg.body, highlight, isOut)
    : renderWhatsappText(msg.body);
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
      {isOut && <ReplyButton onClick={() => onReply?.(msg)} />}
      <div
        id={`msg-${msg._id}`}
        className={`max-w-[85%] @3xl:max-w-[70%] overflow-hidden rounded-lg px-3 py-2 text-sm shadow-sm transition-shadow ${
          unconfirmed
            ? 'bg-amber-500 text-white ring-2 ring-amber-300'
            : failed
              ? 'bg-rose-500 text-white ring-2 ring-rose-300'
            : isOut
              ? 'bg-emerald-500 text-white'
              : 'bg-white border border-slate-200 text-slate-800'
        }`}
      >
        {senderLabel && (
          <div className={`text-[11px] font-semibold mb-1 flex items-center gap-1 ${isOut ? 'text-white/95' : 'text-emerald-700'}`}>
            <HiOutlineUserCircle className="w-3.5 h-3.5" /> {senderLabel}
          </div>
        )}
        {/* Anuncio de origen (click-to-WhatsApp): de qué anuncio nos escriben.
            Solo entrantes y solo el 1er mensaje tras tocar el anuncio lo trae. */}
        {!isOut && msg.referral && (msg.referral.headline || msg.referral.sourceUrl || msg.referral.sourceId) && (
          <div className="mb-1.5 rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] leading-snug text-slate-700">
            <div className="flex items-center gap-1 text-violet-700 font-semibold mb-0.5">📣 Mensaje desde anuncio</div>
            {msg.referral.headline && (
              <div><span className="font-semibold">Headline:</span> {msg.referral.headline}</div>
            )}
            {msg.referral.sourceUrl && (
              <div className="truncate">
                <span className="font-semibold">Source URL:</span>{' '}
                <a href={msg.referral.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-600 underline">
                  {msg.referral.sourceUrl}
                </a>
              </div>
            )}
            {msg.referral.sourceId && (
              <div className="text-slate-400" title="ID del anuncio (source_id de Meta)">ID anuncio: {msg.referral.sourceId}</div>
            )}
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
        <MessageMedia msg={msg} isOut={isOut} onRetryMedia={onRetryMedia} />
        {msg.templateName && (
          <div className={`text-[10px] font-medium mb-0.5 ${isOut ? 'text-emerald-100' : 'text-slate-500'}`}>
            Plantilla · {msg.templateName}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{bodyContent}</div>
        {failed && (
          <div className="mt-1.5 rounded-md bg-white/20 px-2 py-1.5 text-[11px] leading-snug">
            <div className="flex items-center gap-1 font-bold">
              <HiOutlineExclamationTriangle className="w-3.5 h-3.5 shrink-0" />{' '}
              {unconfirmed
                ? 'Envío sin confirmar — podría haber llegado al contacto'
                : 'No se envió — el contacto NO lo recibió'}
            </div>
            {msg.errorMessage && <div className="text-white/95 mt-0.5 break-words">{msg.errorMessage}</div>}
            {/* Fuera de la ventana de 24h, reintentar el MISMO texto vuelve a
                fallar siempre: lo único que WhatsApp deja pasar es una plantilla
                aprobada. Se ofrece eso en lugar de un botón que no puede funcionar. */}
            {isOutOfWindowError(msg) && onUseTemplate ? (
              <button
                type="button"
                onClick={onUseTemplate}
                className="mt-1.5 inline-flex items-center gap-1 bg-white text-rose-600 font-bold rounded-md px-2.5 py-1 text-[11px] border-none cursor-pointer hover:bg-rose-50"
              >
                <HiOutlineDocumentDuplicate className="w-3.5 h-3.5" /> Enviar plantilla
              </button>
            ) : onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(msg)}
                className="mt-1.5 inline-flex items-center gap-1 bg-white text-rose-600 font-bold rounded-md px-2.5 py-1 text-[11px] border-none cursor-pointer hover:bg-rose-50"
              >
                <HiOutlineArrowPath className="w-3.5 h-3.5" /> {unconfirmed ? 'Comprobar y reintentar' : 'Reintentar'}
              </button>
            ) : null}
          </div>
        )}
        <div className={`text-[10px] mt-1 flex items-center gap-1 ${failed ? 'text-rose-100' : isOut ? 'text-emerald-100' : 'text-slate-400'}`}>
          <span title={fmtDateTime(msg.createdAt)}>{formatTime(msg.createdAt)}</span>
          {isOut && <span>·</span>}
          {isOut && <DeliveryBadge msg={msg} />}
        </div>
        {/* Botones AL FINAL, como en WhatsApp: hoja blanca pegada al fondo de la
            burbuja (el mismo componente que pinta la previsualización, para que
            lo que se ve al crear el mensaje sea lo que se ve en el chat).
            `-mx-3 -mb-2` compensa el padding px-3 py-2 de la burbuja. */}
        <WhatsappButtons buttons={msg.buttons} attached bleed="-mx-3 -mb-2" />
      </div>
      {!isOut && <ReplyButton onClick={() => onReply?.(msg)} />}
    </div>
  );
});

/**
 * Una fila "dato + botón de copiar". El icono cambia a un visto un segundo:
 * el agente necesita saber que copió sin apartar la vista del chat.
 */
function CopyRow({ icon: Icon, label, value, empty }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
        toast.success(`${label} copiado`);
      },
      () => toast.error('No se pudo copiar')
    );
  };

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-slate-400 leading-tight">{label}</div>
        {value ? (
          <div className="text-xs text-slate-700 truncate" title={value}>{value}</div>
        ) : (
          <div className="text-xs text-slate-400 italic">{empty}</div>
        )}
      </div>
      {value && (
        <button
          onClick={copy}
          title={`Copiar ${label.toLowerCase()}`}
          aria-label={`Copiar ${label.toLowerCase()}`}
          className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer"
        >
          {copied ? (
            <HiOutlineCheck className="w-4 h-4 text-emerald-600" />
          ) : (
            <HiOutlineDocumentDuplicate className="w-4 h-4" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Teléfono y correo del contacto, listos para copiar.
 *
 * El correo NO se pide en ningún formulario: sale de lo que el propio contacto
 * escribió en la conversación (lo detecta el backend al abrir el chat, ver
 * `findEmailInConversation`). Si el contacto ya es paciente y tiene correo en su
 * ficha, ese vale como respaldo.
 */
function ContactDataBlock({ conv, onUpdated }) {
  const hidden = isHiddenNumber(conv);
  const email = conv.detectedEmail || conv.patient?.email || '';

  return (
    <div className="border border-slate-200 rounded-xl p-2.5 space-y-2 bg-slate-50/50">
      <ContactNameRow conv={conv} onUpdated={onUpdated} />
      <CopyRow
        icon={HiOutlinePhone}
        label="Número de contacto"
        value={hidden ? '' : conv.phone}
        empty="WhatsApp aún no comparte su número"
      />
      <CopyRow
        icon={HiOutlineEnvelopeOpen}
        label="Correo electrónico"
        value={email}
        empty="Aún no lo ha escrito en el chat"
      />
    </div>
  );
}

/**
 * Nombre del contacto, editable.
 *
 * POR QUÉ EXISTE: lo que se ve arriba del chat es el nombre del PERFIL de
 * WhatsApp —"Yo…!!!", emojis, apodos—, que casi nunca es el nombre de la persona.
 * Los contactos sí nos dan su nombre, así que hace falta poder guardarlo: se
 * escribe aquí y pasa al momento a la lista, al avatar y a la cabecera.
 *
 * Lo escrito aquí queda sellado (`contactNameEditedAt`) y ninguna vía automática
 * —el contacto importado, un envío masivo— vuelve a tocarlo.
 */
function ContactNameRow({ conv, onUpdated }) {
  const [nombre, setNombre] = useState(conv.contactName || '');
  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  // Al cambiar de chat el componente se reutiliza: hay que resincronizar o se
  // quedaría mostrando el nombre del chat anterior. Se sincroniza SOLO por el id
  // del chat: enganchar esto al propio nombre hacía que cualquier recarga de la
  // bandeja (llega un mensaje, otro agente renombra) cerrara el editor y se
  // llevara por delante lo que el usuario estaba escribiendo.
  useEffect(() => {
    setNombre(conv.contactName || '');
    setEditando(false);
  }, [conv._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const guardar = async () => {
    const limpio = nombre.trim();
    if (limpio === (conv.contactName || '').trim()) {
      setEditando(false);
      return;
    }
    setGuardando(true);
    try {
      const r = await api.put(`/chats/${conv._id}`, { contactName: limpio });
      onUpdated?.(r.data);
      setEditando(false);
      toast.success(limpio ? 'Nombre actualizado' : 'Nombre borrado');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar el nombre');
      setNombre(conv.contactName || '');
    } finally {
      setGuardando(false);
    }
  };

  if (editando) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <HiOutlineUserCircle className="w-4 h-4 text-slate-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-slate-400 leading-tight">Nombre</div>
          <input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') guardar();
              if (e.key === 'Escape') { setNombre(conv.contactName || ''); setEditando(false); }
            }}
            placeholder="Nombre de la persona"
            className="w-full text-xs text-slate-700 border border-slate-300 rounded px-1.5 py-1 outline-none focus:border-emerald-500"
          />
        </div>
        <button
          onClick={guardar}
          disabled={guardando}
          title="Guardar nombre"
          aria-label="Guardar nombre"
          className="shrink-0 p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer disabled:opacity-50"
        >
          <HiOutlineCheck className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <HiOutlineUserCircle className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-slate-400 leading-tight">Nombre</div>
        {conv.contactName ? (
          <div className="text-xs text-slate-700 truncate" title={conv.contactName}>{conv.contactName}</div>
        ) : (
          <div className="text-xs text-slate-400 italic">Sin nombre — escríbelo aquí</div>
        )}
      </div>
      <button
        // Se toma el valor vigente al abrir el editor, no el que quedó guardado
        // en el estado: entre medias pudo renombrarlo otro agente.
        onClick={() => { setNombre(conv.contactName || ''); setEditando(true); }}
        title="Editar nombre"
        aria-label="Editar nombre"
        className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer"
      >
        <HiOutlinePencilSquare className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Sección PLEGABLE del panel del contacto (columna derecha del chat).
 *
 * Automatizaciones y Oportunidades arrancan CERRADAS. Abrir un chat soltaba de
 * golpe el historial de automatizaciones y la lista de oportunidades, y lo que el
 * agente venía a mirar —quién es el contacto— quedaba debajo de todo eso. El
 * resumen (cuántas hay, cuántas activas) se lee en la cabecera sin desplegar nada.
 *
 * `action` es el botón propio de la sección (refrescar, "Editar / añadir"): va
 * FUERA del botón que pliega, porque un botón dentro de otro no es HTML válido y
 * el navegador lo desarma.
 */
function CollapsibleSection({ icon: Icon, iconClass = '', title, count = 0, badge = null, action = null, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? 'Contraer' : 'Desplegar'}
          className="flex items-center gap-1 min-w-0 text-xs font-semibold text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer p-0 text-left"
        >
          <HiOutlineChevronRight
            className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {Icon && <Icon className={`w-3.5 h-3.5 shrink-0 ${iconClass}`} />}
          <span className="truncate">
            {title}
            {count > 0 ? ` (${count})` : ''}
          </span>
          {badge}
        </button>
        {action}
      </div>
      {open && children}
    </div>
  );
}

/**
 * Automatizaciones que se han ACTIVADO en este chat (inscripciones del contacto).
 *
 * Va justo debajo de los datos del contacto porque es seguimiento puro: el agente
 * necesita saber qué le está mandando el sistema por su cuenta antes de escribirle
 * (no repetir un recordatorio, ver si un envío falló por la ventana de 24h, o
 * entender por qué el contacto responde a algo que nadie escribió a mano).
 *
 * Cada tarjeta se despliega con el registro de ejecución paso a paso.
 */
function ChatAutomationsSection({ conv, version = 0 }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null); // inscripción con el detalle abierto
  const [tick, setTick] = useState(0); // recarga manual (los pasos corren en el servidor)

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setOpenId(null);
    api
      .get(`/chats/${conv._id}/automations`)
      .then((r) => alive && setRows(Array.isArray(r.data) ? r.data : []))
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [conv._id, version, tick]);

  // Por qué entró: el evento guardado al inscribir y, si no, los disparadores
  // del flujo. 'manual' = la lanzó un agente desde el menú ⚡ del compositor.
  const reasonOf = (a) => {
    if (a.eventType === 'manual') return 'Ejecutada a mano por un agente';
    const label = TRIGGER_LABELS_CHAT[a.eventType];
    if (label) return label;
    const fromFlow = (a.triggerTypes || []).map((t) => TRIGGER_LABELS_CHAT[t] || t).join(' / ');
    return fromFlow || 'Automática';
  };

  const live = rows.filter((a) => a.status === 'active' || a.status === 'waiting').length;

  // Las inscripciones se cargan aunque la sección esté plegada: el número y el
  // aviso de "activa" son justo lo que hace falta ver sin desplegarla.
  return (
    <CollapsibleSection
      icon={HiOutlineBolt}
      iconClass="text-amber-500"
      title="Automatizaciones"
      count={rows.length}
      badge={
        live > 0 ? (
          <span className="text-[10px] font-medium bg-amber-100 text-amber-700 px-1.5 rounded-full shrink-0" title="En ejecución o en espera de su próximo paso">
            {live} activa{live > 1 ? 's' : ''}
          </span>
        ) : null
      }
      action={
        <button
          onClick={() => setTick((t) => t + 1)}
          title="Actualizar"
          aria-label="Actualizar automatizaciones"
          disabled={loading}
          className="p-1 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 bg-transparent border-none cursor-pointer disabled:opacity-50 shrink-0"
        >
          <HiOutlineArrowPath className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      }
    >
      {loading ? (
        <div className="text-xs text-slate-400">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-400">Ninguna automatización se ha activado en este chat.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => {
            const st = ENROLL_STATUS[a.status] || ENROLL_STATUS.active;
            const isOpen = openId === a._id;
            return (
              <div key={a._id} className="border border-slate-100 rounded-lg p-2 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-medium text-slate-700 min-w-0 break-words">{a.name}</div>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                </div>
                <div className="text-[10px] text-slate-500">
                  {reasonOf(a)} · {fmtDateTime(a.startedAt)}
                </div>
                {a.status === 'waiting' && (
                  <div className="text-[10px] text-amber-700">
                    {a.waitingForReply
                      ? 'Esperando la respuesta del contacto'
                      : `Próximo paso: ${fmtDateTime(a.nextRunAt) || 'por programar'}`}
                  </div>
                )}
                {a.lastError && (
                  <div className="text-[10px] text-rose-600 bg-rose-50 border border-rose-100 rounded px-1.5 py-1">
                    {a.lastError}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] text-slate-400">
                    <span className="text-emerald-600 font-medium">{a.okCount}</span> paso{a.okCount === 1 ? '' : 's'}
                    {a.failCount > 0 && <span className="text-rose-600 font-medium"> · {a.failCount} fallido{a.failCount > 1 ? 's' : ''}</span>}
                  </div>
                  {a.log.length > 0 && (
                    <button
                      onClick={() => setOpenId(isOpen ? null : a._id)}
                      className="text-[10px] text-emerald-600 hover:underline bg-transparent border-none cursor-pointer p-0"
                    >
                      {isOpen ? 'Ocultar detalle' : 'Ver detalle'}
                    </button>
                  )}
                </div>
                {isOpen && (
                  <ol className="grid gap-1 border-t border-slate-100 pt-1.5">
                    {a.log.map((l, i) => (
                      <li key={i} className="text-[10px] flex items-start gap-1.5">
                        <span className={l.ok ? 'text-emerald-500' : 'text-rose-500'}>{l.ok ? '✓' : '✗'}</span>
                        <span className="text-slate-400 shrink-0">{fmtDateTime(l.at)}</span>
                        <span className="min-w-0">
                          <span className="font-medium text-slate-600">{STEP_LABELS[l.type] || l.type}</span>
                          {l.info && <span className={l.ok ? ' text-slate-500' : ' text-rose-600'}> — {l.info}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {!a.deleted && (
                  <Link to={`/workflows/${a.workflowId}/edit`} className="text-[10px] text-slate-400 hover:text-emerald-600">
                    Ver la automatización
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

function SidePanel({ conv, agents = [], meId, onUpdated, onEditOpportunity, onScheduleAppointment, onCreateQuotation, automationsVersion = 0 }) {
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
        <div className="text-xs text-slate-500 mt-0.5">
          {isHiddenNumber(conv) ? (
            <span className="italic" title="WhatsApp aún no comparte el teléfono de este contacto (número oculto).">
              Número oculto
            </span>
          ) : (
            conv.phone
          )}
        </div>
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

      {/* Datos para copiar de un clic: el agente los pega en el sistema, en un
          correo o en una llamada sin tener que buscarlos por el chat. El correo
          sale de lo que el propio contacto escribió en la conversación. */}
      <ContactDataBlock conv={conv} onUpdated={onUpdated} />

      {/* Qué le está enviando el sistema solo a este contacto (seguimiento). */}
      <ChatAutomationsSection conv={conv} version={automationsVersion} />

      {registerModal && (
        <RegisterPatientModal
          conv={conv}
          onClose={() => setRegisterModal(false)}
          onRegistered={(c) => { setRegisterModal(false); onUpdated?.(c); toast.success('Paciente agregado al sistema'); }}
        />
      )}

      {(() => {
        // Todas las oportunidades del chat (una por anuncio/interés). El campo
        // `opportunity` es solo el espejo de la última; aquí se listan todas.
        const opsList = (conv.opportunities || []).length
          ? conv.opportunities
          : op.isOpportunity
          ? [op]
          : [];
        return (
          <CollapsibleSection
            title="Oportunidades"
            count={opsList.length}
            action={
              <button onClick={onEditOpportunity} className="text-[10px] text-emerald-600 hover:underline shrink-0">
                {opsList.length > 0 ? 'Editar / añadir' : 'Crear'}
              </button>
            }
          >
            {opsList.length === 0 ? (
                <div className="text-xs text-slate-400">No es una oportunidad aún.</div>
              ) : (
                <div className="space-y-2">
                  {opsList.map((o, idx) => {
                    const m = STAGES.find((s) => s.value === o.stage) || STAGES[0];
                    return (
                      <div key={idx} className="border border-slate-100 rounded-lg p-2 space-y-1 text-sm">
                        {o.name && (
                          <div className="text-xs font-semibold text-slate-700 truncate" title={o.name}>{o.name}</div>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <span className={`inline-block text-[11px] px-2 py-0.5 rounded ${m.color}`}>{m.label}</span>
                          {o.expectedValue > 0 && (
                            <span className="text-[11px] text-slate-500" title={o.valueMode === 'manual' ? 'Valor manual' : 'Valor desde inventario'}>
                              ${Number(o.expectedValue).toFixed(2)}{o.valueMode === 'manual' ? ' ✎' : ''}
                            </span>
                          )}
                        </div>
                        {(o.attribution?.adId || o.attribution?.campaign) && (
                          <div
                            title={o.attribution.adId ? `ID del anuncio (source_id de Meta): ${o.attribution.adId}` : ''}
                            className="text-[10px] text-violet-700 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5 inline-block"
                          >
                            📣 {o.attribution.campaign ? `${o.attribution.campaign} ` : 'Anuncio '}
                            {o.attribution.adId ? `#${o.attribution.adId}` : ''}
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
          </CollapsibleSection>
        );
      })()}

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
          {conv.channel === 'whatsapp' && <ReplyNumberSelector conv={conv} onUpdated={onUpdated} />}
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

// Selector "Responder desde": muestra por qué número (global) se responde ESTA
// conversación y permite cambiarlo. Normalmente el sistema lo enlaza SOLO al recibir
// (se responde desde el mismo número al que el contacto escribió); esto da control y
// visibilidad, y arregla conversaciones viejas que caían en el número por defecto.
function ReplyNumberSelector({ conv, onUpdated }) {
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/chats/accounts').then((r) => { if (alive) setAccounts(r.data || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const current = String(conv.whatsappAccount?._id || conv.whatsappAccount || '');
  const labelOf = (a) => `${a.label}${a.connectionType === 'qr' ? ' · QR' : ' · Cloud API'}`;

  const change = async (id) => {
    if (!id || id === current) return;
    setSaving(true);
    try {
      const r = await api.patch(`/chats/${conv._id}/account`, { whatsappAccountId: id });
      onUpdated?.(r.data);
      toast.success('Esta conversación responderá desde ese número');
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo cambiar el número');
    } finally {
      setSaving(false);
    }
  };

  // Con un solo número no hay nada que elegir: se muestra cuál es.
  if (accounts.length <= 1) {
    const only = conv.whatsappAccount || accounts[0];
    if (!only?.label) return null;
    return (
      <div>
        Responder desde: <span className="text-slate-800">{only.label}</span>
        {only.connectionType && (
          <span className="text-slate-400"> · {only.connectionType === 'qr' ? 'QR' : 'Cloud API'}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span>Responder desde:</span>
      <select
        value={current}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        title="El número por el que sale tu respuesta. Se enlaza solo al número por el que el contacto te escribió; puedes cambiarlo aquí."
        className="border border-slate-200 rounded-md px-1.5 py-0.5 text-xs bg-white cursor-pointer disabled:opacity-50"
      >
        {!current && <option value="">(elige un número)</option>}
        {accounts.map((a) => <option key={a._id} value={a._id}>{labelOf(a)}</option>)}
      </select>
    </div>
  );
}

// Etiquetas del contacto/conversación (libres, para segmentar). Se guardan en
// Conversation.tags vía PUT /chats/:id.
function ConvTagsSection({ conv, onUpdated }) {
  const [tags, setTags] = useState(conv.tags || []);
  const [saving, setSaving] = useState(false);
  // Las etiquetas de chat que YA existen, para el buscador: escritas de memoria,
  // "promo" y "Promo" acaban siendo dos etiquetas distintas y los filtros y los
  // segmentos se parten sin que nadie se entere.
  const [sugerencias, setSugerencias] = useState([]);
  useEffect(() => {
    let vivo = true;
    api.get('/chats/opportunities/catalog')
      .then((r) => { if (vivo) setSugerencias(r.data?.chatTags || []); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

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
      <TagEditor value={tags} onChange={save} suggestions={sugerencias} />
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
          <DateTimeInput
            id={`task-due-${conv._id}`}
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
  // `conv.phone` solo es un teléfono real en WhatsApp: en Messenger/Instagram es
  // el identificador interno del contacto (PSID/IGSID), no algo que se pueda
  // marcar. Ahí el agente tiene que escribir el teléfono real (si el contacto lo
  // dio) para vincular este chat con su WhatsApp — ver registerPatientFromChat.
  const isWhatsapp = (conv.channel || 'whatsapp') === 'whatsapp';
  const [form, setForm] = useState({
    firstName: guessName[0] || '',
    lastName: guessName.slice(1).join(' ') || '',
    cedula: '',
    gender: '',
    phone: '',
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
    if (!isWhatsapp && !form.phone.trim()) {
      return toast.error(`Este chat es de ${CHANNEL_TAB_LABELS[conv.channel] || conv.channel}: escribe el teléfono real del contacto.`);
    }
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
        {isWhatsapp ? (
          <p className="text-xs text-slate-500">Teléfono: {conv.phone}</p>
        ) : (
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              Teléfono / WhatsApp real del contacto *
            </label>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="Ej: 0991234567"
              className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Este chat es de {CHANNEL_TAB_LABELS[conv.channel] || conv.channel}: Meta no comparte el teléfono real
              del contacto ahí. Si lo escribes aquí, el sistema reconocerá solo su próximo mensaje de WhatsApp como
              la misma persona (y podrás responderle por cualquiera de los dos canales desde este chat).
            </p>
          </div>
        )}
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

// Oportunidad en blanco (la del botón "+ Agregar otra"). El nombre lo pone el
// servidor si se deja vacío ("<servicios> — <contacto>").
const blankOpportunity = () => ({
  name: '', stage: 'nuevo', notes: '', lostReason: '', tags: [],
  valueMode: 'auto', expectedValue: 0, interested: [],
});

function OpportunityModal({ conv, services, onClose, onSaved }) {
  // Soporta MÚLTIPLES oportunidades por chat. Para compatibilidad, si solo existe
  // la oportunidad legacy `opportunity`, la convertimos al array en pantalla.
  const initial = useMemo(() => {
    const list = Array.isArray(conv.opportunities) && conv.opportunities.length > 0
      ? conv.opportunities
      : (conv.opportunity?.isOpportunity ? [conv.opportunity] : []);
    return list.map((op) => ({
      _existingIdx: list === conv.opportunities ? list.indexOf(op) : -1,
      name: op.name || '',
      stage: op.stage || 'nuevo',
      notes: op.notes || '',
      lostReason: op.lostReason || '',
      tags: op.tags || [],
      valueMode: op.valueMode === 'manual' ? 'manual' : 'auto',
      expectedValue: Number(op.expectedValue || 0),
      attribution: op.attribution || null, // solo lectura: anuncio de origen
      interested: (op.interestedIn || []).map((s) => s.product?._id || s.product || '').filter(Boolean),
    }));
  }, [conv]);
  const [items, setItems] = useState(initial.length > 0 ? initial : [blankOpportunity()]);
  const [saving, setSaving] = useState(false);

  /**
   * LO QUE YA EXISTE: nombres de oportunidad y etiquetas en uso.
   *
   * Escritos a mano, "Prostata 1", "prostata 1" y "Próstata 1" son tres filas
   * distintas en el embudo y en la gráfica "Qué oportunidades son": las métricas
   * se partían por una tilde. Ofreciendo lo que ya se usa (lo más usado primero),
   * quien atiende ELIGE lo de siempre y solo escribe cuando es algo nuevo.
   *
   * Si la petición falla, los campos siguen siendo de texto libre: el catálogo
   * ayuda, no bloquea.
   */
  const [catalogo, setCatalogo] = useState({ names: [], tags: [] });
  useEffect(() => {
    let vivo = true;
    api.get('/chats/opportunities/catalog')
      .then((r) => { if (vivo) setCatalogo({ names: r.data?.names || [], tags: r.data?.tags || [] }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // Calcular valor esperado desde inventario (precio del producto).
  const valueOf = (interested) =>
    interested
      .filter(Boolean)
      .reduce((sum, id) => {
        const s = services.find((x) => x._id === id);
        return sum + (s ? Number(s.salePrice || 0) : 0);
      }, 0);
  // Lo que se verá en el embudo: el manual manda; el automático sale del inventario.
  const shownValue = (it) => (it.valueMode === 'manual' ? Number(it.expectedValue || 0) : valueOf(it.interested));
  // Contacto al que pertenecen estas oportunidades (sale del chat, no se duplica).
  const contact = {
    name: conv.patient ? `${conv.patient.firstName || ''} ${conv.patient.lastName || ''}`.trim() : (conv.contactName || ''),
    phone: conv.phone || '',
    email: conv.patient?.email || '',
    isPatient: !!conv.patient,
  };

  const submit = async () => {
    setSaving(true);
    try {
      let nextConv = conv;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const payload = {
          name: it.name || '',
          stage: it.stage,
          notes: it.notes,
          lostReason: it.stage === 'perdido' ? it.lostReason : '',
          tags: it.tags || [],
          valueMode: it.valueMode === 'manual' ? 'manual' : 'auto',
          expectedValue: it.valueMode === 'manual' ? Number(it.expectedValue || 0) : undefined,
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
        {/* Contacto al que pertenecen: la oportunidad SIEMPRE cuelga de este chat. */}
        <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/70">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Contacto</div>
          <div className="font-medium text-slate-800">{contact.name || 'Sin nombre'}</div>
          <div className="text-xs text-slate-500 flex flex-wrap gap-x-3">
            {contact.phone && <span>📞 {contact.phone}</span>}
            {contact.email && <span>✉️ {contact.email}</span>}
            <span className={contact.isPatient ? 'text-emerald-700' : 'text-amber-700'}>
              {contact.isPatient ? '✓ Paciente vinculado' : 'Sin paciente vinculado'}
            </span>
          </div>
        </div>
        {items.map((it, idx) => (
          <div key={idx} className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/40 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-emerald-700 flex items-center gap-2 min-w-0">
                {it.name?.trim() || `Oportunidad #${idx + 1}`}
                {(it.attribution?.adId || it.attribution?.campaign) && (
                  <span
                    title={it.attribution.adId ? `ID del anuncio (source_id de Meta): ${it.attribution.adId}` : ''}
                    className="text-[10px] font-normal text-violet-700 bg-violet-50 border border-violet-100 rounded px-1.5 py-0.5 truncate"
                  >
                    📣 {it.attribution.campaign ? `${it.attribution.campaign} ` : 'Anuncio '}
                    {it.attribution.adId ? `#${it.attribution.adId}` : ''}
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
              <label className="text-xs font-semibold text-slate-600 block mb-1">Nombre de la oportunidad</label>
              <SuggestInput
                value={it.name}
                onChange={(v) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, name: v } : x))}
                onSelect={(v) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, name: v } : x))}
                options={catalogo.names}
                placeholder="Busca una ya creada o escribe una nueva"
                emptyHint="Todavía no hay ninguna oportunidad con nombre. Escribe la primera."
                className="w-full border border-slate-200 rounded-xl pl-3.5 pr-8 py-2.5 text-sm bg-white outline-none focus:border-emerald-400"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Elige una de la lista para que cuente junto a las demás en el embudo. Si lo dejas vacío se nombra sola con los servicios y el contacto.
              </p>
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
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Valor esperado</label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={it.valueMode}
                  onChange={(e) => setItems((prev) => prev.map((x, i) => i === idx
                    ? { ...x, valueMode: e.target.value, expectedValue: e.target.value === 'manual' && !x.expectedValue ? valueOf(x.interested) : x.expectedValue }
                    : x))}
                  className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
                >
                  <option value="auto">Automático (desde inventario)</option>
                  <option value="manual">Manual</option>
                </select>
                {it.valueMode === 'manual' ? (
                  <div className="flex items-center gap-1">
                    <span className="text-slate-500">$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={it.expectedValue}
                      onChange={(e) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, expectedValue: e.target.value } : x))}
                      className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
                    />
                  </div>
                ) : (
                  <span className="text-[11px] text-emerald-700">
                    Suma de los servicios: <b>${valueOf(it.interested).toFixed(2)}</b>
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                En “manual” el importe no cambia aunque cambies los servicios (paquetes, descuentos, presupuestos).
                Valor en el embudo: <b className="text-emerald-700">${Number(shownValue(it) || 0).toFixed(2)}</b>
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600 block mb-1">Etiquetas</label>
              <TagEditor
                value={it.tags || []}
                onChange={(next) => setItems((prev) => prev.map((x, i) => i === idx ? { ...x, tags: next } : x))}
                suggestions={catalogo.tags}
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
          onClick={() => setItems((prev) => [...prev, blankOpportunity()])}
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

// Hora ecuatoriana de un instante ('07:42 p. m.'). Vacío = no hubo mensaje.
function fmtHourEc(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('es-EC', {
    timeZone: 'America/Guayaquil',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 'AAAA-MM-DD' → 'lun 24/08'. Se arma a mediodía para que el cambio de día no
// dependa de la zona horaria del navegador.
function fmtDayLabelEc(dayKey) {
  const d = new Date(`${dayKey}T12:00:00`);
  const wd = d.toLocaleDateString('es-EC', { weekday: 'short' });
  return `${wd} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Minutos de desvío → '+25 min' / '—'.
const fmtDeviation = (min) => (min == null || min <= 0 ? '—' : `+${fmtMinutes(min)}`);

/**
 * CUMPLIMIENTO DE HORARIO (panel de Supervisión).
 *
 * Contesta la pregunta de siempre: ¿a qué hora empezó a escribir cada asesor, a
 * qué hora dejó de hacerlo y cuántos chats atendió DE VERDAD ese día? Solo cuentan
 * los mensajes que escribió una persona: las automatizaciones y las difusiones no
 * entran (si entraran, un workflow nocturno haría parecer que el asesor trabajó
 * hasta las 3 de la mañana).
 *
 * Se carga aparte de /chats/stats: es una agregación sobre MENSAJES, mucho más
 * pesada que las de conversaciones, y no tiene por qué retrasar el resto del panel.
 */
function ScheduleComplianceSection({ range }) {
  // El rango pedido va DENTRO del estado: así "cargando" se deduce de comparar
  // lo cargado con lo que se pide ahora, sin un setState suelto dentro del
  // efecto (que dispara un render en cascada y lo marca el linter).
  const rangeKey = `${range?.from || ''}|${range?.to || ''}`;
  const [loaded, setLoaded] = useState({ key: null, data: null });
  const [showAllDays, setShowAllDays] = useState(false);
  const loading = loaded.key !== rangeKey;
  const data = loaded.key === rangeKey ? loaded.data : null;

  useEffect(() => {
    let alive = true;
    api
      .get('/chats/agent-activity', {
        params: {
          ...(range?.from ? { from: range.from } : {}),
          ...(range?.to ? { to: range.to } : {}),
        },
      })
      .then((r) => alive && setLoaded({ key: rangeKey, data: r.data }))
      .catch(() => alive && setLoaded({ key: rangeKey, data: null }));
    return () => {
      alive = false;
    };
  }, [rangeKey, range?.from, range?.to]);

  const rows = data?.rows || [];
  const totals = data?.totals || [];
  const tolerance = data?.toleranceMinutes ?? 10;
  const visibleRows = showAllDays ? rows : rows.slice(0, 40);

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-4">
      <h2 className="font-semibold text-slate-800 mb-2">Cumplimiento de horario</h2>

      {loading ? (
        <div className="text-sm text-slate-400 py-4">Cargando…</div>
      ) : (
        <>
          {/* Resumen del periodo, por asesor */}
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Asesor</th>
                  <th className="text-right px-3 py-2">Chats atendidos</th>
                  <th className="text-right px-3 py-2">Mensajes</th>
                  <th className="text-right px-3 py-2">Días con actividad</th>
                  <th className="text-right px-3 py-2">Días de turno</th>
                  <th className="text-right px-3 py-2">Sin actividad</th>
                  <th className="text-right px-3 py-2">Días con retraso</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((t) => (
                  <tr key={t.agentId} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{t.agentName}</td>
                    <td className="px-3 py-2 text-right font-semibold">{t.manualChats}</td>
                    <td className="px-3 py-2 text-right">{t.manualMessages}</td>
                    <td className="px-3 py-2 text-right">{t.activeDays}</td>
                    <td className="px-3 py-2 text-right text-slate-500">
                      {t.scheduledDays || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={t.absentDays > 0 ? 'text-rose-600 font-bold' : 'text-slate-400'}>
                        {t.scheduledDays ? t.absentDays : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={t.lateDays > 0 ? 'text-amber-700 font-semibold' : 'text-slate-400'}>
                        {t.scheduledDays ? t.lateDays : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
                {totals.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-sm">
                      Nadie escribió mensajes a mano en este periodo
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Día a día */}
          <h3 className="text-sm font-semibold text-slate-700 mt-5 mb-2">Día a día</h3>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">Día</th>
                  <th className="text-left px-3 py-2">Asesor</th>
                  <th className="text-left px-3 py-2">Turno</th>
                  <th className="text-right px-3 py-2">Primer mensaje</th>
                  <th className="text-right px-3 py-2">Último mensaje</th>
                  <th className="text-right px-3 py-2">Entró tarde</th>
                  <th className="text-right px-3 py-2">Salió antes</th>
                  <th className="text-right px-3 py-2">Fuera de franja</th>
                  <th className="text-right px-3 py-2">Chats</th>
                  <th className="text-right px-3 py-2">Mensajes</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr
                    key={`${r.agentId}-${r.day}`}
                    className={`border-t border-slate-100 ${r.absent ? 'bg-rose-50/60' : ''}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDayLabelEc(r.day)}</td>
                    <td className="px-3 py-2 font-medium">{r.agentName}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                      {/* TODAS las franjas del día, no el bloque de la primera a
                          la última: 08–12 y 14–18 no es lo mismo que 08–18. */}
                      {r.shift
                        ? (r.shift.intervals || []).map((i) => `${i.start}–${i.end}`).join(', ') || `${r.shift.start}–${r.shift.end}`
                        : 'Sin horario'}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{fmtHourEc(r.firstAt)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{fmtHourEc(r.lastAt)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={r.lateMinutes > tolerance ? 'text-amber-700 font-semibold' : 'text-slate-400'}>
                        {r.absent ? 'No escribió' : fmtDeviation(r.lateMinutes)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={r.earlyLeaveMinutes > tolerance ? 'text-amber-700 font-semibold' : 'text-slate-400'}>
                        {r.absent ? '—' : fmtDeviation(r.earlyLeaveMinutes)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {/* Mensajes escritos fuera de sus franjas: en el almuerzo,
                          antes de entrar o después de salir. */}
                      <span className={r.outOfShiftMessages > 0 ? 'text-amber-700 font-semibold' : 'text-slate-400'}>
                        {r.outOfShiftMessages == null ? '—' : r.outOfShiftMessages}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{r.manualChats}</td>
                    <td className="px-3 py-2 text-right">{r.manualMessages}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-slate-400 text-sm">
                      Sin actividad manual en este periodo
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > visibleRows.length && (
            <button
              type="button"
              onClick={() => setShowAllDays(true)}
              className="mt-2 text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer p-0"
            >
              Ver los {rows.length - visibleRows.length} días restantes
            </button>
          )}

          <p className="text-[11px] text-slate-400 mt-3">
            Solo se cuentan los mensajes <strong>escritos por una persona</strong>: quedan fuera las
            automatizaciones, las respuestas automáticas y los envíos masivos. Un chat con veinte
            mensajes cuenta como <strong>un</strong> chat atendido. El <strong>turno</strong> es el
            configurado en Config. Call Center; «entró tarde» y «salió antes» se miden contra él con{' '}
            {tolerance} min de tolerancia, y las filas en rojo son días de turno en los que el asesor
            no escribió nada. <strong>«Fuera de franja»</strong> son los mensajes escritos fuera de
            sus horarios —en el almuerzo, antes de entrar o después de salir—; se cuentan por tramos
            de 15 minutos.
            {data?.scheduleDaysOmitted && (
              <>
                {' '}El rango elegido pasa de {data.maxScheduleDays} días: aquí solo salen los días
                <strong> con actividad</strong>, así que las ausencias no están calculadas. Acorta el
                rango para verlas.
              </>
            )}{' '}
            Los mensajes escritos <strong>desde el teléfono</strong> en un número QR no pasan por el
            sistema y no se pueden atribuir a nadie: no entran en esta tabla.
          </p>
        </>
      )}
    </section>
  );
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
          <DateInput
            value={range?.from || ''}
            max={range?.to || undefined}
            onChange={(e) => onRangeChange({ ...range, from: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1 text-xs"
          />
          <span className="text-xs text-slate-400">a</span>
          <DateInput
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
                  <td className="px-3 py-2 font-medium">
                    {r.name || 'Sin asignar'}
                    {r.scheduleApplied && (
                      <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                        horario aplicado
                      </span>
                    )}
                  </td>
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
          Umbral de SLA: {sla.thresholdMinutes} min. En verde, agentes dentro del umbral. Cuando aparece
          <b> horario aplicado</b>, las noches y días libres configurados en Config. Call Center no forman
          parte del tiempo de respuesta.
        </p>
      </section>


      <ScheduleComplianceSection range={range} />

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
            <DateInput
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

/**
 * Transferir chat: pasa la conversación a otro compañero de la bandeja.
 * Sustituye al antiguo botón "Auto-asignar" — el reparto automático sigue
 * disponible aquí dentro, pero solo para admin/supervisor.
 */
function TransferChatModal({ conv, meId, canAutoAssign, onClose, onTransfer }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState('');

  useEffect(() => {
    api
      .get('/chats/assignable-users')
      .then((r) => setUsers(r.data || []))
      .catch(() => toast.error('No se pudo cargar la lista de usuarios'))
      .finally(() => setLoading(false));
  }, []);

  const currentId = String(conv.assignedTo?._id || conv.assignedTo || '');
  const norm = (s) => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const shown = users.filter((u) => !q.trim() || norm(u.name).includes(norm(q)));

  const send = async (userId) => {
    setSending(userId || 'auto');
    await onTransfer(userId);
    setSending('');
  };

  return (
    <ModalShell title="Transferir chat" onClose={onClose} size="sm">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Elige a quién le pasas la conversación de <b>{conv.contactName || conv.phone}</b>.
          {conv.assignedToName && <> Ahora la tiene <b>{conv.assignedToName}</b>.</>}
        </p>
        <p className="text-[11px] text-slate-400 -mt-1">
          Solo aparecen quienes atienden la bandeja de esta sede: call center, marketing y administradores.
        </p>

        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar compañero..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg bg-slate-50/60 outline-none text-sm"
          />
        </div>

        {canAutoAssign && (
          <button
            type="button"
            disabled={!!sending}
            onClick={() => send(null)}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 cursor-pointer text-left disabled:opacity-50"
          >
            <HiOutlineBolt className="w-5 h-5 text-emerald-600 shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-emerald-800">Automático</span>
              <span className="block text-[11px] text-emerald-700/80">
                Al asesor en turno con menos chats abiertos
              </span>
            </span>
            {sending === 'auto' && <span className="text-xs text-emerald-700">Enviando…</span>}
          </button>
        )}

        <div className="max-h-72 overflow-y-auto -mx-1 px-1 space-y-1">
          {loading ? (
            <p className="text-xs text-slate-400 text-center py-6">Cargando usuarios…</p>
          ) : shown.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-6">Sin resultados</p>
          ) : (
            shown.map((u) => {
              const isCurrent = String(u._id) === currentId;
              const isMe = String(u._id) === String(meId);
              return (
                <button
                  key={u._id}
                  type="button"
                  disabled={isCurrent || !!sending}
                  onClick={() => send(u._id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left cursor-pointer disabled:cursor-default ${
                    isCurrent ? 'border-slate-200 bg-slate-100 opacity-70' : 'border-slate-200 bg-white hover:bg-emerald-50'
                  }`}
                >
                  <span className="w-8 h-8 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-bold shrink-0">
                    {(u.name || '?').slice(0, 2).toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-slate-800 truncate">
                      {u.name}
                      {isMe && <span className="text-slate-400 font-normal"> (yo)</span>}
                    </span>
                    <span className="block text-[11px] text-slate-400">
                      {isCurrent
                        ? 'Ya tiene este chat'
                        : u.isAgent
                          ? `${u.roleLabel || 'Call center'} · ${u.inShift ? 'En turno' : 'Fuera de turno'}`
                          : u.roleLabel || 'Supervisión'}
                    </span>
                  </span>
                  {!isCurrent && u.isAgent && (
                    <span className={`w-2 h-2 rounded-full shrink-0 ${u.inShift ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  )}
                  {sending === String(u._id) && <span className="text-xs text-emerald-700">Enviando…</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function AppointmentFromChatModal({ conv, onClose, onCreated }) {
  const { clinics, activeClinic } = useAuth();
  const today = todayEc();
  // Soporte para agendar múltiples citas en una sola operación.
  // Importante: arrancamos SIN servicios pre-seleccionados (el usuario los elige cada vez).
  const emptyAppt = () => ({
    date: today,
    startTime: '09:00',
    reason: '',
    // Servicio del catálogo propio de la agenda: { _id, name } o null.
    serviceItem: null,
  });
  const [items, setItems] = useState([emptyAppt()]);
  const [clinicId, setClinicId] = useState(activeClinic?._id || conv.clinic || '');
  const [saving, setSaving] = useState(false);
  // Espacios de la agenda de la sucursal ELEGIDA en este formulario: el asesor
  // agenda en la sede que le pida el paciente, no siempre en la suya.
  const slotMinutesDeSede =
    Number(
      (clinics || []).find((c) => String(c._id) === String(clinicId))?.appointmentSlotMinutes
        ?? (String(activeClinic?._id) === String(clinicId) ? activeClinic?.appointmentSlotMinutes : 0),
    ) || 0;

  const updateItem = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const submit = async () => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.date || !it.startTime) {
        return toast.error(`La cita #${i + 1} requiere fecha y hora`);
      }
      // El servicio ya no bloquea: se puede agendar y decidir después a qué viene.
    }
    try {
      setSaving(true);
      const r = await api.post(`/chats/${conv._id}/appointment`, {
        appointments: items.map((it) => ({
          date: it.date,
          startTime: it.startTime,
          reason: it.reason,
          clinic: clinicId || undefined,
          serviceItem: it.serviceItem?._id || null,
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
                  <DateInput value={it.date} min={today} onChange={(e) => updateItem(idx, { date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Hora</label>
                  {/* Los espacios son los de la SUCURSAL elegida arriba, no los
                      de la sede del asesor: desde el chat se agenda en cualquiera. */}
                  <TimeSlotInput value={it.startTime} slotMinutes={slotMinutesDeSede} min={it.date === today ? nowEcHHMM() : undefined} onChange={(e) => updateItem(idx, { startTime: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Motivo (opcional)</label>
                <input value={it.reason} onChange={(e) => updateItem(idx, { reason: e.target.value })} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Servicio</label>
                <ServiceItemPicker
                  value={it.serviceItem || null}
                  onChange={(item) => updateItem(idx, { serviceItem: item })}
                />
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
            <DateInput value={validUntil} min={today} onChange={(e) => setValidUntil(e.target.value)} className="w-full border border-slate-200 rounded-xl px-2 py-1.5 mt-1 bg-white" />
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
